import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import {
  archivedAt,
  createdAt,
  id,
  money,
  tenantId,
  unitCost,
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

/** How a brand groups its styles (spec 0002, A12); drives export codes. Seeded with `MAIN`, the group of a one line brand. */
export const productGroups = pgTable(
  'product_groups',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    archivedAt: archivedAt(),
  },
  (t) => [unique('product_groups_code_unique').on(t.tenantId, t.code)],
);

/** A fashion season such as `SS27`. `CORE` (no dates) holds the carry over basics. Dates are optional but ordered. */
export const seasons = pgTable(
  'seasons',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    archivedAt: archivedAt(),
  },
  (t) => [
    unique('seasons_code_unique').on(t.tenantId, t.code),
    check(
      'seasons_dates_in_order',
      sql`${t.startsOn} IS NULL OR ${t.endsOn} IS NULL OR ${t.startsOn} <= ${t.endsOn}`,
    ),
  ],
);

/** Product lifecycle: draft until published, active for sale, archived instead of deleted. */
export const productStatus = pgEnum('product_status', ['draft', 'active', 'archived']);

/**
 * A style: what a customer thinks of (a shirt), with a style code, a product group, and the
 * season of its current run. Sold and stocked as its variants (sizes and colors). The group has
 * no column default (the seeded `MAIN` row only exists after the tables), so every writer passes
 * it; a one line brand passes `MAIN`.
 */
export const products = pgTable(
  'products',
  {
    id: id(),
    tenantId: tenantId(),
    styleCode: text('style_code').notNull(),
    seasonId: uuid('season_id').references(() => seasons.id, { onDelete: 'restrict' }),
    productGroupId: uuid('product_group_id')
      .notNull()
      .references(() => productGroups.id, { onDelete: 'restrict' }),
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
  (t) => [
    unique('products_style_code_unique').on(t.tenantId, t.styleCode),
    index('products_product_group_idx').on(t.productGroupId),
    index('products_season_idx').on(t.seasonId),
    index('products_tags_idx').using('gin', t.tags),
    // Fuzzy search over both names and the style code (feature 12 swaps in its Arabic normalization).
    index('products_search_trgm_idx').using(
      'gin',
      sql`(coalesce(${t.name}->>'en', '') || ' ' || coalesce(${t.name}->>'ar', '') || ' ' || ${t.styleCode}) gin_trgm_ops`,
    ),
  ],
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
    // Target of the (variant_id, product_id) composite key on cost records: an override always belongs to its style.
    unique('product_variants_id_product_unique').on(t.id, t.productId),
    index('product_variants_product_idx').on(t.productId),
    // SKU code prefix search: the unique index uses the default collation, which LIKE 'X%' cannot use.
    index('product_variants_sku_c_idx').on(sql`${t.sku} COLLATE "C"`),
    // SKU fragment search ("contains") at 50,000 variants.
    index('product_variants_sku_trgm_idx').using('gin', t.sku.op('gin_trgm_ops')),
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

/** Where a cost came from; a margin that rests on an `estimate` is labelled so. */
export const costBasis = pgEnum('cost_basis', [
  'factory_invoice',
  'production_run',
  'purchase_landed',
  'estimate',
]);

/**
 * Cost per base unit for a style in a season, or for one variant as an override (`variantId` set).
 * Append only (the rules file adds the guards): a correction is a newer record with the same
 * `effectiveFrom`. `CostService` picks the record in force; a movement's frozen cost never
 * changes when a record is added.
 */
export const costRecords = pgTable(
  'cost_records',
  {
    id: id(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id'),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    costBasis: costBasis('cost_basis').notNull(),
    unitCost: unitCost('unit_cost').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    /** An invoice number or an import batch. */
    source: text('source'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    foreignKey({
      columns: [t.variantId, t.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
    }).onDelete('restrict'),
    index('cost_records_style_idx').on(t.productId, t.effectiveFrom.desc(), t.recordedAt.desc()),
    index('cost_records_variant_idx')
      .on(t.variantId, t.effectiveFrom.desc(), t.recordedAt.desc())
      .where(sql`${t.variantId} IS NOT NULL`),
    index('cost_records_season_idx').on(t.seasonId),
    check('cost_records_unit_cost_not_negative', sql`${t.unitCost} >= 0`),
  ],
);
