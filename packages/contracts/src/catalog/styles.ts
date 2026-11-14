import { z } from 'zod';
import { moneyInput } from '../digit-input.js';
import { LocalizedText } from '../localized-text.js';
import { MoneyString } from '../money.js';
import { BarcodeCode } from './barcodes.js';
import { VariantCost } from './cost-records.js';
import { OptionRole } from './option-roles.js';
import { SeasonFilter } from './search.js';
import {
  CatalogId,
  CatalogRef,
  PriceString,
  SkuBarcode,
  SkuCode,
  SkuName,
  SkuOptionValue,
  SkuStatus,
  UpdatedAt,
} from './skus.js';

/**
 * Query of `GET /api/styles` (spec 0012, AC-8): ordered and paged by style code (`COLLATE "C"`,
 * keyset, 50 per page), filtered by `seasonId` (a season id, or `none`), `productGroupId`, and
 * `status`. `q` matches a style when its code starts with the uppercased q, or when any of its
 * variants matches the SKU search's code prefix or every word branch.
 */
export const StyleListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: SkuStatus.default('active'),
  seasonId: SeasonFilter.optional(),
  productGroupId: z.uuid().optional(),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
/** The validated shape of `StyleListQuery`, as the api and web see it after parsing. */
export type StyleListQuery = z.infer<typeof StyleListQuery>;

/** A row of `GET /api/styles`: code, name, season (null when none), group, active variant count. */
export const StyleSummary = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
  season: CatalogRef.nullable(),
  productGroup: CatalogRef,
  activeVariantCount: z.number().int().min(0),
  archived: z.boolean(),
});
/** The validated shape of `StyleSummary`, as the api and web see it after parsing. */
export type StyleSummary = z.infer<typeof StyleSummary>;

/** One page of `GET /api/styles`; pass `nextCursor` back as `cursor`, null at the end. */
export const StyleListResponse = z.object({
  items: z.array(StyleSummary),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `StyleListResponse`, as the api and web see it after parsing. */
export type StyleListResponse = z.infer<typeof StyleListResponse>;

/** One option axis of a style (size, color): its name, role, position, and ordered values. */
export const StyleOption = z.object({
  id: z.uuid(),
  name: LocalizedText,
  role: OptionRole,
  position: z.number().int().min(0),
  values: z.array(LocalizedText),
});
/** The validated shape of `StyleOption`, as the api and web see it after parsing. */
export type StyleOption = z.infer<typeof StyleOption>;

/**
 * One variant on the style page: code, option values, price, archived, and barcodes, plus its
 * `cost` in force on today's operating day (spec 0012, AC-12) only for a caller holding
 * `cost.view`; without the grant the key is absent (`cost` is in `COST_FIELD_KEYS`).
 */
export const StyleVariant = z.object({
  id: z.uuid(),
  code: z.string(),
  options: z.array(SkuOptionValue),
  price: MoneyString.nullable(),
  archived: z.boolean(),
  barcodes: z.array(SkuBarcode),
  /**
   * True while a sales channel owns some of this variant's fields (spec 0012, AC-15): price,
   * compare at price, weight, requires shipping, its option values, and its `fromChannel`
   * barcode, shown read only with "From Shopify".
   */
  channelLinked: z.boolean(),
  cost: VariantCost.optional(),
});
/** The validated shape of `StyleVariant`, as the api and web see it after parsing. */
export type StyleVariant = z.infer<typeof StyleVariant>;

/**
 * `GET /api/styles/:id`, and the answer of every style edit (spec 0012, AC-8): the style, its
 * options in position order, and its variants in code order (archived ones included).
 * `updatedAt` is the microsecond UTC string the stale check compares.
 */
export const StyleDetail = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
  description: LocalizedText.nullable(),
  season: CatalogRef.nullable(),
  productGroup: CatalogRef,
  tags: z.array(z.string()),
  productType: z.string().nullable(),
  brand: z.string().nullable(),
  archived: z.boolean(),
  updatedAt: z.string(),
  /**
   * True while a sales channel owns some of the style's fields (spec 0012, AC-15, field
   * ownership): the name in `channelNameLanguage`, `tags`, `productType`, `brand`, and the option
   * names and values, shown read only with "From Shopify". Code, the other name language,
   * description, season, and group stay the app's.
   */
  channelLinked: z.boolean(),
  /**
   * The name language the channel writes (`ar` when the channel title had an Arabic letter at
   * first link, else `en`), null when not linked. `PATCH /api/styles/:id` answers 409
   * `FIELD_OWNED_BY_CHANNEL` for a name that changes this language.
   */
  channelNameLanguage: z.enum(['en', 'ar']).nullable(),
  options: z.array(StyleOption),
  variants: z.array(StyleVariant),
});
/** The validated shape of `StyleDetail`, as the api and web see it after parsing. */
export type StyleDetail = z.infer<typeof StyleDetail>;

