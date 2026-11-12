// The Shopify product mapper of spec 0015 task 8 (AC-16, Inbound processing item 6; spec 0012's
// Follow-up for spec 0015: weight units to grams, the Default Title option to none, gift cards
// skipped). Pure: no database, clock, log, or Shopify call. The inbox job reads the product back
// (`PRODUCT_READ`, paged by `PRODUCT_VARIANTS_PAGE`) or the backfill assembles it from its bulk
// result (`assembleBulkProduct`), then this mapper turns it into the catalog's
// `ChannelProductInput`, which `CatalogChannelSync.applyProduct` takes.
import {
  MAX_CHANNEL_OPTIONS,
  MAX_CHANNEL_VARIANTS,
  type ChannelProductInput,
} from '@ssdashboard/contracts';
import { z, type ZodType } from 'zod';
import type { BulkObject } from './bulk-jsonl.js';
import { cleanText } from './order-mapper.js';
import { StorableShopifyId } from './storable-text.js';

/**
 * Why a product read could not be mapped (codes only, never a value of the product):
 * - `PRODUCT_UNREADABLE`: the answer is not the shape `PRODUCT_READ` selects, or a text the
 *   catalog needs (handle, title, an option name or value) is empty once cleaned;
 * - `VARIANTS_TRUNCATED`: more than `MAX_CHANNEL_VARIANTS` variants (Shopify's own limit), or a
 *   page that promised more and gave no cursor;
 * - `OPTIONS_UNREADABLE`: more than `MAX_CHANNEL_OPTIONS` options, or a variant without a value
 *   for one of them;
 * - `PRICE_UNREADABLE`: a price or compare at price that is not an amount with at most 2 decimals.
 */
export type ShopifyProductMappingErrorCode =
  'PRODUCT_UNREADABLE' | 'VARIANTS_TRUNCATED' | 'OPTIONS_UNREADABLE' | 'PRICE_UNREADABLE';

/**
 * A Shopify product the mapper refuses. The inbox job fails the event with `code` and publishes
 * `InboundEventFailed`. Carries field paths only (keys and indices), never a value.
 */
export class ShopifyProductMappingError extends Error {
  /** Builds the error from its code and the failing field paths. */
  constructor(
    readonly code: ShopifyProductMappingErrorCode,
    readonly paths: readonly string[] = [],
  ) {
    super(paths.length > 0 ? `${code} (${paths.join(', ')})` : code);
    this.name = 'ShopifyProductMappingError';
  }
}

/** An ISO instant with an offset, as Shopify serializes `DateTime`. */
const Instant = z.iso.datetime({ offset: true });

/** `Weight` (`unit: WeightUnit!`, `value: Float!`); the unit stays a string so a new one is caught. */
const ShopifyWeight = z.object({ unit: z.string(), value: z.number() });

/** One variant, field for field what `PRODUCT_READ` selects. Unknown keys are stripped. */
const ShopifyProductVariant = z.object({
  id: StorableShopifyId,
  sku: z.string().nullable(),
  price: z.string(),
  compareAtPrice: z.string().nullable(),
  barcode: z.string().nullable(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  inventoryItem: z.object({
    id: StorableShopifyId,
    tracked: z.boolean(),
    requiresShipping: z.boolean(),
    measurement: z.object({ weight: ShopifyWeight.nullable() }),
  }),
});
/** One Shopify variant as the mapper reads it. */
export type ShopifyProductVariant = z.infer<typeof ShopifyProductVariant>;

/** A connection page's info. */
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

/** The product fields of `PRODUCT_READ`, variants apart. */
const ShopifyProductCore = z.object({
  id: StorableShopifyId,
  handle: z.string(),
  title: z.string(),
  productType: z.string(),
  vendor: z.string(),
  tags: z.array(z.string()),
  status: z.string(),
  isGiftCard: z.boolean(),
  updatedAt: Instant,
  options: z.array(
    z.object({ name: z.string(), position: z.number().int(), values: z.array(z.string()) }),
  ),
});

/** The variants connection of a page. */
const VariantsPage = z.object({ nodes: z.array(ShopifyProductVariant), pageInfo: PageInfo });

/** One Shopify product with every variant read (all pages joined). */
export type ShopifyProduct = z.infer<typeof ShopifyProductCore> & {
  readonly variants: readonly ShopifyProductVariant[];
};

/** The first page of a product read: the product, its first variants, and the page info. */
export interface ShopifyProductPage {
  /** The product, with the variants of this page only. */
  readonly product: ShopifyProduct;
  /** The cursor of the next variants page, or null when this page was the last. */
  readonly nextCursor: string | null;
}

/** The failing paths of a zod error, keys and indices only (an issue message may echo input). */
function pathsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))];
}

