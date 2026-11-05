import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  archivedAt,
  createdAt,
  id,
  money,
  tenantId,
  updatedAt,
  type LocalizedText,
} from './columns.js';

/** Units of measure (piece, box). A variant counts stock in its base unit; packs convert through `variantUomConversions`. */
export const uoms = pgTable(
  'uoms',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
  },
  (t) => [unique('uoms_code_unique').on(t.tenantId, t.code)],
);

/** Product lifecycle: draft until published, active for sale, archived instead of deleted. */
export const productStatus = pgEnum('product_status', ['draft', 'active', 'archived']);

/** The style a customer thinks of (a shirt), with bilingual name and free form custom fields. Sold and stocked as its variants. */
export const products = pgTable(
  'products',
  {
    id: id(),
    tenantId: tenantId(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    description: jsonb('description').$type<LocalizedText>(),
    status: productStatus('status').notNull().default('draft'),
    brand: text('brand'),
    productType: text('product_type'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [index('products_tags_idx').using('gin', t.tags)],
);

/** A choice axis on a product (size, color) with ordered values; variants point into it by position. */
export const productOptions = pgTable(
  'product_options',
  {
    id: id(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    position: integer('position').notNull(),
    /** Ordered option values, each `{ en, ar }`. */
    values: jsonb('values').$type<LocalizedText[]>().notNull(),
  },
  (t) => [
    unique('product_options_product_position_unique').on(t.tenantId, t.productId, t.position),
  ],
);

/** What a variant is: physical stock, a service with no stock, or a bundle of other variants. */
export const variantKind = pgEnum('variant_kind', ['stocked', 'service', 'bundle']);
/** How a stocked variant is traced: not at all, by lot, or one serial per unit. Only `stocked` variants may be tracked. */
export const variantTracking = pgEnum('variant_tracking', ['none', 'lot', 'serial']);

/** The SKU: the unit stock is counted in. */
export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    /** Option position to value index, e.g. `{ "0": 2, "1": 0 }`. */
    optionValues: jsonb('option_values').$type<Record<string, number>>().notNull().default({}),
    kind: variantKind('kind').notNull().default('stocked'),
    tracking: variantTracking('tracking').notNull().default('none'),
    baseUomId: uuid('base_uom_id')
      .notNull()
      .references(() => uoms.id, { onDelete: 'restrict' }),
    price: money('price'),
    compareAtPrice: money('compare_at_price'),
    weightGrams: integer('weight_grams'),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    hsCode: text('hs_code'),
    countryOfOrigin: char('country_of_origin', { length: 2 }),
    requiresShipping: boolean('requires_shipping').notNull().default(true),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    unique('product_variants_sku_unique').on(t.tenantId, t.sku),
    index('product_variants_product_idx').on(t.productId),
    // SKU code prefix search: the unique index uses the default collation, which LIKE 'X%' cannot use.
    index('product_variants_sku_c_idx').on(sql`${t.sku} COLLATE "C"`),
    check(
      'product_variants_tracking_stocked_only',
      sql`${t.tracking} = 'none' OR ${t.kind} = 'stocked'`,
    ),
  ],
);

/** Base units per one of a pack unit (a box of 12 has factor 12). */
export const variantUomConversions = pgTable(
  'variant_uom_conversions',
  {
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    uomId: uuid('uom_id')
      .notNull()
      .references(() => uoms.id, { onDelete: 'restrict' }),
    factor: integer('factor').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.uomId] }),
    index('variant_uom_conversions_uom_idx').on(t.uomId),
    check('variant_uom_conversions_factor_above_one', sql`${t.factor} > 1`),
  ],
);

/** Scannable codes for a variant, each tied to the pack unit it scans as. Codes are unique across the whole catalog. */
export const barcodes = pgTable(
  'barcodes',
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    /** Which pack the code scans as. */
    uomId: uuid('uom_id')
      .notNull()
      .references(() => uoms.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
  },
  (t) => [
    unique('barcodes_code_unique').on(t.tenantId, t.code),
    index('barcodes_variant_idx').on(t.variantId),
    index('barcodes_uom_idx').on(t.uomId),
  ],
);
