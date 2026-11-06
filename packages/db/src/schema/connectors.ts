import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { stores } from './channels.js';
import { createdAt, id, tenantId, updatedAt } from './columns.js';

// The connectors module (spec 0002, orders child; spec 0007 section 1): the accounts the brand
// connects and the commands written back to them. Key columns only: credentials, mode, and health
// arrive with features 13 and 19. Only the connectors module writes these tables.

/** Which outside account a connection talks to. `gateway` exists so a gateway settlement account is rows, not a migration. */
export const connectionProvider = pgEnum('connection_provider', [
  'shopify',
  'bosta',
  'gateway',
  'meta',
  'whatsapp',
  'telegram',
]);

/** Whether a connection is in use. `restricted` means the provider limited it. */
export const connectionStatus = pgEnum('connection_status', [
  'active',
  'paused',
  'restricted',
  'archived',
]);

/**
 * One connected outside account. A Shopify connection always belongs to exactly one store, and a
 * store has at most one Shopify connection. A carrier (`bosta`) connection without a store serves
 * every store; one with a store is bound to it.
 */
export const connections = pgTable(
  'connections',
  {
    id: id(),
    tenantId: tenantId(),
    provider: connectionProvider('provider').notNull(),
    label: text('label').notNull(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    status: connectionStatus('status').notNull().default('active'),
    restrictedAt: timestamp('restricted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'connections_shopify_needs_store',
      sql`${t.provider} <> 'shopify' OR ${t.storeId} IS NOT NULL`,
    ),
    uniqueIndex('connections_shopify_store_unique')
      .on(t.tenantId, t.storeId)
      .where(sql`${t.provider} = 'shopify'`),
    index('connections_store_idx').on(t.storeId),
  ],
);

/** What an outbound command is about. */
export const outboundLinkedType = pgEnum('outbound_linked_type', [
  'order',
  'customer',
  'variant',
  'exchange',
  'refund',
]);

/** Whether a write back landed. The single truth for an order's open edits (`orders.write_back_state` projects it). */
export const outboundSyncState = pgEnum('outbound_sync_state', [
  'waiting',
  'synced',
  'failed',
  'resolved',
]);

/** How a person closed a failed command. */
export const outboundResolution = pgEnum('outbound_resolution', [
  'retried',
  'fixed_in_provider',
  'edit_undone',
]);

/**
 * A write back to a connected account (for example a Shopify order edit), written in the same
 * transaction as the change it carries. `payload` may hold an address: personal data, never
 * logged. `resolution` and `resolvedAt` are set exactly when the command is `resolved`. A
 * failed command is resolved, never deleted: the app role has no DELETE on this table.
 */
export const outboundCommands = pgTable(
  'outbound_commands',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    /** For example `shopify.order_edit`. */
    kind: text('kind').notNull(),
    linkedType: outboundLinkedType('linked_type').notNull(),
    linkedId: uuid('linked_id').notNull(),
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    syncState: outboundSyncState('sync_state').notNull().default('waiting'),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'restrict' }),
    resolution: outboundResolution('resolution'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('outbound_commands_idempotency_key_unique').on(t.tenantId, t.idempotencyKey),
    // The open commands of one record: the `packed` transition and the hold flag ask this.
    index('outbound_commands_open_linked_idx')
      .on(t.linkedType, t.linkedId)
      .where(sql`${t.syncState} IN ('waiting', 'failed')`),
    index('outbound_commands_connection_idx').on(t.connectionId),
    index('outbound_commands_resolved_by_idx').on(t.resolvedBy),
    check(
      'outbound_commands_resolution_when_resolved',
      sql`(${t.syncState} = 'resolved') = (${t.resolution} IS NOT NULL)`,
    ),
    // Both ways: `resolved` is final, so `resolved_at` is set exactly then, never on a live command.
    check(
      'outbound_commands_resolved_at_when_resolved',
      sql`(${t.syncState} = 'resolved') = (${t.resolvedAt} IS NOT NULL)`,
    ),
    check('outbound_commands_attempts_not_negative', sql`${t.attempts} >= 0`),
  ],
);
