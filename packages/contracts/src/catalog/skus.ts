import { z } from 'zod';
import { moneyInput } from '../digit-input.js';
import { LocalizedText } from '../localized-text.js';
import { MoneyString } from '../money.js';

/** A stored SKU code: upper case letters, digits, dot, dash, and underscore, up to 64. */
export const SKU_CODE_PATTERN = /^[A-Z0-9._-]{1,64}$/;

/** Codes are trimmed and uppercased before the pattern check, and stored that way (spec 0006). */
export const SkuCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SKU_CODE_PATTERN, 'Letters, digits, dot, dash, and underscore, up to 64');

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
/** The validated shape of `SkuName`, as the api and web see it after parsing. */
export type SkuName = z.infer<typeof SkuName>;

/**
 * `POST /api/products`. One variant for now; feature 8 lifts the limit. The api makes the product a
 * style whose style code is the SKU code, in the seeded `MAIN` product group (spec 0002, A12).
 */
export const CreateProductRequest = z
  .object({
    name: SkuName,
    variants: z
      .array(
        z
          .object({ sku: SkuCode, price: moneyInput(2).pipe(PriceString).nullable().optional() })
          .strict(),
      )
      .length(1),
  })
  .strict();
/** What a caller passes for `CreateProductRequest`, before defaults and transforms are applied. */
export type CreateProductRequest = z.input<typeof CreateProductRequest>;

/** SKU lifecycle as the api exposes it: active, or archived instead of deleted. */
export const SkuStatus = z.enum(['active', 'archived']);
/** The validated shape of `SkuStatus`, as the api and web see it after parsing. */
export type SkuStatus = z.infer<typeof SkuStatus>;

/** A style, season, or product group as a SKU row names it: id, code, and name in both languages. */
export const CatalogRef = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
});
/** The validated shape of `CatalogRef`, as the api and web see it after parsing. */
export type CatalogRef = z.infer<typeof CatalogRef>;

/**
 * One of a variant's option values with its option's name, both in English and Arabic (spec
 * 0012, AC-4): `{ name: { en: 'Size' }, value: { en: 'M' } }`. Ordered by option position.
 */
export const SkuOptionValue = z.object({
  name: LocalizedText,
  value: LocalizedText,
});
/** The validated shape of `SkuOptionValue`, as the api and web see it after parsing. */
export type SkuOptionValue = z.infer<typeof SkuOptionValue>;

/**
 * A row of `GET /api/skus` (spec 0012, AC-4). `name` is the style's name (kept from spec 0006);
 * `style`, `season` (null when the style has none), `productGroup`, and `options` say exactly
 * which piece the SKU is.
 */
export const SkuSummary = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  code: z.string(),
  name: z.object({ en: z.string().optional(), ar: z.string().optional() }),
  style: CatalogRef,
  season: CatalogRef.nullable(),
  productGroup: CatalogRef,
  options: z.array(SkuOptionValue),
  price: MoneyString.nullable(),
  archived: z.boolean(),
});
/** The validated shape of `SkuSummary`, as the api and web see it after parsing. */
export type SkuSummary = z.infer<typeof SkuSummary>;

/** A scannable code of a SKU, as `GET /api/skus/:id` lists it. */
export const SkuBarcode = z.object({ id: z.uuid(), code: z.string() });
/** The validated shape of `SkuBarcode`, as the api and web see it after parsing. */
export type SkuBarcode = z.infer<typeof SkuBarcode>;

/**
 * `GET /api/skus/:id`, and the answer of every SKU write. `updatedAt` is the microsecond UTC
 * string the stale check compares; `barcodes` are the SKU's codes in code order (spec 0012, AC-4).
 */
export const SkuDetail = SkuSummary.extend({
  status: SkuStatus,
  updatedAt: z.string(),
  barcodes: z.array(SkuBarcode),
});
/** The validated shape of `SkuDetail`, as the api and web see it after parsing. */
export type SkuDetail = z.infer<typeof SkuDetail>;

/** The `updatedAt` a client read, sent back with every edit for the stale check (AC-2). */
export const UpdatedAt = z.string().min(1).max(40);

/**
 * `PATCH /api/skus/:id`: name and price (`catalog.edit`). `name`, when sent, replaces
 * both languages (a language left out of it is cleared, not kept). `price: null` clears it; an
 * absent field is left as is. A stored `updatedAt` other than the one sent answers 409
 * `STALE_RECORD` (AC-2).
 */
export const UpdateSkuRequest = z
  .object({
    updatedAt: UpdatedAt,
    name: SkuName.optional(),
    price: moneyInput(2).pipe(PriceString).nullable().optional(),
  })
  .strict();
/** What a caller passes for `UpdateSkuRequest`, before defaults and transforms are applied. */
export type UpdateSkuRequest = z.input<typeof UpdateSkuRequest>;

/** `PATCH /api/skus/:id/code` (`catalog.manage`). 409 `CODE_LOCKED` once the SKU has a stock balance. */
export const ChangeSkuCodeRequest = z.object({ updatedAt: UpdatedAt, sku: SkuCode }).strict();
/** What a caller passes for `ChangeSkuCodeRequest`, before defaults and transforms are applied. */
export type ChangeSkuCodeRequest = z.input<typeof ChangeSkuCodeRequest>;

/** `GET /api/skus/:id/usage`: drives the read only code field and the archive button. */
export const SkuUsage = z.object({ codeLocked: z.boolean(), canArchive: z.boolean() });
/** The validated shape of `SkuUsage`, as the api and web see it after parsing. */
export type SkuUsage = z.infer<typeof SkuUsage>;
