import { Inject, Injectable } from '@nestjs/common';
import type { SkuDetail } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgConstraint, type Executor } from '../../database/sql.js';
import { catalogActor, type CatalogCaller } from '../catalog-caller.js';
import { catalogTransaction } from '../catalog-transaction.js';
import { CatalogError, CatalogService } from '../catalog.service.js';

/** The unique constraint on (`tenant_id`, `code`) of `barcodes`. */
export const BARCODES_CODE_UNIQUE = 'barcodes_code_unique';

/**
 * The `BarcodeTaken` error for a code, naming the SKU code that holds it (spec 0012, AC-10). Run
 * after the failed transaction ended, on a fresh executor; a code freed meanwhile names no SKU.
 */
export async function barcodeTaken(executor: Executor, code: string): Promise<CatalogError> {
  const { rows } = await executor.execute<{ sku: string }>(sql`
    SELECT v.sku FROM barcodes b JOIN product_variants v ON v.id = b.variant_id
    WHERE b.code = ${code}`);
  const skuCode = rows[0]?.sku;
  return new CatalogError(
    'BarcodeTaken',
    skuCode ? `Barcode ${code} already belongs to SKU ${skuCode}` : `Barcode ${code} is in use`,
    skuCode ? { skuCode } : {},
  );
}

/**
 * A SKU's barcodes (spec 0012, AC-10, AC-17): add one (scanned as one piece, unit `pc`) and
 * remove one, each recording `sku.barcode_added` or `sku.barcode_removed` in its own transaction.
 * Never touches a variant row; the search's barcode branch reads these rows as they are.
 */
@Injectable()
export class BarcodesService {
  /** Takes the app connection, the catalog (for the SKU answer), and the audit writer. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Adds `code` (already shaped by `BarcodeCode`) to the SKU. An unknown SKU is `NotFound`; a
   * code any SKU holds, this one included, is `BarcodeTaken` with that SKU's code.
   */
  async add(skuId: string, code: string, caller: CatalogCaller): Promise<SkuDetail> {
    const correlationId = this.audit.newCorrelationId();
    try {
      await catalogTransaction(this.connection.db, async (tx) => {
        const { rows } = await tx.execute<{ sku: string }>(sql`
          SELECT sku FROM product_variants WHERE id = ${skuId} FOR KEY SHARE`);
        const variant = rows[0];
        if (!variant) throw new CatalogError('NotFound', 'SKU not found');
        await tx.execute(sql`
          INSERT INTO barcodes (variant_id, uom_id, code)
          VALUES (${skuId}, (SELECT id FROM uoms WHERE code = 'pc'), ${code})`);
        await this.audit.record(tx, {
          actor: catalogActor(caller, 'catalog.edit'),
          action: 'sku.barcode_added',
          record: { type: 'sku', id: skuId, label: variant.sku },
          after: { barcode: code },
          correlationId,
        });
      });
    } catch (error) {
      if (pgConstraint(error) === BARCODES_CODE_UNIQUE) {
        throw await barcodeTaken(this.connection.db, code);
      }
      throw error;
    }
    return this.catalog.getSku(skuId);
  }

  /**
   * Removes one barcode of the SKU; a barcode of another SKU, or none, is `NotFound`. The channel
   * barcode (`from_channel`) is the channel's (spec 0012, AC-15, security review L1):
   * `FieldOwnedByChannel` with `field: 'barcode'`; the next sync would only add it back.
   */
  async remove(skuId: string, barcodeId: string, caller: CatalogCaller): Promise<void> {
    const correlationId = this.audit.newCorrelationId();
    await catalogTransaction(this.connection.db, async (tx) => {
      const { rows } = await tx.execute<{ code: string; sku: string }>(sql`
        DELETE FROM barcodes b USING product_variants v
        WHERE b.id = ${barcodeId} AND b.variant_id = ${skuId} AND v.id = b.variant_id
          AND NOT b.from_channel
        RETURNING b.code, v.sku`);
      const removed = rows[0];
      if (!removed) {
        const channel = await tx.execute(sql`
          SELECT 1 FROM barcodes
          WHERE id = ${barcodeId} AND variant_id = ${skuId} AND from_channel`);
        if (channel.rows.length) {
          throw new CatalogError('FieldOwnedByChannel', 'This barcode comes from Shopify', {
            field: 'barcode',
          });
        }
        throw new CatalogError('NotFound', 'Barcode not found');
      }
      await this.audit.record(tx, {
        actor: catalogActor(caller, 'catalog.edit'),
        action: 'sku.barcode_removed',
        record: { type: 'sku', id: skuId, label: removed.sku },
        before: { barcode: removed.code },
        correlationId,
      });
    });
  }
}
