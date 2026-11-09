import { Inject, Injectable } from '@nestjs/common';
import {
  CreateProductRequest,
  UpdateSkuRequest,
  type LocalizedText,
  type SkuDetail,
  type SkuBarcode,
  type SkuListQuery,
  type SkuListResponse,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { DATABASE } from '../database/database.module.js';
import { isStillReferenced, pgArray, pgConstraint, type Executor } from '../database/sql.js';
import { encodeKeyset } from '../platform/keyset-cursor.js';
import {
  buildSkuListSql,
  ISO_UTC,
  SKU_ROW_COLUMNS,
  SKU_ROW_FROM,
  searchWords,
  toSkuSummary,
  type SkuRow,
} from './search/sku-list-sql.js';

export { escapeLike } from './search/sku-list-sql.js';

/**
 * The catalog rules a caller can break: code already used, SKU missing, edited by someone else
 * since it was read, or still referenced and so not deletable.
 */
export type CatalogErrorCode = 'SkuTaken' | 'StyleCodeTaken' | 'NotFound' | 'Stale' | 'InUse';

/** A catalog rule the caller broke; the controller maps `code` to an HTTP answer. */
export class CatalogError extends Error {
  /** Takes the stable `code` the controller maps to an HTTP answer, and a message safe to show. */
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** What a stock document needs to know about a SKU before it posts. */
export interface StockableSku {
  id: string;
  code: string;
  name: LocalizedText;
  archived: boolean;
  kind: 'stocked' | 'service' | 'bundle';
  tracking: 'none' | 'lot' | 'serial';
  baseUomId: string;
}

/**
 * The answer to whether a SKU can take stock: unknown, or known with the fault (archived, not a
 * stocked kind) or null when it can.
 */
export type StockableCheck =
  { fault: 'UNKNOWN_SKU' } | { fault: 'ARCHIVED' | 'NOT_STOCKABLE' | null; sku: StockableSku };

/**
 * A SKU code clash: the variant code, or the style code a new product takes from it.
 */
function isSkuTaken(error: unknown): boolean {
  const constraint = pgConstraint(error);
  return (
    constraint === 'product_variants_sku_unique' || constraint === 'products_style_code_unique'
  );
}

function toDetail(row: SkuRow, barcodes: SkuBarcode[]): SkuDetail {
  return {
    ...toSkuSummary(row),
    status: row.archived ? 'archived' : 'active',
    updatedAt: row.updated_at,
    barcodes,
  };
}

/**
 * Products and their SKUs (spec 0006). Owns `products` and `product_variants`; imports nothing
 * from inventory. Stock dependent SKU actions live in inventory and call this service.
 */
@Injectable()
export class CatalogService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Creates one active product with one stocked SKU (AC-1). The product is a style whose style
   * code is the SKU code, in the seeded `MAIN` product group (spec 0002, A12).
   */
  async createProduct(input: z.output<typeof CreateProductRequest>): Promise<SkuDetail> {
    const variant = input.variants[0];
    if (!variant) throw new Error('The contract allows exactly one variant');
    try {
      return await this.connection.db.transaction(async (tx) => {
        const product = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO products (style_code, product_group_id, name, status)
            VALUES (${variant.sku}, (SELECT id FROM product_groups WHERE code = 'MAIN'),
                    ${JSON.stringify(input.name)}::jsonb, 'active')
            RETURNING id`)
        ).rows[0];
        if (!product) throw new Error('The product insert returned no row');
        const created = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO product_variants (product_id, sku, price, kind, tracking, base_uom_id)
            VALUES (${product.id}, ${variant.sku}, ${variant.price ?? null}, 'stocked', 'none',
                    (SELECT id FROM uoms WHERE code = 'pc'))
            RETURNING id`)
        ).rows[0];
        if (!created) throw new Error('The variant insert returned no row');
        const detail = await this.findSku(tx, created.id);
        if (!detail) throw new Error('The new SKU could not be read back');
        return detail;
      });
    } catch (error) {
      if (isSkuTaken(error)) {
        throw new CatalogError('SkuTaken', `SKU ${variant.sku} is already in use`);
      }
      throw error;
    }
  }

  /** One SKU, or `NotFound`. */
  async getSku(id: string): Promise<SkuDetail> {
    const detail = await this.findSku(this.connection.db, id);
    if (!detail) throw new CatalogError('NotFound', 'SKU not found');
    return detail;
  }

  /**
   * A page of SKUs ordered by code (`COLLATE "C"`, keyset on the code), filtered by status,
   * season, product group, and style. `q` matches an exact barcode, a code prefix, or every
   * normalized word in the variant's search text (spec 0012, AC-3 and AC-4; `buildSkuListSql`).
   */
  async list(query: SkuListQuery): Promise<SkuListResponse> {
    const db = this.connection.db;
    const words = query.q ? await searchWords(db, query.q) : [];
    const { rows } = await db.execute<SkuRow>(buildSkuListSql(query, words));
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toSkuSummary),
      nextCursor: rows.length > query.limit && last ? encodeKeyset([last.sku]) : null,
    };
  }

  /**
   * Edits a SKU's name (on its product) and price (AC-2). The stale check compares the variant's
   * stored `updated_at` to the microsecond string the caller read; a mismatch is `Stale`.
   */
  async updateSku(id: string, input: z.output<typeof UpdateSkuRequest>): Promise<SkuDetail> {
    return this.connection.db.transaction(async (tx) => {
      const sets: SQL[] = [sql`updated_at = now()`];
      if (input.price !== undefined) sets.push(sql`price = ${input.price}`);
      const updated = await this.touchVariant(tx, id, input.updatedAt, sets);
      if (input.name) {
        await tx.execute(sql`
          UPDATE products SET name = ${JSON.stringify(input.name)}::jsonb, updated_at = now()
          WHERE id = ${updated.productId}`);
      }
      return this.mustFind(tx, id);
    });
  }

  /**
   * Writes a new code (AC-2). Inventory calls this inside its locked transaction, after it
   * checked that no stock was ever posted for the SKU. A stale `updatedAt` is `Stale`. A product
   * whose only variant this is, and whose style code is the old SKU code (what the create path
   * sets), takes the new code as its style code in the same transaction, so the old code is free
   * to use again. A code another SKU holds is `SkuTaken`; one only another product's style code holds
   * is `StyleCodeTaken` (the variant update runs first, so each constraint names its own case).
   */
  async setCode(tx: Executor, id: string, code: string, updatedAt: string): Promise<SkuDetail> {
    try {
      const before = (
        await tx.execute<{ sku: string }>(sql`SELECT sku FROM product_variants WHERE id = ${id}`)
      ).rows[0];
      const { productId } = await this.touchVariant(tx, id, updatedAt, [
        sql`sku = ${code}`,
        sql`updated_at = now()`,
      ]);
      if (before) {
        await tx.execute(sql`
          UPDATE products SET style_code = ${code}, updated_at = now()
          WHERE id = ${productId} AND style_code = ${before.sku}
            AND (SELECT count(*) FROM product_variants WHERE product_id = ${productId}) = 1`);
      }
    } catch (error) {
      const constraint = pgConstraint(error);
      if (constraint === 'product_variants_sku_unique') {
        throw new CatalogError('SkuTaken', `SKU ${code} is already in use`);
      }
      if (constraint === 'products_style_code_unique') {
        throw new CatalogError('StyleCodeTaken', `Style code ${code} is already in use`);
      }
      throw error;
    }
    return this.mustFind(tx, id);
  }

  /**
   * Archives or unarchives a SKU and its product (AC-3). Inventory calls this inside its locked
   * transaction after the stock checks. Archiving an archived SKU keeps the first date.
   */
  async setArchived(tx: Executor, id: string, archived: boolean): Promise<SkuDetail> {
    const archivedAt = archived ? sql`coalesce(archived_at, now())` : sql`NULL`;
    const { rows } = await tx.execute<{ product_id: string }>(sql`
      UPDATE product_variants SET archived_at = ${archivedAt}, updated_at = now()
      WHERE id = ${id}
      RETURNING product_id`);
    const row = rows[0];
    if (!row) throw new CatalogError('NotFound', 'SKU not found');
    await tx.execute(sql`
      UPDATE products SET archived_at = ${archivedAt}, updated_at = now()
      WHERE id = ${row.product_id}`);
    return this.mustFind(tx, id);
  }

  /**
   * Deletes a SKU nothing references, and its product once it has no other SKU (AC-3). Any
   * reference (movements, balances, receipt lines, lots, serial numbers, barcodes) is `InUse`.
   */
  async deleteSku(id: string): Promise<void> {
    try {
      await this.connection.db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ product_id: string }>(sql`
          DELETE FROM product_variants WHERE id = ${id} RETURNING product_id`);
        const row = rows[0];
        if (!row) throw new CatalogError('NotFound', 'SKU not found');
        await tx.execute(sql`
          DELETE FROM products p WHERE p.id = ${row.product_id}
            AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)`);
      });
    } catch (error) {
      if (isStillReferenced(error)) {
        throw new CatalogError('InUse', 'This SKU is in use and cannot be deleted. Archive it.');
      }
      throw error;
    }
  }

  /** Code and name for each id that exists, archived ones included. One query. */
  async getSkus(
    ids: readonly string[],
    executor: Executor = this.connection.db,
  ): Promise<Map<string, StockableSku>> {
    if (!ids.length) return new Map();
    const { rows } = await executor.execute<{
      id: string;
      sku: string;
      name: LocalizedText;
      archived: boolean;
      kind: StockableSku['kind'];
      tracking: StockableSku['tracking'];
      base_uom_id: string;
    }>(sql`
      SELECT v.id, v.sku, p.name, v.archived_at IS NOT NULL AS archived, v.kind, v.tracking,
             v.base_uom_id
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY(${pgArray([...new Set(ids)])}::uuid[])`);
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          code: row.sku,
          name: { en: row.name.en, ar: row.name.ar },
          archived: row.archived,
          kind: row.kind,
          tracking: row.tracking,
          baseUomId: row.base_uom_id,
        },
      ]),
    );
  }

  /**
   * Whether each SKU may be posted by a plain stock document: it exists, is not archived, is
   * `stocked`, and has tracking `none` (lot and serial receipts come with features 18 and 19).
   */
  async checkStockable(
    ids: readonly string[],
    executor: Executor = this.connection.db,
  ): Promise<Map<string, StockableCheck>> {
    const skus = await this.getSkus(ids, executor);
    return new Map(
      ids.map((id): [string, StockableCheck] => {
        const sku = skus.get(id);
        if (!sku) return [id, { fault: 'UNKNOWN_SKU' }];
        if (sku.archived) return [id, { fault: 'ARCHIVED', sku }];
        if (sku.kind !== 'stocked' || sku.tracking !== 'none') {
          return [id, { fault: 'NOT_STOCKABLE', sku }];
        }
        return [id, { fault: null, sku }];
      }),
    );
  }

  /**
   * `UPDATE product_variants SET ...` guarded by the stale check (spec 0006, Value sourcing):
   * 0 rows and the row exists is `Stale`, 0 rows and no row is `NotFound`.
   */
  private async touchVariant(
    tx: Executor,
    id: string,
    updatedAt: string,
    sets: SQL[],
  ): Promise<{ productId: string }> {
    const { rows } = await tx.execute<{ product_id: string }>(sql`
      UPDATE product_variants SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id} AND to_char(updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) = ${updatedAt}
      RETURNING product_id`);
    const row = rows[0];
    if (row) return { productId: row.product_id };
    const exists = await tx.execute(sql`SELECT 1 FROM product_variants WHERE id = ${id}`);
    if (exists.rows.length) {
      throw new CatalogError('Stale', 'Someone else changed this SKU. Reload and try again.');
    }
    throw new CatalogError('NotFound', 'SKU not found');
  }

  private async mustFind(executor: Executor, id: string): Promise<SkuDetail> {
    const detail = await this.findSku(executor, id);
    if (!detail) throw new CatalogError('NotFound', 'SKU not found');
    return detail;
  }

  private async findSku(executor: Executor, id: string): Promise<SkuDetail | null> {
    const { rows } = await executor.execute<SkuRow>(sql`
      SELECT ${SKU_ROW_COLUMNS}
      FROM ${SKU_ROW_FROM}
      WHERE v.id = ${id}`);
    const row = rows[0];
    if (!row) return null;
    const barcodes = await executor.execute<SkuBarcode>(sql`
      SELECT id, code FROM barcodes WHERE variant_id = ${id} ORDER BY code COLLATE "C"`);
    return toDetail(row, barcodes.rows);
  }
}
