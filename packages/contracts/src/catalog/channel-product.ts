import { z } from 'zod';
import { CatalogId, PriceString } from './skus.js';

/**
 * Shopify's variant limit per product (spec 0012, channel upsert contract; confirmed on
 * shopify.dev by spec 0015). One `ChannelProductInput` carries at most this many variants.
 */
export const MAX_CHANNEL_VARIANTS = 2048;

/** A style has at most this many option axes (spec 0012, AC-10), Shopify's limit too. */
export const MAX_CHANNEL_OPTIONS = 3;

/**
 * The characters a channel text may never hold (security review M1 of spec 0012 milestone 4): the
 * C0 controls and DEL (PostgreSQL refuses U+0000 in `text` and `jsonb`, so one would abort the
 * caller's transaction on every retry) and the bidi overrides and isolates (U+202A to U+202E,
 * U+2066 to U+2069), which make stored text render differently from its bytes.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what it refuses
export const CHANNEL_UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

/** Whether a channel text is free of `CHANNEL_UNSAFE_CHARACTERS`. Pure. */
const isSafeChannelText = (text: string) => !CHANNEL_UNSAFE_CHARACTERS.test(text);

/** The message a text with an unsafe character fails with. */
const UNSAFE_MESSAGE = 'Control and bidi override characters are not allowed';

/**
 * A text a channel sends: trimmed, at most 255 characters (Shopify's string limits), no control
 * or bidi override character.
 */
const ChannelText = z.string().trim().max(255).refine(isSafeChannelText, UNSAFE_MESSAGE);

/** A SKU or barcode as the channel sends it (untrimmed, the catalog shapes it), no unsafe character. */
const ChannelCode = z.string().max(255).refine(isSafeChannelText, UNSAFE_MESSAGE);

/** An id the channel gives a product or variant (a Shopify gid), kept only in audit entries. */
const ExternalId = z.string().trim().min(1).max(255);

/**
 * One option axis of a channel product, by position: its name and its ordered values. Shopify's
 * lone `Title` / `Default Title` option is sent as no option at all (`options: []`); the
 * connector (spec 0015) does that mapping.
 */
export const ChannelProductOption = z
  .object({
    name: ChannelText.min(1),
    values: z.array(ChannelText.min(1)).max(MAX_CHANNEL_VARIANTS),
  })
  .strict();
/** The validated shape of `ChannelProductOption`, as the api sees it after parsing. */
export type ChannelProductOption = z.infer<typeof ChannelProductOption>;

/**
 * One channel variant. `variantId` is what the connector's map says (null when unmapped); `sku`
 * is Shopify's code as sent (the catalog trims and uppercases it to match); `optionValues` holds
 * one value per option of the product, by option position. `price` and `compareAtPrice` are
 * amounts of 0 or more with at most 2 decimals (a `MoneyString`); `weightGrams` is already in
 * grams (the connector converts Shopify's units).
 */
export const ChannelVariantInput = z
  .object({
    externalVariantId: ExternalId,
    variantId: CatalogId.nullable(),
    sku: ChannelCode.nullable(),
    optionValues: z.array(ChannelText.min(1)).max(MAX_CHANNEL_OPTIONS),
    price: PriceString.nullable(),
    compareAtPrice: PriceString.nullable(),
    barcode: ChannelCode.nullable(),
    weightGrams: z.number().int().min(0).max(2_147_483_647).nullable(),
    requiresShipping: z.boolean(),
    tracked: z.boolean(),
  })
  .strict();
/** The validated shape of `ChannelVariantInput`, as the api sees it after parsing. */
export type ChannelVariantInput = z.infer<typeof ChannelVariantInput>;

/**
 * One channel product, the input of `CatalogChannelSync.applyProduct` (spec 0012, AC-14, the
 * channel upsert contract). The connector (spec 0015) maps Shopify's payload to it and owns that
 * mapping and the map from Shopify ids to catalog ids; the catalog never stores
 * `externalProductId` or `externalVariantId` (they reach the audit entries only). `storeId` is the
 * store the product came from: it decides whether content applies (`catalog.source_store_id`) and
 * the group of a new style (`catalog.store_product_groups`). `handle` seeds a new style's code
 * (owner decision Q-12.1). Every variant gives one value per option, and external variant ids are
 * distinct. Tags are trimmed, empty ones dropped, duplicates dropped (first kept). No text holds
 * a `CHANNEL_UNSAFE_CHARACTERS` character.
 */
