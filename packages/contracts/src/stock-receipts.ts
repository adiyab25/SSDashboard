import { z } from 'zod';
import { LocalizedText } from './localized-text.js';
import { MoneyString, UnitCostString } from './money.js';

/** Highest quantity × unit cost a line may reach, the `numeric(14,2)` cap (AC-5). */
export const MAX_LINE_TOTAL = '9999999999.99';

/** Trimmed optional text; an empty string counts as absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

export const StockReceiptLineInput = z
  .object({
    skuId: z.uuid(),
    quantity: z.number().int().min(1).max(1_000_000),
    unitCost: UnitCostString,
  })
  .strict();
export type StockReceiptLineInput = z.input<typeof StockReceiptLineInput>;

/**
 * `POST /api/stock-receipts`, with an `Idempotency-Key: <uuid>` header that becomes the receipt
 * id. `receiptDate` is sent only when the person changed the date field (spec 0006).
 */
export const CreateStockReceiptRequest = z
  .object({
    locationId: z.uuid(),
    receiptDate: z.iso.date().optional(),
    reference: optionalText(64),
    note: optionalText(500),
    lines: z.array(StockReceiptLineInput).min(1).max(200),
  })
  .strict();
export type CreateStockReceiptRequest = z.input<typeof CreateStockReceiptRequest>;

/** A line fault reported with its index (0 based) in the request's `lines`. */
export const StockReceiptLineErrorCode = z.enum([
  'UNKNOWN_SKU',
  'ARCHIVED',
  'NOT_STOCKABLE',
  'DUPLICATE_SKU',
  'LINE_TOTAL_TOO_LARGE',
]);
export type StockReceiptLineErrorCode = z.infer<typeof StockReceiptLineErrorCode>;

export const StockReceiptLineError = z.object({
  index: z.number().int(),
  code: StockReceiptLineErrorCode,
});
export type StockReceiptLineError = z.infer<typeof StockReceiptLineError>;

export const StockReceiptStatus = z.enum(['posted', 'voided']);
export type StockReceiptStatus = z.infer<typeof StockReceiptStatus>;

const PersonRef = z.object({ id: z.uuid(), name: z.string() });

const LocationRef = z.object({ id: z.uuid(), code: z.string(), name: LocalizedText });

const SkuRef = z.object({ id: z.uuid(), code: z.string(), name: LocalizedText });

/** Cost fields (`unitCost`, `lineTotal`, `referenceValue`) are present for admins only (AC-11). */
export const StockReceiptLine = z.object({
  id: z.uuid(),
  position: z.number().int(),
  sku: SkuRef,
  quantity: z.number().int(),
  unitCost: UnitCostString.optional(),
  lineTotal: MoneyString.optional(),
});
export type StockReceiptLine = z.infer<typeof StockReceiptLine>;

export const StockReceiptDetail = z.object({
  id: z.uuid(),
  number: z.string(),
  status: StockReceiptStatus,
  location: LocationRef,
  effectiveAt: z.string(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  postedBy: PersonRef,
  postedAt: z.string(),
  lines: z.array(StockReceiptLine),
  totalQuantity: z.number().int(),
  referenceValue: MoneyString.optional(),
  void: z.object({ voidedAt: z.string(), voidedBy: PersonRef, reason: z.string() }).nullable(),
});
export type StockReceiptDetail = z.infer<typeof StockReceiptDetail>;