/** Parses with a schema, turning a refusal into `PRODUCT_UNREADABLE` without values. */
function parseOr<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ShopifyProductMappingError('PRODUCT_UNREADABLE', pathsOf(parsed.error));
  }
  return parsed.data;
}

/** The next cursor of a page, refusing a page that promises more without a cursor. */
function nextCursorOf(pageInfo: z.infer<typeof PageInfo>): string | null {
  if (!pageInfo.hasNextPage) return null;
  if (pageInfo.endCursor === null || pageInfo.endCursor === '') {
    throw new ShopifyProductMappingError('VARIANTS_TRUNCATED', ['variants.pageInfo']);
  }
  return pageInfo.endCursor;
}

/**
 * Reads the answer of `PRODUCT_READ` (`{ product }`): the product with its first variants and the
 * next page's cursor, or null when Shopify answers no product (deleted, or never visible). Throws
 * `ShopifyProductMappingError` `PRODUCT_UNREADABLE` for any other shape.
 */
export function parseShopifyProductPage(data: unknown): ShopifyProductPage | null {
  const answer = parseOr(
    z.object({ product: ShopifyProductCore.extend({ variants: VariantsPage }).nullable() }),
    data,
  );
  if (answer.product === null) return null;
  const { variants, ...core } = answer.product;
  return {
    product: { ...core, variants: variants.nodes },
    nextCursor: nextCursorOf(variants.pageInfo),
  };
}

/**
 * Reads the answer of `PRODUCT_VARIANTS_PAGE` for the product `productGid`: the page's variants
 * and the next cursor, or null when the product is gone meanwhile. Throws `PRODUCT_UNREADABLE`
 * for another shape or another product's page.
 */
export function parseShopifyVariantsPage(
  data: unknown,
  productGid: string,
): {
  readonly variants: readonly ShopifyProductVariant[];
  readonly nextCursor: string | null;
} | null {
  const answer = parseOr(
    z.object({ product: z.object({ id: z.string(), variants: VariantsPage }).nullable() }),
    data,
  );
  if (answer.product === null) return null;
  if (answer.product.id !== productGid) {
    throw new ShopifyProductMappingError('PRODUCT_UNREADABLE', ['product.id']);
  }
  return {
    variants: answer.product.variants.nodes,
    nextCursor: nextCursorOf(answer.product.variants.pageInfo),
  };
}

/**
 * Reads the answer of `PRODUCT_OF_VARIANT_READ`: the variant's product gid, or null when Shopify
 * no longer has the variant. Throws `PRODUCT_UNREADABLE` for another shape.
 */
export function parseProductOfVariant(data: unknown): string | null {
  const answer = parseOr(
    z.object({
      productVariant: z
        .object({ id: z.string(), product: z.object({ id: StorableShopifyId }) })
        .nullable(),
    }),
    data,
  );
  return answer.productVariant?.product.id ?? null;
}

/** The gid prefix of a Shopify variant, a bulk product's only child type. */
const VARIANT_GID = 'gid://shopify/ProductVariant/';

/**
 * One product of the products backfill's bulk result (`PRODUCTS_BULK_QUERY`) in the shape the
 * read back gives, so the one mapper reads it unchanged (AC-7): the variant children become the
 * product's variants (a bulk result holds every node, so nothing is paged). A child that is not a
 * variant, or a root that does not parse, throws `PRODUCT_UNREADABLE`.
 */