export const ChannelProductInput = z
  .object({
    storeId: CatalogId,
    externalProductId: ExternalId,
    styleId: CatalogId.nullable(),
    handle: ChannelText.min(1),
    title: z.string().trim().min(1).max(200).refine(isSafeChannelText, UNSAFE_MESSAGE),
    productType: ChannelText.nullable(),
    vendor: ChannelText.nullable(),
    tags: z
      .array(ChannelText)
      .max(250)
      .transform((tags) => [...new Set(tags.filter((tag) => tag.length > 0))]),
    options: z.array(ChannelProductOption).max(MAX_CHANNEL_OPTIONS),
    variants: z.array(ChannelVariantInput).min(1).max(MAX_CHANNEL_VARIANTS),
  })
  .strict()
  .superRefine((product, context) => {
    product.variants.forEach((variant, index) => {
      if (variant.optionValues.length !== product.options.length) {
        context.addIssue({
          code: 'custom',
          message: 'Each variant gives one value per option',
          path: ['variants', index, 'optionValues'],
        });
      }
    });
    const ids = product.variants.map((variant) => variant.externalVariantId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'External variant ids must be distinct',
        path: ['variants'],
      });
    }
  });
/** What the connector passes for `ChannelProductInput`, before transforms are applied. */
export type ChannelProductInput = z.input<typeof ChannelProductInput>;

/**
 * What happened to one channel variant (spec 0012, AC-14, AC-15):
 * - `created`: a new catalog variant was made for it;
 * - `linked`: an existing catalog variant (made by hand, by an import, or by another store) now
 *   carries this channel's data: its first link, or one another writer created in parallel; from
 *   a store other than the source store, every resolved existing variant (it writes nothing,
 *   lead ruling 2026-11-11);
 * - `updated`: a linked variant took changed channel data;
 * - `unchanged`: nothing differed, nothing was written;
 * - `needs_sku`: the channel variant has no SKU, nothing was created (owner decision Q-12.2);
 * - `invalid_sku`: its SKU fails the code pattern (a non ASCII SKU always does), or another
 *   variant of the same product already took that SKU or catalog variant in this call; nothing
 *   was created;
 * - `sku_mismatch`: the mapped variant's SKU differs from the channel's; nothing changed on it;
 * - `barcode_conflict`: the channel barcode is held by another variant, or fails the barcode
 *   pattern; the rest of the variant applied, the barcode did not;
 * - `option_conflict`: its option values would duplicate another active variant of the style, or
 *   the style cannot take another option; the rest of a linked variant applied, a new one was not
 *   created.
 */
export const ChannelVariantOutcome = z.enum([
  'created',
  'linked',
  'updated',
  'unchanged',
  'needs_sku',
  'invalid_sku',
  'sku_mismatch',
  'barcode_conflict',
  'option_conflict',
]);
/** The validated shape of `ChannelVariantOutcome`. */
export type ChannelVariantOutcome = z.infer<typeof ChannelVariantOutcome>;

/** What happened to the style of a channel product. */
export const ChannelStyleOutcome = z.enum(['created', 'updated', 'unchanged']);
/** The validated shape of `ChannelStyleOutcome`. */
export type ChannelStyleOutcome = z.infer<typeof ChannelStyleOutcome>;

/**
 * The answer of `CatalogChannelSync.applyProduct`: the style the product maps to (null only when
 * every variant was refused) and one outcome per input variant, in input order. A conflict
 * outcome still carries the variant id when one was resolved, so the connector can map it; the
 * connector decides whether to open a task (feature 17).
 */
export const ChannelProductResult = z.object({
  styleId: z.uuid().nullable(),
  styleOutcome: ChannelStyleOutcome,
  variants: z.array(
    z.object({
      externalVariantId: z.string(),
      variantId: z.uuid().nullable(),
      outcome: ChannelVariantOutcome,
    }),
  ),
});
/** The validated shape of `ChannelProductResult`. */
export type ChannelProductResult = z.infer<typeof ChannelProductResult>;

/**
 * The input of `CatalogChannelSync.unlink`: the styles and variants a channel no longer owns
 * fields of (a connection archived, a Shopify variant gone, spec 0015). Either list may be empty.
 */
export const ChannelUnlinkInput = z
  .object({
    styleIds: z.array(CatalogId).max(10_000),
    variantIds: z.array(CatalogId).max(100_000),
  })
  .strict();
/** What the connector passes for `ChannelUnlinkInput`. */
export type ChannelUnlinkInput = z.input<typeof ChannelUnlinkInput>;
