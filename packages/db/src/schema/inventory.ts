import { sql } from 'drizzle-orm';
import {
  boolean,
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { createdAt, id, money, unitCost } from './columns.js';
import { users } from './auth.js';
import { bins, locations } from './locations.js';

// Only the inventory ledger service writes the tables in this file (spec 0002).
// `movement_groups`, `stock_movements`, and `movement_serials` are append only: the
// application role holds INSERT and SELECT on them, and a trigger rejects the rest.

/** A production batch of one SKU, with an optional expiry date. Code is unique per SKU; other tables reference `(id, variant_id)` so a lot cannot cross SKUs. */
export const lots = pgTable(
  'lots',
  {
    id: id(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    expiresOn: date('expires_on'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('lots_variant_code_unique').on(t.variantId, t.code),
    // Target of the (lot_id, variant_id) composite keys: a lot always belongs to the row's SKU.
    unique('lots_id_variant_unique').on(t.id, t.variantId),
  ],
);

/** Where a serial number stands: on hand somewhere, or gone out. */
export const serialStatus = pgEnum('serial_status', ['in_stock', 'out']);

/** One physical unit of a serial tracked SKU. A serial is unique per SKU; its status and place move with the ledger postings. */
export const serials = pgTable(
  'serials',
  {
    id: id(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    serial: text('serial').notNull(),
    lotId: uuid('lot_id'),
    status: serialStatus('status').notNull(),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
    binId: uuid('bin_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('serials_variant_serial_unique').on(t.variantId, t.serial),
    foreignKey({
      columns: [t.lotId, t.variantId],
      foreignColumns: [lots.id, lots.variantId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.binId, t.locationId],
      foreignColumns: [bins.id, bins.locationId],
    }).onDelete('restrict'),
    index('serials_place_idx')
      .on(t.variantId, t.locationId, t.binId)
      .where(sql`${t.status} = 'in_stock'`),
    check(
      'serials_place_when_in_stock',
      sql`(${t.status} = 'in_stock') = (${t.locationId} IS NOT NULL)`,
    ),
    check('serials_bin_needs_location', sql`${t.binId} IS NULL OR ${t.locationId} IS NOT NULL`),
  ],
);

/** Why stock moved. Every ledger movement carries one, and the source document is identified alongside it. */
export const movementSourceType = pgEnum('movement_source_type', [
  'opening_balance',
  'purchase_receipt',
  'purchase_return',
  'sales_shipment',
  'sales_return',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'count',
  'production_consume',
  'production_output',
  'stock_receipt',
]);

/** One row per posting. Append only. */
export const movementGroups = pgTable(
  'movement_groups',
  {
    id: id(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    sourceType: movementSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    reversesGroupId: uuid('reverses_group_id').unique(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** The signed in user who posted it; null for history from before sign in (spec 0005). */
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    foreignKey({ columns: [t.reversesGroupId], foreignColumns: [t.id] }).onDelete('restrict'),
    index('movement_groups_source_idx').on(t.sourceType, t.sourceId),
  ],
);

/** The stock ledger: one signed row per place per posting line. Append only. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => movementGroups.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    binId: uuid('bin_id'),
    lotId: uuid('lot_id'),
    quantity: integer('quantity').notNull(),
    unitCost: unitCost('unit_cost').notNull(),
    totalCost: money('total_cost').notNull(),
    /** Reference cost minus ledger value (receipts into a shortfall, reversals). */
    costVariance: money('cost_variance').notNull().default('0'),
    costUnknown: boolean('cost_unknown').notNull().default(false),
    sourceLineId: uuid('source_line_id'),
    /** The caller's reason only. */
    reasonCode: text('reason_code'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.binId, t.locationId],
      foreignColumns: [bins.id, bins.locationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.lotId, t.variantId],
      foreignColumns: [lots.id, lots.variantId],
    }).onDelete('restrict'),
    index('stock_movements_variant_location_effective_idx').on(
      t.variantId,
      t.locationId,
      t.effectiveAt,
    ),
    index('stock_movements_group_idx').on(t.groupId),
    // SKU history, newest first (spec 0006).
    index('stock_movements_variant_recorded_idx').on(t.variantId, t.recordedAt.desc(), t.id.desc()),
    index('stock_movements_recorded_brin').using('brin', t.recordedAt),
    index('stock_movements_lot_idx')
      .on(t.lotId)
      .where(sql`${t.lotId} IS NOT NULL`),
    check('stock_movements_quantity_not_zero', sql`${t.quantity} <> 0`),
    check(
      'stock_movements_cost_sign',
      sql`${t.totalCost} = 0 OR sign(${t.totalCost}) = sign(${t.quantity})`,
    ),
  ],
);

/** Which serials each movement moved. Append only. */
export const movementSerials = pgTable(
  'movement_serials',
  {
    movementId: uuid('movement_id')
      .notNull()
      .references(() => stockMovements.id, { onDelete: 'restrict' }),
    serialId: uuid('serial_id')
      .notNull()
      .references(() => serials.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.movementId, t.serialId] }),
    index('movement_serials_serial_idx').on(t.serialId),
  ],
);

/** The running balance per SKU, location, bin, and lot, kept in the posting transaction. */
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: id(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    binId: uuid('bin_id'),
    lotId: uuid('lot_id'),
    onHand: integer('on_hand').notNull().default(0),
    /** Kept at its last value when on hand reaches 0. */
    avgUnitCost: unitCost('avg_unit_cost').notNull().default('0'),
    totalValue: money('total_value').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_levels_key_unique')
      .on(t.variantId, t.locationId, t.binId, t.lotId)
      .nullsNotDistinct(),
    foreignKey({
      columns: [t.binId, t.locationId],
      foreignColumns: [bins.id, bins.locationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.lotId, t.variantId],
      foreignColumns: [lots.id, lots.variantId],
    }).onDelete('restrict'),
    index('stock_levels_location_variant_idx').on(t.locationId, t.variantId),
    // The Stock page order, most recent movement first (spec 0006).
    index('stock_levels_updated_idx').on(t.updatedAt.desc(), t.id.desc()),
    check(
      'stock_levels_value_sign',
      sql`(${t.onHand} = 0 AND ${t.totalValue} = 0) OR (${t.onHand} <> 0 AND (${t.totalValue} = 0 OR sign(${t.totalValue}) = sign(${t.onHand})))`,
    ),
  ],
);