export function assembleBulkProduct(object: BulkObject): ShopifyProduct {
  for (const child of object.children) {
    const id = child['id'];
    if (typeof id !== 'string' || !id.startsWith(VARIANT_GID)) {
      throw new ShopifyProductMappingError('PRODUCT_UNREADABLE', ['variants']);
    }
  }
  const page = parseShopifyProductPage({
    product: {
      ...object.root,
      variants: { nodes: object.children, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  });
  if (page === null) throw new ShopifyProductMappingError('PRODUCT_UNREADABLE', ['product']);
  return page.product;
}

/** Grams per unit of `WeightUnit` (`2026-10`: `GRAMS`, `KILOGRAMS`, `OUNCES`, `POUNDS`). */
const GRAMS_PER_UNIT: Readonly<Record<string, number>> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

/** The largest weight in grams the catalog takes (`int`). */
const MAX_GRAMS = 2_147_483_647;

/**
 * A Shopify weight in whole grams (spec 0012 Follow-up: the connector converts the units), or
 * null when Shopify has none, the unit is one this release does not know, or the value is not a
 * finite amount of 0 or more. Never guesses a unit.
 */
export function weightInGrams(weight: { unit: string; value: number } | null): number | null {
  if (weight === null) return null;
  const factor = GRAMS_PER_UNIT[weight.unit];
  if (factor === undefined || !Number.isFinite(weight.value) || weight.value < 0) return null;
  return Math.min(Math.round(weight.value * factor), MAX_GRAMS);
}

/** A Shopify `Money` amount: digits, an optional decimal part. */
const MONEY = /^(\d{1,12})(?:\.(\d+))?$/;

/**
 * A Shopify `Money` amount as the catalog's price text (at most 2 decimals; extra trailing zeros
 * dropped: `"450.0"` is `"450.0"`, `"450.500"` is `"450.5"`), or null for null. Throws
 * `PRICE_UNREADABLE` for anything else, never rounding money.
 */
export function priceOf(amount: string | null, path: string): string | null {
  if (amount === null) return null;
  const match = MONEY.exec(amount.trim());
  if (!match) throw new ShopifyProductMappingError('PRICE_UNREADABLE', [path]);
  const [, whole, fraction = ''] = match;
  const kept = fraction.length > 2 ? fraction.replace(/0+$/, '') : fraction;
  if (kept.length > 2) throw new ShopifyProductMappingError('PRICE_UNREADABLE', [path]);
  return kept.length > 0 ? `${whole}.${kept}` : `${whole}`;
}

/**
 * Whether the product has only Shopify's lone default option (one option `Title` whose only
 * value is `Default Title`), which the catalog takes as no option at all (spec 0012).
 */
export function hasOnlyDefaultOption(product: Pick<ShopifyProduct, 'options'>): boolean {
  const [only, ...rest] = product.options;
  return (
    only !== undefined &&
    rest.length === 0 &&
    only.name === 'Title' &&
    only.values.length === 1 &&
    only.values[0] === 'Default Title'
  );
}

/** The longest channel text the catalog takes (Shopify's string limit). */
const TEXT_MAX = 255;

/** The most tags the catalog takes per product. */
const MAX_TAGS = 250;

/** The longest style title the catalog takes. */
const TITLE_MAX = 200;

/** The longest product label an inbox event keeps (`subject_label`). */
const LABEL_MAX = 64;

/** A text the catalog must get, cleaned; throws `PRODUCT_UNREADABLE` naming the path when empty. */
function requiredText(value: string, max: number, path: string): string {
  const text = cleanText(value, max);
  if (text === null) throw new ShopifyProductMappingError('PRODUCT_UNREADABLE', [path]);
  return text;
}

/**
 * A SKU or barcode as the channel sends it: control and direction characters stripped (the
 * catalog refuses them), null when nothing is left. The catalog trims and uppercases the rest.
 */
function codeOf(value: string | null): string | null {
  return cleanText(value, TEXT_MAX);
}

/**
 * The product's `subject_label` for its inbox event: its handle cleaned and cut to 64 characters
 * (a handle is a public URL part, never personal), or null.
 */
export function productLabelOf(product: Pick<ShopifyProduct, 'handle'>): string | null {
  return cleanText(product.handle, LABEL_MAX);
}

/** What the mapper needs besides the product: the store and the connector's own map. */
export interface ShopifyProductContext {
  /** The connection's store (`ChannelProductInput.storeId`). */
  readonly storeId: string;
  /** The style the product maps to (`connection_external_ids`, entity `product`), or null. */
  readonly styleId: string | null;
  /** Shopify variant gid to the app variant id (entity `variant`); absent is unmapped. */
  readonly variantIds: ReadonlyMap<string, string>;
}

/**
 * Maps one Shopify product to `ChannelProductInput` (Inbound processing item 6): the store, the
 * product gid, the mapped style, the handle, title (cut to 200), product type and vendor (null
 * when empty), tags, the options by position (none for Shopify's lone default option), and per
 * variant its gid, mapped variant, SKU, option values in option order, price and compare at
 * price, barcode, weight in grams, requires shipping, and tracked. Every text is cleaned of
 * control and direction characters (the catalog refuses them). Throws
 * `ShopifyProductMappingError`; never maps a gift card (the caller skips it first).
 */
export function mapShopifyProduct(
  product: ShopifyProduct,
  context: ShopifyProductContext,
): ChannelProductInput {
  if (product.variants.length === 0 || product.variants.length > MAX_CHANNEL_VARIANTS) {
    throw new ShopifyProductMappingError('VARIANTS_TRUNCATED', ['variants']);
  }
  const lone = hasOnlyDefaultOption(product);
  const ordered = [...product.options].sort((a, b) => a.position - b.position);
  if (!lone && ordered.length > MAX_CHANNEL_OPTIONS) {
    throw new ShopifyProductMappingError('OPTIONS_UNREADABLE', ['options']);
  }
  const options = lone
    ? []
    : ordered.map((option, i) => ({
        name: requiredText(option.name, TEXT_MAX, `options.${i}.name`),
        values: option.values.map((value, j) =>
          requiredText(value, TEXT_MAX, `options.${i}.values.${j}`),
        ),
      }));
  const variants = product.variants.map((variant, i) => {
    const optionValues = lone
      ? []
      : ordered.map((option, j) => {
          const selected = variant.selectedOptions.find((pick) => pick.name === option.name);
          if (!selected) {
            throw new ShopifyProductMappingError('OPTIONS_UNREADABLE', [
              `variants.${i}.selectedOptions.${j}`,
            ]);
          }
          return requiredText(selected.value, TEXT_MAX, `variants.${i}.selectedOptions.${j}`);
        });
    return {
      externalVariantId: variant.id,
      variantId: context.variantIds.get(variant.id) ?? null,
      sku: codeOf(variant.sku),
      optionValues,
      price: priceOf(variant.price, `variants.${i}.price`),
      compareAtPrice: priceOf(variant.compareAtPrice, `variants.${i}.compareAtPrice`),
      barcode: codeOf(variant.barcode),
      weightGrams: weightInGrams(variant.inventoryItem.measurement.weight),
      requiresShipping: variant.inventoryItem.requiresShipping,
      tracked: variant.inventoryItem.tracked,
    };
  });
  return {
    storeId: context.storeId,
    externalProductId: product.id,
    styleId: context.styleId,
    handle: requiredText(product.handle, TEXT_MAX, 'handle'),
    title: requiredText(product.title, TITLE_MAX, 'title'),
    productType: cleanText(product.productType, TEXT_MAX),
    vendor: cleanText(product.vendor, TEXT_MAX),
    tags: product.tags
      .flatMap((tag) => {
        const text = cleanText(tag, TEXT_MAX);
        return text === null ? [] : [text];
      })
      .slice(0, MAX_TAGS),
    options,
    variants,
  };
}
