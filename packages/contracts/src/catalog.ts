import { z } from 'zod';
import { MoneyString } from './money.js';

/** Codes are trimmed and uppercased before the pattern check, and stored that way (spec 0006). */
export const SkuCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9._-]{1,64}$/, 'Letters, digits, dot, dash, and underscore, up to 64');

/** A price of 0 or more with at most 2 decimals. */
export const PriceString = MoneyString.refine(
  (value) => !value.startsWith('-'),
  'A price cannot be negative',
);

const NameText = z.string().trim().min(1).max(200);

/** A stored name in English and/or Arabic: at least one language. Empty strings count as absent. */
export const SkuName = z
  .object({
    en: NameText.optional().or(z.literal('').transform(() => undefined)),
    ar: NameText.optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((name) => name.en !== undefined || name.ar !== undefined, {
    message: 'Give a name in at least one language',
    path: ['en'],
  });
export type SkuName = z.infer<typeof SkuName>;

/** `POST /api/products`. One variant for now; feature 8 lifts the limit. */
export const CreateProductRequest = z
  .object({
    name: SkuName,
    variants: z
      .array(z.object({ sku: SkuCode, price: PriceString.nullable().optional() }).strict())
      .length(1),
  })
  .strict();
export type CreateProductRequest = z.input<typeof CreateProductRequest>;

export const SkuStatus = z.enum(['active', 'archived']);
export type SkuStatus = z.infer<typeof SkuStatus>;

/** A row of `GET /api/skus`. */
export const SkuSummary = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  code: z.string(),
  name: z.object({ en: z.string().optional(), ar: z.string().optional() }),
  price: MoneyString.nullable(),
  archived: z.boolean(),
});
export type SkuSummary = z.infer<typeof SkuSummary>;

/** `GET /api/skus/:id`. `updatedAt` is the microsecond UTC string the stale check compares. */
export const SkuDetail = SkuSummary.extend({
  status: SkuStatus,
  updatedAt: z.string(),
});
export type SkuDetail = z.infer<typeof SkuDetail>;

/** Query of `GET /api/skus`. The receipt line picker sends `limit=20`. */
export const SkuListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: SkuStatus.default('active'),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type SkuListQuery = z.infer<typeof SkuListQuery>;

export const SkuListResponse = z.object({
  items: z.array(SkuSummary),
  nextCursor: z.string().nullable(),
});
export type SkuListResponse = z.infer<typeof SkuListResponse>;

/** The `updatedAt` a client read, sent back with every edit for the stale check (AC-2). */
export const UpdatedAt = z.string().min(1).max(40);

/**
 * `PATCH /api/skus/:id`: name and price, any signed in person. `name`, when sent, replaces
 * both languages (a language left out of it is cleared, not kept). `price: null` clears it; an
 * absent field is left as is. A stored `updatedAt` other than the one sent answers 409
 * `STALE_RECORD` (AC-2).
 */
export const UpdateSkuRequest = z
  .object({
    updatedAt: UpdatedAt,
    name: SkuName.optional(),
    price: PriceString.nullable().optional(),
  })
  .strict();
export type UpdateSkuRequest = z.input<typeof UpdateSkuRequest>;

/** `PATCH /api/skus/:id/code` (admin). 409 `CODE_LOCKED` once the SKU has a stock balance. */
export const ChangeSkuCodeRequest = z.object({ updatedAt: UpdatedAt, sku: SkuCode }).strict();
export type ChangeSkuCodeRequest = z.input<typeof ChangeSkuCodeRequest>;

/** `GET /api/skus/:id/usage`: drives the read only code field and the archive button. */
export const SkuUsage = z.object({ codeLocked: z.boolean(), canArchive: z.boolean() });
export type SkuUsage = z.infer<typeof SkuUsage>;
