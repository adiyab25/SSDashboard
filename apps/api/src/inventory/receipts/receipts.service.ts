import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CreateStockReceiptRequest,
  Money,
  mulDivRound,
  UnitCost,
  type LocalizedText,
  type StaffRole,
  type StockReceiptDetail,
  type StockReceiptLineError,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import type { z } from 'zod';
import { CatalogService } from '../../catalog/catalog.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { NumberingService } from '../../platform/numbering.service.js';
import { SettingsService } from '../../platform/settings.service.js';
import { StaffDirectory } from '../../staff/staff-directory.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { receiptLineId } from './line-id.js';

type CreateInput = z.output<typeof CreateStockReceiptRequest>;

/** `quantity × unitCost` may not pass this, in cents (AC-5). */
const MAX_LINE_TOTAL_CENTS = 999_999_999_999n;

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export type ReceiptErrorCode =
  'NotFound' | 'IdempotencyConflict' | 'InvalidLines' | 'InvalidLocation' | 'FutureDate';

/** A receipt rule the caller broke; the controller maps `code` to an HTTP answer. */
export class ReceiptError extends Error {
  constructor(
    readonly code: ReceiptErrorCode,
    message: string,
    readonly lineErrors: StockReceiptLineError[] = [],
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}

/** Who is asking: the posting user, and whether cost fields are theirs to see (AC-11). */
export interface ReceiptCaller {
  id: string;
  role: StaffRole;
}

/** A stored receipt with every field, before the role serializer. */
interface StoredReceipt {
  id: string;
  requestHash: string;
  detail: StockReceiptDetail;
}

/**
 * SHA-256 of the canonical request (spec 0006, Value sourcing): fields in a fixed order, absent
 * ones as null, lines in input order with `unitCost` at 4 decimals.
 */
export function receiptRequestHash(input: CreateInput): string {
  const canonical = JSON.stringify([
    input.locationId,
    input.receiptDate ?? null,
    input.reference ?? null,
    input.note ?? null,
    input.lines.map((line) => [line.skuId, line.quantity, UnitCost.of(line.unitCost).toString()]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Removes the cost fields for anyone but an admin (AC-11). One serializer for every answer. */
export function serializeReceipt(detail: StockReceiptDetail, role: StaffRole): StockReceiptDetail {
  if (role === 'admin') return detail;
  const { referenceValue: _value, ...rest } = detail;
  return {
    ...rest,
    lines: detail.lines.map(({ unitCost: _cost, lineTotal: _total, ...line }) => line),
  };
}

/**
 * Stock receipts (spec 0006): a numbered document posted through the ledger in one transaction.
 * This service writes only `stock_receipts` and `stock_receipt_lines`, only inside the ledger's
 * `within` callback, and moves stock only through `LedgerService`.
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger('StockReceipts');

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /**
   * Posts a receipt whose id is the caller's idempotency key (AC-5, AC-6). Returns the stored
   * receipt and whether this call created it.
   */
  async post(
    id: string,
    input: CreateInput,
    caller: ReceiptCaller,
  ): Promise<{ receipt: StockReceiptDetail; created: boolean }> {
    const hash = receiptRequestHash(input);

    // Step 1: a receipt with this id already exists.
    const existing = await this.find(this.connection.db, id);
    if (existing) return { receipt: this.replayOf(existing, hash, caller), created: false };

    await this.checkLocation(input.locationId);
    const skus = await this.checkLines(input);
    const effectiveAt = await this.effectiveAt(input.receiptDate);

    const lines = input.lines.map((line, index) => {
      const position = index + 1;
      const unitCost = UnitCost.of(line.unitCost);
      return {
        id: receiptLineId(id, position),
        position,
        variantId: line.skuId,
        uomId: skus.get(line.skuId) ?? '',
        quantity: line.quantity,
        unitCost: unitCost.toString(),
        lineTotal: unitCost.times(line.quantity).toString(),
      };
    });

    const outcome = await this.ledger.post(
      {
        idempotencyKey: `stock_receipt:${id}`,
        sourceType: 'stock_receipt',
        sourceId: id,
        effectiveAt,
        postedBy: caller.id,
        lines: lines.map((line) => ({
          variantId: line.variantId,
          locationId: input.locationId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          sourceLineId: line.id,
        })),
      },
      {
        // Everything in here reruns on the ledger's deadlock retry, so it keeps no state.
        within: async (tx, result) => {
          // The number is issued after all stock work: its counter row stays locked until
          // commit, and only the receipt's own two inserts follow it.
          const number = await this.numbering.next(
            tx,
            'stock_receipt',
            new Date(result.effectiveAt),
          );
          await tx.execute(sql`
            INSERT INTO stock_receipts (id, request_hash, number, location_id, effective_at,
                                        reference, note, movement_group_id, posted_by)
            VALUES (${id}, ${hash}, ${number}, ${input.locationId},
                    ${result.effectiveAt}::timestamptz, ${input.reference ?? null},
                    ${input.note ?? null}, ${result.groupId}, ${caller.id})`);
          await tx.execute(sql`
            INSERT INTO stock_receipt_lines (id, receipt_id, position, variant_id, uom_id,
                                             quantity, unit_cost, line_total)
            SELECT l.id, ${id}, l.position, l.variant_id, l.uom_id, l.quantity, l.unit_cost,
                   l.line_total
            FROM unnest(
              ${pgArray(lines.map((l) => l.id))}::uuid[],
              ${pgArray(lines.map((l) => l.position))}::int[],
              ${pgArray(lines.map((l) => l.variantId))}::uuid[],
              ${pgArray(lines.map((l) => l.uomId))}::uuid[],
              ${pgArray(lines.map((l) => l.quantity))}::int[],
              ${pgArray(lines.map((l) => l.unitCost))}::numeric[],
              ${pgArray(lines.map((l) => l.lineTotal))}::numeric[]
            ) AS l(id, position, variant_id, uom_id, quantity, unit_cost, line_total)`);
        },
      },
    );

    const stored = await this.find(this.connection.db, id);
    if (!stored) throw new Error(`Receipt ${id} was posted but cannot be read back`);
    // Step 2: a concurrent first request with this key won the race.
    if (outcome.replayed) return { receipt: this.replayOf(stored, hash, caller), created: false };

    this.logger.log({
      event: 'stock_receipt.posted',
      receiptId: id,
      number: stored.detail.number,
      locationId: input.locationId,
      lineCount: lines.length,
      userId: caller.id,
    });
    return { receipt: serializeReceipt(stored.detail, caller.role), created: true };
  }

  /** One receipt through the caller's serializer, or `NotFound`. */
  async get(id: string, caller: ReceiptCaller): Promise<StockReceiptDetail> {
    const stored = await this.find(this.connection.db, id);
    if (!stored) throw new ReceiptError('NotFound', 'Stock receipt not found');
    return serializeReceipt(stored.detail, caller.role);
  }

  private replayOf(stored: StoredReceipt, hash: string, caller: ReceiptCaller) {
    if (stored.requestHash !== hash) {
      throw new ReceiptError(
        'IdempotencyConflict',
        'This idempotency key was already used for a different receipt',
      );
    }
    return serializeReceipt(stored.detail, caller.role);
  }

  /** One active warehouse or showroom; the ledger alone would accept transit and scrap. */
  private async checkLocation(locationId: string): Promise<void> {
    const { rows } = await this.connection.db.execute<{ ok: boolean }>(sql`
      SELECT type IN ('warehouse', 'showroom') AND archived_at IS NULL AS ok
      FROM locations WHERE id = ${locationId}`);
    if (!rows[0]?.ok) {
      throw new ReceiptError('InvalidLocation', 'Choose an active warehouse or showroom');
    }
  }

  /** Every line fault at once, with indexes (AC-7). Returns each SKU's base unit. */
  private async checkLines(input: CreateInput): Promise<Map<string, string>> {
    const checks = await this.catalog.checkStockable(input.lines.map((line) => line.skuId));
    const faults: StockReceiptLineError[] = [];
    const seen = new Set<string>();
    const units = new Map<string, string>();
    input.lines.forEach((line, index) => {
      const check = checks.get(line.skuId);
      if (!check || check.fault === 'UNKNOWN_SKU') {
        faults.push({ index, code: 'UNKNOWN_SKU' });
      } else if (check.fault) {
        faults.push({ index, code: check.fault });
      } else {
        units.set(line.skuId, check.sku.baseUomId);
      }
      if (seen.has(line.skuId)) faults.push({ index, code: 'DUPLICATE_SKU' });
      seen.add(line.skuId);
      const cents = mulDivRound(UnitCost.of(line.unitCost).scaled, BigInt(line.quantity), 100n);
      if (cents > MAX_LINE_TOTAL_CENTS) faults.push({ index, code: 'LINE_TOTAL_TOO_LARGE' });
    });
    if (faults.length) {
      throw new ReceiptError('InvalidLines', 'Some lines cannot be received', faults);
    }
    return units;
  }

  /**
   * The posting date (spec 0006, Value sourcing): absent or today in the install time zone
   * leaves the ledger's default (now); an earlier day is 12:00 that day in that zone, computed
   * in SQL so daylight saving is right; a later day is `FutureDate`.
   */
  private async effectiveAt(receiptDate: string | undefined): Promise<Date | undefined> {
    if (!receiptDate) return undefined;
    const { timezone } = await this.settings.read(['timezone']);
    const { rows } = await this.connection.db.execute<{
      day: 'past' | 'today' | 'future';
      at: string;
    }>(sql`
      SELECT CASE WHEN d > today THEN 'future' WHEN d = today THEN 'today' ELSE 'past' END AS day,
             to_char(((d + time '12:00') AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC', ${ISO_UTC}) AS at
      FROM (SELECT ${receiptDate}::date AS d, (now() AT TIME ZONE ${timezone})::date AS today) s`);
    const row = rows[0];
    if (!row) throw new Error('The date query returned no row');
    if (row.day === 'future') {
      throw new ReceiptError('FutureDate', 'A receipt cannot be dated in the future');
    }
    return row.day === 'today' ? undefined : new Date(row.at);
  }

  /** The stored receipt with every field, or null. */
  private async find(executor: Executor, id: string): Promise<StoredReceipt | null> {
    const receipt = (
      await executor.execute<{
        id: string;
        request_hash: string;
        number: string;
        status: 'posted' | 'voided';
        location_id: string;
        location_code: string;
        location_name: LocalizedText;
        effective_at: string;
        created_at: string;
        reference: string | null;
        note: string | null;
        posted_by: string;
        voided_at: string | null;
        voided_by: string | null;
        void_reason: string | null;
      }>(sql`
        SELECT r.id, r.request_hash, r.number, r.status, r.location_id,
               l.code AS location_code, l.name AS location_name,
               to_char(r.effective_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS effective_at,
               to_char(r.created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS created_at,
               r.reference, r.note, r.posted_by,
               to_char(r.voided_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS voided_at,
               r.voided_by, r.void_reason
        FROM stock_receipts r JOIN locations l ON l.id = r.location_id
        WHERE r.id = ${id}`)
    ).rows[0];
    if (!receipt) return null;
    const lines = await executor.execute<{
      id: string;
      position: number;
      variant_id: string;
      quantity: number;
      unit_cost: string;
      line_total: string;
    }>(sql`
      SELECT id, position, variant_id, quantity, unit_cost, line_total
      FROM stock_receipt_lines WHERE receipt_id = ${id} ORDER BY position`);
    const skus = await this.catalog.getSkus(lines.rows.map((line) => line.variant_id));
    const people = [receipt.posted_by, ...(receipt.voided_by ? [receipt.voided_by] : [])];
    const names = await this.staff.namesByIds(people);
    const person = (userId: string) => ({ id: userId, name: names.get(userId) ?? '' });

    const referenceValue = lines.rows.reduce(
      (sum, line) => sum.plus(Money.of(line.line_total)),
      Money.zero,
    );
    return {
      id: receipt.id,
      requestHash: receipt.request_hash,
      detail: {
        id: receipt.id,
        number: receipt.number,
        status: receipt.status,
        location: {
          id: receipt.location_id,
          code: receipt.location_code,
          name: { en: receipt.location_name.en, ar: receipt.location_name.ar },
        },
        effectiveAt: receipt.effective_at,
        reference: receipt.reference,
        note: receipt.note,
        postedBy: person(receipt.posted_by),
        postedAt: receipt.created_at,
        lines: lines.rows.map((line) => {
          const sku = skus.get(line.variant_id);
          return {
            id: line.id,
            position: line.position,
            sku: { id: line.variant_id, code: sku?.code ?? '', name: sku?.name ?? {} },
            quantity: line.quantity,
            unitCost: line.unit_cost,
            lineTotal: line.line_total,
          };
        }),
        totalQuantity: lines.rows.reduce((sum, line) => sum + line.quantity, 0),
        referenceValue: referenceValue.toString(),
        void:
          receipt.voided_at && receipt.voided_by && receipt.void_reason
            ? {
                voidedAt: receipt.voided_at,
                voidedBy: person(receipt.voided_by),
                reason: receipt.void_reason,
              }
            : null,
      },
    };
  }
}
