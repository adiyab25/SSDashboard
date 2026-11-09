import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { tenantId } from './columns.js';
import { movementGroups } from './inventory.js';
import { locations } from './locations.js';

// Showroom moves (spec 0011 AC-25): written only by the inventory transfers service, inside the
// ledger's posting transaction (`within`). Append only: the rules migration revokes UPDATE,
// DELETE, and TRUNCATE from the application role and adds the `ssd_reject_change` triggers.

/** Which way a showroom move goes: out to a consignment partner, or back from one. */
export const stockTransferKind = pgEnum('stock_transfer_kind', [
  'send_to_partner',
  'return_from_partner',
]);

/**
 * A numbered move of stock between the brand's own location and a partner's. Its id is the
 * client's idempotency key. Lines are not stored apart: each line's two movements share a
 * `source_line_id` and the page reads them from the movement group.
 */
export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    kind: stockTransferKind('kind').notNull(),
    fromLocationId: uuid('from_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    toLocationId: uuid('to_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    reference: text('reference'),
    requestHash: text('request_hash').notNull(),
    movementGroupId: uuid('movement_group_id')
      .notNull()
      .references(() => movementGroups.id, { onDelete: 'restrict' }),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Stamped by the database (`ssd_stamp_recorded_at`), never by a writer. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_transfers_number_unique').on(t.tenantId, t.number),
    unique('stock_transfers_movement_group_unique').on(t.movementGroupId),
    index('stock_transfers_from_location_idx').on(t.fromLocationId),
    index('stock_transfers_to_location_idx').on(t.toLocationId),
    index('stock_transfers_posted_by_idx').on(t.postedBy),
    index('stock_transfers_recorded_idx').on(
      t.recordedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check('stock_transfers_locations_differ', sql`${t.fromLocationId} <> ${t.toLocationId}`),
    check(
      'stock_transfers_reference_length',
      sql`${t.reference} IS NULL OR char_length(${t.reference}) BETWEEN 1 AND 64`,
    ),
  ],
);
