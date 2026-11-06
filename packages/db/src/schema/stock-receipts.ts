import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { productVariants, uoms } from './catalog.js';
import { createdAt, money, tenantId, unitCost } from './columns.js';
import { movementGroups } from './inventory.js';
import { locations } from './locations.js';

// Stock receipts (spec 0006): written only by the inventory receipts service, inside the
// ledger's posting transaction (`within`). Lines are write once: the migration revokes UPDATE
// and DELETE on them from the application role, and DELETE on the receipts.

/** Receipt state: posted, or voided by a reversing movement group (never edited or deleted). */
export const stockReceiptStatus = pgEnum('stock_receipt_status', ['posted', 'voided']);

/** A numbered stock receipt. Its id is the client's idempotency key. */
export const stockReceipts = pgTable(
  'stock_receipts',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    requestHash: text('request_hash').notNull(),
    number: text('number').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    reference: text('reference'),
    note: text('note'),
    status: stockReceiptStatus('status').notNull().default('posted'),
    movementGroupId: uuid('movement_group_id')
      .notNull()
      .unique()
      .references(() => movementGroups.id, { onDelete: 'restrict' }),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    voidGroupId: uuid('void_group_id')
      .unique()
      .references(() => movementGroups.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    // Every write sets this explicitly (spec 0006, Value sourcing): no ORM side default.
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_receipts_number_unique').on(t.tenantId, t.number),
    index('stock_receipts_effective_idx').on(t.effectiveAt.desc(), t.id.desc()),
    index('stock_receipts_location_effective_idx').on(
      t.locationId,
      t.effectiveAt.desc(),
      t.id.desc(),
    ),
    check(
      'stock_receipts_reference_length',
      sql`${t.reference} IS NULL OR char_length(${t.reference}) BETWEEN 1 AND 64`,
    ),
    check(
      'stock_receipts_note_length',
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`,
    ),
    check(
      'stock_receipts_void_reason_length',
      sql`${t.voidReason} IS NULL OR char_length(${t.voidReason}) BETWEEN 1 AND 500`,
    ),
    check(
      'stock_receipts_voided_fields',
      // All four void fields are set exactly when voided, and none of them before.
      sql`num_nonnulls(${t.voidedAt}, ${t.voidedBy}, ${t.voidReason}, ${t.voidGroupId}) = CASE WHEN ${t.status} = 'voided' THEN 4 ELSE 0 END`,
    ),
  ],
);

/** One SKU on a receipt. Write once. */
export const stockReceiptLines = pgTable(
  'stock_receipt_lines',
  {
    /** Derived: UUID v5 of `<receipt id>:<position>` (spec 0006, Value sourcing). */
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    receiptId: uuid('receipt_id').notNull(),
    position: integer('position').notNull(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    uomId: uuid('uom_id')
      .notNull()
      .references(() => uoms.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    unitCost: unitCost('unit_cost').notNull(),
    lineTotal: money('line_total').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.receiptId], foreignColumns: [stockReceipts.id] }).onDelete('restrict'),
    unique('stock_receipt_lines_receipt_variant_unique').on(t.receiptId, t.variantId),
    unique('stock_receipt_lines_receipt_position_unique').on(t.tenantId, t.receiptId, t.position),
    index('stock_receipt_lines_variant_idx').on(t.variantId),
    check('stock_receipt_lines_position_range', sql`${t.position} BETWEEN 1 AND 200`),
    check('stock_receipt_lines_quantity_range', sql`${t.quantity} BETWEEN 1 AND 1000000`),
    check('stock_receipt_lines_unit_cost_not_negative', sql`${t.unitCost} >= 0`),
  ],
);