/** Reservation lifecycle: active holds stock, then released (cancelled) or fulfilled (shipped). */
export const reservationStatus = pgEnum('reservation_status', ['active', 'released', 'fulfilled']);

/** Stock promised to a document line. Holds no bin: picking chooses the bin. */
export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id'),
    /** The original quantity. */
    quantity: integer('quantity').notNull(),
    openQuantity: integer('open_quantity').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceLineId: uuid('source_line_id').notNull(),
    status: reservationStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.lotId, t.variantId],
      foreignColumns: [lots.id, lots.variantId],
    }).onDelete('restrict'),
    uniqueIndex('reservations_active_source_line_unique')
      .on(t.sourceType, t.sourceLineId)
      .where(sql`${t.status} = 'active'`),
    index('reservations_active_balance_idx')
      .on(t.variantId, t.locationId, t.lotId)
      .where(sql`${t.status} = 'active'`),
    check('reservations_quantity_positive', sql`${t.quantity} > 0`),
    check(
      'reservations_open_quantity_range',
      sql`${t.openQuantity} >= 0 AND ${t.openQuantity} <= ${t.quantity}`,
    ),
    check(
      'reservations_open_while_active',
      sql`(${t.status} = 'active') = (${t.openQuantity} > 0)`,
    ),
  ],
);

/** What a reconciliation found wrong: a stock balance, a reservation total, or a serial status. */
export const discrepancyKind = pgEnum('discrepancy_kind', ['balance', 'reservation', 'serial']);
/** How a discrepancy was closed: the balance was rebuilt from the ledger, or a person dismissed it. */
export const discrepancyResolution = pgEnum('discrepancy_resolution', ['rebuilt', 'dismissed']);

/** Mismatches found by the nightly reconciliation. At most one open record per balance and kind. */
export const stockLevelDiscrepancies = pgTable(
  'stock_level_discrepancies',
  {
    id: id(),
    stockLevelId: uuid('stock_level_id').references(() => stockLevels.id, {
      onDelete: 'restrict',
    }),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    binId: uuid('bin_id'),
    lotId: uuid('lot_id'),
    kind: discrepancyKind('kind').notNull(),
    expected: jsonb('expected').notNull(),
    actual: jsonb('actual').notNull(),
    foundAt: timestamp('found_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    resolution: discrepancyResolution('resolution'),
  },
  // The partial unique index (kind, variant_id, location_id, bin_id, lot_id) NULLS NOT DISTINCT
  // WHERE resolved_at IS NULL is written by hand in the migration; Drizzle cannot express it.
  (t) => [index('stock_level_discrepancies_stock_level_idx').on(t.stockLevelId)],
);
