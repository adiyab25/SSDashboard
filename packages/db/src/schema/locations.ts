import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { archivedAt, createdAt, id, tenantId, updatedAt, type LocalizedText } from './columns.js';
import { parties } from './parties.js';

/** What kind of place holds stock: a warehouse, a shop, goods in transit, or a virtual bucket. */
export const locationKind = pgEnum('location_kind', ['warehouse', 'shop', 'transit', 'virtual']);

/** Who owns the place: the brand, a consignment partner, or a wholesale customer. Fixed for a location's life (trigger `locations_owner_fixed`). */
export const locationOwnerType = pgEnum('location_owner_type', [
  'own',
  'consignment_partner',
  'wholesale_customer',
]);

/**
 * A place stock is counted in. Archived rather than deleted; `allowNegative` lets postings take
 * on-hand below zero at this location. `ownerType` and `partyId` never change after creation, and
 * `partyId` is set exactly when the owner is not the brand.
 */
export const locations = pgTable(
  'locations',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    kind: locationKind('kind').notNull(),
    ownerType: locationOwnerType('owner_type').notNull().default('own'),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'restrict' }),
    isSellable: boolean('is_sellable').notNull().default(true),
    /** Only these locations feed the portal and Shopify; the policy table says where it may be true. */
    sellableOnline: boolean('sellable_online').notNull().default(false),
    allowNegative: boolean('allow_negative').notNull().default(false),
    /** When the location's stock was confirmed counted (the online gate's "stock counted" fact, spec 0011 AC-19). */
    stockVerifiedAt: timestamp('stock_verified_at', { withTimezone: true }),
    /** Who confirmed it. */
    stockVerifiedBy: uuid('stock_verified_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    unique('locations_code_unique').on(t.tenantId, t.code),
    index('locations_party_idx').on(t.partyId),
    // Foreign key index: stock_verified_by (spec 0011 task 1).
    index('locations_stock_verified_by_idx')
      .on(t.stockVerifiedBy)
      .where(sql`${t.stockVerifiedBy} IS NOT NULL`),
    // Spec 0011 AC-1: only a sellable warehouse is ever online, and at most one active location is.
    check(
      'locations_online_needs_warehouse',
      sql`NOT ${t.sellableOnline} OR (${t.kind} = 'warehouse' AND ${t.isSellable})`,
    ),
    uniqueIndex('locations_one_online')
      .on(t.tenantId)
      .where(sql`${t.sellableOnline} AND ${t.archivedAt} IS NULL`),
    check('locations_party_matches_owner', sql`(${t.ownerType} = 'own') = (${t.partyId} IS NULL)`),
  ],
);

/** When a sale counts for a location owner type. */
export const saleRecordedAt = pgEnum('sale_recorded_at', [
  'at_shipment',
  'at_sell_through',
  'at_handover',
]);

/** Who pays a refund: the brand, or the owner of the location. */
export const refundBy = pgEnum('refund_by', ['brand', 'location_owner']);

/** Which tax document a sale at the location needs. */
export const taxDocument = pgEnum('tax_document', [
  'b2c_electronic_receipt',
  'b2b_electronic_invoice_at_settlement',
  'b2b_electronic_invoice_at_handover',
]);

/** Which kind of settlement account a sale settles through (spec 0002, settlement child). */
export const settlementOwnerType = pgEnum('settlement_owner_type', [
  'carrier',
  'consignment_partner',
  'gateway',
]);

/**
 * One row per owner type answering every question that differs by owner type. Read only through
 * `LocationPolicyService`; seeded with three rows by the rules file; feature 9 owns editing it.
 */
export const locationOwnerPolicies = pgTable(
  'location_owner_policies',
  {
    tenantId: tenantId(),
    ownerType: locationOwnerType('owner_type').notNull(),
    stockOwnedByBrand: boolean('stock_owned_by_brand').notNull(),
    handoverIsSale: boolean('handover_is_sale').notNull(),
    saleRecordedAt: saleRecordedAt('sale_recorded_at').notNull(),
    endCustomerRefundBy: refundBy('end_customer_refund_by').notNull(),
    defectivePieceRefundBy: refundBy('defective_piece_refund_by').notNull(),
    taxDocument: taxDocument('tax_document').notNull(),
    settlementOwnerType: settlementOwnerType('settlement_owner_type'),
    canSellOnline: boolean('can_sell_online').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * When a locked term (stock owner, handover, sale moment, tax document, settling owner) last
     * changed, or null when never (the seeded rows). An archived location of the type comes back
     * only while it is not later than its archive (spec 0009 AC-24, D13); the free fields (who
     * refunds, online selling) never move it.
     */
    lockedTermsChangedAt: timestamp('locked_terms_changed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ownerType] }),
    // Foreign key index: updated_by (spec 0002 item 19).
    index('location_owner_policies_updated_by_idx').on(t.updatedBy),
    // Spec 0009 AC-24 (owner ruling 2026-11-08, migration 0011): a row never contradicts itself,
    // even when written past the api. Handing stock over is the sale exactly when the stock is not
    // the brand's; the sale counts at the handover exactly when the handover is the sale; and only
    // the brand's own stock whose sales settle through no partner may be offered online.
    check(
      'location_owner_policies_handover_is_sale',
      sql`${t.handoverIsSale} = NOT ${t.stockOwnedByBrand}`,
    ),
    check(
      'location_owner_policies_sale_at_handover',
      sql`(${t.saleRecordedAt} = 'at_handover') = ${t.handoverIsSale}`,
    ),
    // Owner ruling 2026-11-08 ("Yes, pin it"): the consignment row always settles with its
    // partner, so the online rule can never be opened up for partner stock by redefining it.
    check(
      'location_owner_policies_consignment_settles_with_partner',
      sql`${t.ownerType} <> 'consignment_partner' OR ${t.settlementOwnerType} IS NOT NULL`,
    ),
    check(
      'location_owner_policies_online_needs_brand_stock',
      sql`NOT ${t.canSellOnline} OR (${t.stockOwnedByBrand} AND ${t.settlementOwnerType} IS NULL)`,
    ),
  ],
);

/** Depth in the bin tree, from a whole zone down to a single bin. */
export const binLevel = pgEnum('bin_level', ['zone', 'aisle', 'shelf', 'bin']);

/** A storage position inside a location, nested by `parentId`. Code is unique per location; the `(id, location_id)` unique key lets other tables keep a bin in its row's location. */
export const bins = pgTable(
  'bins',
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    level: binLevel('level').notNull().default('bin'),
    code: text('code').notNull(),
    isSellable: boolean('is_sellable').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }).onDelete('restrict'),
    unique('bins_location_code_unique').on(t.tenantId, t.locationId, t.code),
    // Target of the (bin_id, location_id) composite keys: a bin always belongs to the row's location.
    unique('bins_id_location_unique').on(t.id, t.locationId),
    index('bins_parent_idx').on(t.parentId),
    // Foreign key index: location_id; the unique keys lead with tenant_id (spec 0002 item 19).
    index('bins_location_idx').on(t.locationId),
  ],
);