const DescriptionText = z.string().trim().max(2000);

/** A style description in English and/or Arabic; empty strings count as absent. */
export const StyleDescription = z.object({
  en: DescriptionText.optional().transform((text) => text || undefined),
  ar: DescriptionText.optional().transform((text) => text || undefined),
});

/** At most 50 tags of 1 to 64 characters each, trimmed, duplicates dropped (spec 0012, AC-9). */
export const StyleTags = z
  .array(z.string().trim().min(1).max(64))
  .max(50)
  .transform((tags) => [...new Set(tags)]);

/**
 * `PATCH /api/styles/:id` (`catalog.edit`, spec 0012 AC-9). Absent fields are left as is; `name`
 * replaces both languages; `description: null` and `seasonId: null` clear them. A stale
 * `updatedAt` answers 409 `STALE_RECORD`; an archived season or group the style does not hold
 * yet 422 `ARCHIVED`; an unknown one 404 `NOT_FOUND`. On a channel linked style, a `name` whose
 * `channelNameLanguage` text differs from the stored one answers 409 `FIELD_OWNED_BY_CHANNEL`
 * (spec 0012, AC-15).
 */
export const UpdateStyleRequest = z
  .object({
    updatedAt: UpdatedAt,
    name: SkuName.optional(),
    description: StyleDescription.nullable().optional(),
    seasonId: CatalogId.nullable().optional(),
    productGroupId: CatalogId.optional(),
    tags: StyleTags.optional(),
  })
  .strict();
/** What a caller passes for `UpdateStyleRequest`, before defaults and transforms are applied. */
export type UpdateStyleRequest = z.input<typeof UpdateStyleRequest>;

/**
 * `POST /api/styles/assign` (`catalog.edit`, spec 0012 AC-9): a season (null clears it), a
 * group, or both, for 1 to 200 distinct styles (ids lowercased, so `a` and `A` count once), all
 * or nothing. Unknown ids answer 404 `NOT_FOUND` with `missingIds`; an archived season or group
 * 422 `ARCHIVED`.
 */
export const AssignStylesRequest = z
  .object({
    styleIds: z
      .array(CatalogId)
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'Each style once'),
    seasonId: CatalogId.nullable().optional(),
    productGroupId: CatalogId.optional(),
  })
  .strict()
  .refine((body) => body.seasonId !== undefined || body.productGroupId !== undefined, {
    message: 'Give a season, a product group, or both',
    path: ['seasonId'],
  });
/** What a caller passes for `AssignStylesRequest`, before defaults and transforms are applied. */
export type AssignStylesRequest = z.input<typeof AssignStylesRequest>;

/** The answer of `POST /api/styles/assign`: how many styles changed. */
export const AssignStylesResponse = z.object({ updated: z.number().int().min(0) });
/** The validated shape of `AssignStylesResponse`, as the api and web see it after parsing. */
export type AssignStylesResponse = z.infer<typeof AssignStylesResponse>;

/**
 * `PATCH /api/styles/:id/code` (`catalog.manage`, spec 0012 AC-9): the SKU code shape, unique
 * among styles (409 `STYLE_CODE_TAKEN`), with the stale check.
 */
export const ChangeStyleCodeRequest = z.object({ updatedAt: UpdatedAt, code: SkuCode }).strict();
/** What a caller passes for `ChangeStyleCodeRequest`, before defaults and transforms are applied. */
export type ChangeStyleCodeRequest = z.input<typeof ChangeStyleCodeRequest>;

/** One option name and value pair of a new variant, each in English and/or Arabic. */
export const VariantOptionInput = z.object({ name: SkuName, value: SkuName }).strict();
/** The validated shape of `VariantOptionInput`, as the api and web see it after parsing. */
export type VariantOptionInput = z.infer<typeof VariantOptionInput>;

/**
 * `POST /api/styles/:id/variants` (`catalog.edit`, spec 0012 AC-10): a SKU code (409
 * `SKU_TAKEN`), up to 3 option name and value pairs, an optional price, and an optional barcode
 * (409 `BARCODE_TAKEN`). Names and values match the style's after `ssd_search_normalize`; a new
 * name appends an option (422 `TOO_MANY_OPTIONS` past 3), a new value is appended to its option.
 * The same option values as another active variant answer 409 `OPTION_COMBINATION_TAKEN`; an
 * archived style 422 `ARCHIVED`.
 */
export const AddVariantRequest = z
  .object({
    sku: SkuCode,
    options: z.array(VariantOptionInput).max(3).default([]),
    price: moneyInput(2).pipe(PriceString).nullable().optional(),
    barcode: BarcodeCode.optional(),
  })
  .strict();
/** What a caller passes for `AddVariantRequest`, before defaults and transforms are applied. */
export type AddVariantRequest = z.input<typeof AddVariantRequest>;
