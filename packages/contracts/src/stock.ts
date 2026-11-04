import { z } from 'zod';
import { LocalizedText } from './localized-text.js';
import { LedgerSourceType } from './inventory.js';
import { MoneyString, UnitCostString } from './money.js';

/** A query string boolean: only `true` and `false` are accepted. */
const QueryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .or(z.boolean());

/** Query of `GET /api/stock`. No `locationId` means all locations. */
export const StockListQuery = z.object({
  locationId: z.uuid().optional(),
  skuId: z.uuid().optional(),
  includeZero: QueryBoolean.default(false),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type StockListQuery = z.infer<typeof StockListQuery>;

const SkuRef = z.object({ id: z.uuid(), code: z.string(), name: LocalizedText });
const LocationRef = z.object({ id: z.uuid(), code: z.string(), name: LocalizedText });

/** One SKU at one location. `avgUnitCost` and `totalValue` are present for admins only (AC-11). */
export const StockRow = z.object({
  sku: SkuRef,
  location: LocationRef,
  onHand: z.number().int(),
  negative: z.boolean(),
  avgUnitCost: UnitCostString.nullable().optional(),
  totalValue: MoneyString.optional(),
  lastMovedAt: z.string(),
});
export type StockRow = z.infer<typeof StockRow>;

export const StockListResponse = z.object({
  items: z.array(StockRow),
  nextCursor: z.string().nullable(),
});
export type StockListResponse = z.infer<typeof StockListResponse>;

/** `GET /api/skus/:id/stock`: non zero on hand per location and the totals. */
export const SkuStockResponse = z.object({
  locations: z.array(
    z.object({
      location: LocationRef,
      onHand: z.number().int(),
      avgUnitCost: UnitCostString.nullable().optional(),
      totalValue: MoneyString.optional(),
    }),
  ),
  totalOnHand: z.number().int(),
  totalValue: MoneyString.optional(),
});
export type SkuStockResponse = z.infer<typeof SkuStockResponse>;

/** Query of `GET /api/skus/:id/movements`: newest first, `cursor` is the last `nextCursor`. */
export const SkuMovementsQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type SkuMovementsQuery = z.infer<typeof SkuMovementsQuery>;

/**
 * One movement of a SKU's history (AC-10). `source` links a stock receipt (`number` is its
 * `SR-…` number); other source types carry `null`. `isReversal` marks a void's row. `postedBy`
 * is null for a system job. `unitCost` and `totalCost` are present for admins only (AC-11).
 */
export const SkuMovement = z.object({
  id: z.uuid(),
  effectiveAt: z.string(),
  recordedAt: z.string(),
  location: LocationRef,
  quantity: z.number().int(),
  sourceType: LedgerSourceType,
  isReversal: z.boolean(),
  source: z.object({ id: z.uuid(), number: z.string() }).nullable(),
  postedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  unitCost: UnitCostString.optional(),
  totalCost: MoneyString.optional(),
});
export type SkuMovement = z.infer<typeof SkuMovement>;

export const SkuMovementsResponse = z.object({
  items: z.array(SkuMovement),
  nextCursor: z.string().nullable(),
});
export type SkuMovementsResponse = z.infer<typeof SkuMovementsResponse>;
