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

/**
 * A catalog record id a caller sends (a style, season, or product group): a uuid, lowercased, so
 * it compares with the ids PostgreSQL answers, a distinct check counts `a` and `A` once, and an
 * audit diff never records a case only change (review of spec 0012 milestone 2, minor 5).
 */
export const CatalogId = z.uuid().transform((id) => id.toLowerCase());

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
 * `POST /api/products`: a new style with its first variant. More variants join the style through
 * `POST /api/styles/:id/variants` (`AddVariantRequest`, spec 0012 AC-10). `styleCode` defaults to
 * the SKU code (409 `STYLE_CODE_TAKEN` when another style holds it and no SKU does, `SKU_TAKEN`
 * when a SKU does), `seasonId` to none, and `productGroupId` to the seeded `MAIN` group (spec
 * 0002, A12); an unknown season or group answers 404 `NOT_FOUND`, an archived one 422
 * `ARCHIVED`.
 */
export const CreateProductRequest = z
  .object({
    name: SkuName,
    styleCode: SkuCode.optional(),
    seasonId: CatalogId.optional(),
    productGroupId: CatalogId.optional(),
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

/**
 * A scannable code of a SKU, as `GET /api/skus/:id` and the style page list it. `fromChannel` is
 * true for the one barcode a sales channel manages on the variant (spec 0012, AC-15): the screens
 * show it read only with "From Shopify"; codes added in the app are false.
 */
export const SkuBarcode = z.object({ id: z.uuid(), code: z.string(), fromChannel: z.boolean() });
/** The validated shape of `SkuBarcode`, as the api and web see it after parsing. */
export type SkuBarcode = z.infer<typeof SkuBarcode>;

/**
 * `GET /api/skus/:id`, and the answer of every SKU write. `updatedAt` is the microsecond UTC
 * string the stale check compares; `barcodes` are the SKU's codes in code order (spec 0012, AC-4).
 * `channelLinked` is true while a sales channel owns some of the variant's fields (spec 0012,
 * AC-15): its price is then read only ("From Shopify") and `PATCH /api/skus/:id` answers 409
 * `FIELD_OWNED_BY_CHANNEL` for a new price. `channelNameLanguage` is the style's name language the
 * channel writes (`en` or `ar`, null when the style is not linked); a name edit that changes that
 * language answers the same 409.
 */
export const SkuDetail = SkuSummary.extend({
  status: SkuStatus,
  updatedAt: z.string(),
  barcodes: z.array(SkuBarcode),
  channelLinked: z.boolean(),
  channelNameLanguage: z.enum(['en', 'ar']).nullable(),
});
/** The validated shape of `SkuDetail`, as the api and web see it after parsing. */
export type SkuDetail = z.infer<typeof SkuDetail>;

/** The `updatedAt` a client read, sent back with every edit for the stale check (AC-2). */
export const UpdatedAt = z.string().min(1).max(40);

/**
 * `PATCH /api/skus/:id`: name and price (`catalog.edit`). `name`, when sent, replaces
 * both languages (a language left out of it is cleared, not kept). `price: null` clears it; an
 * absent field is left as is. A stored `updatedAt` other than the one sent answers 409
 * `STALE_RECORD` (AC-2). On a channel linked variant a different `price`, and on a channel linked
 * style a `name` that changes the channel's language, answer 409 `FIELD_OWNED_BY_CHANNEL` (spec
 * 0012, AC-15).
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
