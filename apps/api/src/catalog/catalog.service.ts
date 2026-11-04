import { Inject, Injectable } from '@nestjs/common';
import {
  CreateProductRequest,
  type LocalizedText,
  type SkuDetail,
  type SkuListQuery,
  type SkuListResponse,
  type SkuSummary,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { DATABASE } from '../database/database.module.js';
import { pgArray, pgConstraint, type Executor } from '../database/sql.js';
import { decodeKeyset, encodeKeyset } from '../platform/keyset-cursor.js';

/** `to_char` format of `updatedAt`: microseconds, UTC (spec 0006, Value sourcing). */
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export type CatalogErrorCode = 'SkuTaken' | 'NotFound';

/** A catalog rule the caller broke; the controller maps `code` to an HTTP answer. */
export class CatalogError extends Error {
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

export type StockableCheck =
  { fault: 'UNKNOWN_SKU' } | { fault: 'ARCHIVED' | 'NOT_STOCKABLE' | null; sku: StockableSku };

interface SkuRow extends Record<string, unknown> {
  id: string;
  product_id: string;
  sku: string;
  name: LocalizedText;
  price: string | null;
  archived: boolean;
  updated_at: string;
}

/** `%`, `_`, and `\` match themselves in a LIKE pattern. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toSummary(row: SkuRow): SkuSummary {
  return {
    id: row.id,
    productId: row.product_id,
    code: row.sku,
    name: { en: row.name.en, ar: row.name.ar },
    price: row.price,
    archived: row.archived,
  };
}

function toDetail(row: SkuRow): SkuDetail {
  return {
    ...toSummary(row),
    status: row.archived ? 'archived' : 'active',
    updatedAt: row.updated_at,
  };
}

const SKU_COLUMNS = sql`
  v.id, v.product_id, v.sku, p.name, v.price, v.archived_at IS NOT NULL AS archived,
  to_char(v.updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`;

/**
 * Products and their SKUs (spec 0006). Owns `products` and `product_variants`; imports nothing
 * from inventory. Stock dependent SKU actions live in inventory and call this service.
 */
@Injectable()
export class CatalogService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Creates one active product with one stocked SKU (AC-1). */
  async createProduct(input: z.output<typeof CreateProductRequest>): Promise<SkuDetail> {
    const variant = input.variants[0];
    if (!variant) throw new Error('The contract allows exactly one variant');
    try {
      return await this.connection.db.transaction(async (tx) => {
        const product = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO products (name, status)
            VALUES (${JSON.stringify(input.name)}::jsonb, 'active')
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
      if (pgConstraint(error) === 'product_variants_sku_unique') {
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
   * A page of SKUs ordered by code (`COLLATE "C"`, keyset on the code). `q` matches a code
   * starting with `q` (uppercased) or an English or Arabic name containing it (AC-13).
   */
  async list(query: SkuListQuery): Promise<SkuListResponse> {
    const filters: SQL[] = [
      query.status === 'archived' ? sql`v.archived_at IS NOT NULL` : sql`v.archived_at IS NULL`,
    ];
    if (query.q) {
      const pattern = escapeLike(query.q);
      filters.push(sql`(
        v.sku COLLATE "C" LIKE ${`${escapeLike(query.q.toUpperCase())}%`}
        OR p.name->>'en' ILIKE ${`%${pattern}%`}
        OR p.name->>'ar' ILIKE ${`%${pattern}%`})`);
    }
    if (query.cursor) {
      const [after] = decodeKeyset(query.cursor, 1);
      filters.push(sql`v.sku COLLATE "C" > ${after} COLLATE "C"`);
    }
    const { rows } = await this.connection.db.execute<SkuRow>(sql`
      SELECT ${SKU_COLUMNS}
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY v.sku COLLATE "C"
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > query.limit && last ? encodeKeyset([last.sku]) : null,
    };
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

  private async findSku(executor: Executor, id: string): Promise<SkuDetail | null> {
    const { rows } = await executor.execute<SkuRow>(sql`
      SELECT ${SKU_COLUMNS}
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ${id}`);
    const row = rows[0];
    return row ? toDetail(row) : null;
  }
}
