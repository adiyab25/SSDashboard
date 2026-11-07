import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { productVariants } from './catalog.js';
import { stores } from './channels.js';
import { createdAt, id, reasonCodeShape, tenantId, updatedAt } from './columns.js';

// The connectors module (spec 0002, orders child; spec 0007 section 1; spec 0015 data model): the
// accounts the brand connects, the commands written back to them, and the Shopify inbox, mappings,
// stock levels, and sync runs. Only the connectors module writes these tables.

/** The check body for an upper case code column (a health reason, a provider error, a failure code). */
const upperCodeShape = (column: AnyPgColumn) =>
  sql`${column} IS NULL OR ${column} ~ '^[A-Z][A-Z0-9_]{0,63}$'`;

/** A `bytea` column: the sealed connection credentials (AES-256-GCM ciphertext, spec 0015 AC-2). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

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

/** How well a connection works (spec 0015 AC-1, AC-8). Matches the Zod `ConnectionHealth`. */
export const connectionHealth = pgEnum('connection_health', [
  'connecting',
  'ok',
  'degraded',
  'failing',
]);

/**
 * One connected outside account. A Shopify connection always belongs to exactly one store, and a
 * store has at most one Shopify connection. A carrier (`bosta`) connection without a store serves
 * every store; one with a store is bound to it.
 *
 * Credentials are sealed ciphertext only (`credentials_ciphertext` with its key version), never an
 * access token and never readable by a response. `config` holds the provider's own settings (Zod
 * `ShopifyConnectionConfig`). The watermark and freshness columns are written by the connector's
 * jobs.
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
    /** The Shopify shop domain (`<name>.myshopify.com`). */
    shopDomain: text('shop_domain'),
    credentialsCiphertext: bytea('credentials_ciphertext'),
    credentialsKeyVersion: smallint('credentials_key_version'),
    /** The last 4 characters of the client id, the only part a screen shows. */
    credentialsHint: text('credentials_hint'),
    credentialsUpdatedAt: timestamp('credentials_updated_at', { withTimezone: true }),
    /** The provider's settings (Zod `ShopifyConnectionConfig`), never a secret. */
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    health: connectionHealth('health').notNull().default('connecting'),
    healthReason: text('health_reason'),
    healthWarnings: text('health_warnings')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    healthChangedAt: timestamp('health_changed_at', { withTimezone: true }),
    apiVersion: text('api_version'),
    goLiveAt: timestamp('go_live_at', { withTimezone: true }),
    ordersSweptThrough: timestamp('orders_swept_through', { withTimezone: true }),
    productsSweptThrough: timestamp('products_swept_through', { withTimezone: true }),
    stockPushedThrough: timestamp('stock_pushed_through', { withTimezone: true }),
    stockPushConfirmedAt: timestamp('stock_push_confirmed_at', { withTimezone: true }),
    stockPushConfirmedBy: uuid('stock_push_confirmed_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    stockPushPreviewRunId: uuid('stock_push_preview_run_id').references(
      (): AnyPgColumn => connectionSyncRuns.id,
      { onDelete: 'restrict' },
    ),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
    lastSweepAt: timestamp('last_sweep_at', { withTimezone: true }),
    hookAuthFailures: integer('hook_auth_failures').notNull().default(0),
    lastHookAuthFailureAt: timestamp('last_hook_auth_failure_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'connections_shopify_needs_store',
      sql`${t.provider} <> 'shopify' OR ${t.storeId} IS NOT NULL`,
    ),
    check(
      'connections_shopify_needs_shop_domain',
      sql`${t.provider} <> 'shopify' OR ${t.shopDomain} IS NOT NULL`,
    ),
    check(
      'connections_shop_domain_shape',
      sql`${t.shopDomain} IS NULL OR ${t.shopDomain} ~ '^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$'`,
    ),
    uniqueIndex('connections_shopify_store_unique')
      .on(t.tenantId, t.storeId)
      .where(sql`${t.provider} = 'shopify'`),
    // One live connection per shop: archiving frees the domain (spec 0015 AC-1, 409 SHOP_ALREADY_CONNECTED).
    uniqueIndex('connections_shop_domain_unique')
      .on(t.tenantId, t.shopDomain)
      .where(sql`${t.shopDomain} IS NOT NULL AND ${t.status} <> 'archived'`),
    check(
      'connections_credentials_key_version_together',
      sql`(${t.credentialsCiphertext} IS NULL) = (${t.credentialsKeyVersion} IS NULL)`,
    ),
    check(
      'connections_stock_push_confirmed_together',
      sql`(${t.stockPushConfirmedAt} IS NULL) = (${t.stockPushConfirmedBy} IS NULL)`,
    ),
    check('connections_health_reason_shape', upperCodeShape(t.healthReason)),
    // A secret never lives in config (spec 0015 AC-2); the sealed ciphertext is the only home.
    check(
      'connections_config_no_secret_keys',
      sql`NOT (${t.config} ?| array['accessToken', 'clientSecret', 'secret', 'token'])`,
    ),
    // AES-256-GCM output is at least a 12 byte nonce plus a 16 byte tag plus one byte of text.
    check(
      'connections_credentials_ciphertext_size',
      sql`${t.credentialsCiphertext} IS NULL OR octet_length(${t.credentialsCiphertext}) >= 29`,
    ),
    check(
      'connections_credentials_key_version_positive',
      sql`${t.credentialsKeyVersion} IS NULL OR ${t.credentialsKeyVersion} > 0`,
    ),
    check(
      'connections_credentials_hint_length',
      sql`${t.credentialsHint} IS NULL OR char_length(${t.credentialsHint}) <= 4`,
    ),
    index('connections_store_idx').on(t.storeId),
    index('connections_stock_push_confirmed_by_idx')
      .on(t.stockPushConfirmedBy)
      .where(sql`${t.stockPushConfirmedBy} IS NOT NULL`),
    index('connections_stock_push_preview_run_idx')
      .on(t.stockPushPreviewRunId)
      .where(sql`${t.stockPushPreviewRunId} IS NOT NULL`),
  ],
);

/** What an outbound command is about. */
export const outboundLinkedType = pgEnum('outbound_linked_type', [
  'order',
  'customer',
  'variant',
  'exchange',
  'refund',
  'connection',
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
    /** A provider error code only (`STEP_OFF`, `CHANGE_FROM_QUANTITY_STALE`), never provider text. */
    failureReason: text('failure_reason'),
    /** The provider's own id for the write, when it gives one. */
    providerRef: text('provider_ref'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
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
    // Leads with the connection, so it also serves the foreign key.
    index('outbound_commands_connection_kind_idx').on(t.connectionId, t.kind, t.createdAt),
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
    check('outbound_commands_failure_reason_shape', upperCodeShape(t.failureReason)),
  ],
);

/** Where an inbox event came from (spec 0015). Matches the Zod `InboundSource`. */
export const inboundSource = pgEnum('inbound_source', [
  'webhook',
  'sweep',
  'backfill',
  'reconcile',
]);

/** What an inbox event is about. Matches the Zod `InboundSubject`. */
export const inboundSubject = pgEnum('inbound_subject', [
  'order',
  'product',
  'customer',
  'inventory_level',
  'app',
  'bulk_operation',
]);

/** Where an inbox event stands. Matches the Zod `InboundStatus`. */
export const inboundStatus = pgEnum('inbound_status', [
  'received',
  'processed',
  'ignored',
  'ignored_unlicensed',
  'echo',
  'failed',
]);

/**
 * The durable inbox of connector messages (spec 0015 AC-5, AC-6). One row per delivery, deduped on
 * (`connection_id`, `dedupe_key`). `payload` holds only the topic, the object id, its update time,
 * and for inventory messages the item, location, and quantity: never a customer name, phone,
 * email, address, note, or line text. `subject_label` is the Shopify order name (not personal).
 * Processed, ignored, and echo rows are purged after 90 days, failed rows after 180.
 */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    source: inboundSource('source').notNull(),
    topic: text('topic').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    subjectType: inboundSubject('subject_type').notNull(),
    subjectExternalId: text('subject_external_id'),
    subjectLabel: text('subject_label'),
    subjectVersion: timestamp('subject_version', { withTimezone: true }),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: inboundStatus('status').notNull().default('received'),
    /** A code: `stale`, `not_visible`, `coalesced`, `test_order`, `held_write_back_open`, and the like. */
    outcome: text('outcome'),
    attempts: integer('attempts').notNull().default(0),
    failureCode: text('failure_code'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    unique('inbound_events_dedupe_unique').on(t.tenantId, t.connectionId, t.dedupeKey),
    // Coalescing and "inbox drained" (partial, so the subject index below serves the connection foreign key).
    index('inbound_events_received_idx')
      .on(t.connectionId, t.subjectType, t.receivedAt)
      .where(sql`${t.status} = 'received'`),
    // The latest event per subject; leads with the connection, so it also serves the foreign key.
    index('inbound_events_subject_idx').on(
      t.connectionId,
      t.subjectType,
      t.subjectExternalId,
      t.receivedAt.desc().nullsFirst(),
    ),
    // The Failed reads tab and the freshness count.
    index('inbound_events_failed_idx')
      .on(t.connectionId, t.receivedAt)
      .where(sql`${t.status} = 'failed'`),
    index('inbound_events_received_at_brin').using('brin', t.receivedAt),
    check('inbound_events_attempts_not_negative', sql`${t.attempts} >= 0`),
    check('inbound_events_topic_length', sql`char_length(${t.topic}) <= 64`),
    check('inbound_events_dedupe_key_length', sql`char_length(${t.dedupeKey}) <= 128`),
    check(
      'inbound_events_subject_label_length',
      sql`${t.subjectLabel} IS NULL OR char_length(${t.subjectLabel}) <= 64`,
    ),
    check('inbound_events_outcome_shape', reasonCodeShape(t.outcome)),
    check('inbound_events_failure_code_shape', upperCodeShape(t.failureCode)),
  ],
);

/** What an external id maps. Matches the Zod `ExternalEntity`. */
export const externalEntity = pgEnum('external_entity', ['product', 'variant', 'order']);

/**
 * The map from a connection's Shopify ids (gids) to this app's style, variant, and order ids
 * (spec 0015), with the version last applied and the connector's own state per object (inventory
 * item id, unmapped lines, pending replacement lines, netted sale ids). `local_id` is null while
 * unresolved; it names a row of another module, so it carries no foreign key.
 */
export const connectionExternalIds = pgTable(
  'connection_external_ids',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    entity: externalEntity('entity').notNull(),
    externalId: text('external_id').notNull(),
    localId: uuid('local_id'),
    externalVersion: timestamp('external_version', { withTimezone: true }),
    state: jsonb('state')
      .notNull()
      .default(sql`'{}'::jsonb`),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Leads with the tenant, so the plain connection index below serves the foreign key.
    unique('connection_external_ids_unique').on(t.tenantId, t.connectionId, t.entity, t.externalId),
    index('connection_external_ids_connection_idx').on(t.connectionId),
    index('connection_external_ids_local_idx')
      .on(t.entity, t.localId)
      .where(sql`${t.localId} IS NOT NULL`),
    // The unmapped variants list.
    index('connection_external_ids_unmapped_variants_idx')
      .on(t.connectionId, t.entity)
      .where(
        sql`${t.entity} = 'variant' AND coalesce(${t.state}->>'lastOutcome', '') NOT IN ('created', 'linked', 'updated', 'unchanged')`,
      ),
    // Late links and waiting replacement orders.
    index('connection_external_ids_waiting_orders_idx')
      .on(t.connectionId)
      .where(
        sql`${t.entity} = 'order' AND (${t.state} ? 'unmappedLines' OR ${t.state} ? 'pendingReplacementLines')`,
      ),
  ],
);

/** What a sync run did. Matches the Zod `SyncRunKind`. */
export const syncRunKind = pgEnum('sync_run_kind', [
  'connect',
  'gateway_scan',
  'backfill_products',
  'backfill_orders',
  'sweep_orders',
  'sweep_products',
  'hourly_check',
  'stock_preview',
  'stock_push',
  'stock_reconcile',
]);

/** How a sync run ended. Matches the Zod `SyncRunStatus`. */
export const syncRunStatus = pgEnum('sync_run_status', [
  'running',
  'succeeded',
  'partial',
  'failed',
]);

/**
 * One run of a connector job (spec 0015): its watermarks, resume cursor, counts, cost in
 * Shopify's query points, and an error code. Counts never hold personal data. Purged after 90 days.
 */
export const connectionSyncRuns = pgTable(
  'connection_sync_runs',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    kind: syncRunKind('kind').notNull(),
    status: syncRunStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    watermarkFrom: timestamp('watermark_from', { withTimezone: true }),
    watermarkTo: timestamp('watermark_to', { withTimezone: true }),
    cursor: text('cursor'),
    counts: jsonb('counts')
      .notNull()
      .default(sql`'{}'::jsonb`),
    costPoints: integer('cost_points').notNull().default(0),
    errorCode: text('error_code'),
  },
  (t) => [
    index('connection_sync_runs_connection_kind_idx').on(
      t.connectionId,
      t.kind,
      t.startedAt.desc().nullsFirst(),
    ),
    index('connection_sync_runs_started_brin').using('brin', t.startedAt),
    check('connection_sync_runs_cost_not_negative', sql`${t.costPoints} >= 0`),
    check('connection_sync_runs_error_code_shape', upperCodeShape(t.errorCode)),
  ],
);

/**
 * One SKU's stock level at a connection's mapped Shopify location (spec 0015 AC-19, AC-21): the
 * target last computed, what was pushed and when, what Shopify last said, and the recorded
 * difference with its hold (`held_lower`, Q-13.6) and acknowledgement. Nothing here is a stock
 * movement: the ledger owns quantity.
 */
export const connectionStockLevels = pgTable(
  'connection_stock_levels',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    inventoryItemId: text('inventory_item_id').notNull(),
    targetQuantity: integer('target_quantity'),
    pushedQuantity: integer('pushed_quantity'),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    pushCommandId: uuid('push_command_id').references(() => outboundCommands.id, {
      onDelete: 'restrict',
    }),
    pushErrorCode: text('push_error_code'),
    shopifyQuantity: integer('shopify_quantity'),
    shopifySeenAt: timestamp('shopify_seen_at', { withTimezone: true }),
    differenceShopifyQuantity: integer('difference_shopify_quantity'),
    differenceTargetQuantity: integer('difference_target_quantity'),
    differenceSeenAt: timestamp('difference_seen_at', { withTimezone: true }),
    heldLower: boolean('held_lower').notNull().default(false),
    differenceAcknowledgedAt: timestamp('difference_acknowledged_at', { withTimezone: true }),
    differenceAcknowledgedBy: uuid('difference_acknowledged_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('connection_stock_levels_connection_variant_unique').on(t.connectionId, t.variantId),
    index('connection_stock_levels_variant_idx').on(t.variantId),
    index('connection_stock_levels_push_command_idx')
      .on(t.pushCommandId)
      .where(sql`${t.pushCommandId} IS NOT NULL`),
    index('connection_stock_levels_acknowledged_by_idx')
      .on(t.differenceAcknowledgedBy)
      .where(sql`${t.differenceAcknowledgedBy} IS NOT NULL`),
    // The open differences list, newest first.
    index('connection_stock_levels_open_differences_idx')
      .on(t.connectionId, t.differenceSeenAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.differenceSeenAt} IS NOT NULL AND ${t.differenceAcknowledgedAt} IS NULL`),
    check(
      'connection_stock_levels_difference_together',
      sql`(${t.differenceSeenAt} IS NULL) = (${t.differenceShopifyQuantity} IS NULL) AND (${t.differenceSeenAt} IS NULL) = (${t.differenceTargetQuantity} IS NULL)`,
    ),
    check(
      'connection_stock_levels_acknowledged_together',
      sql`(${t.differenceAcknowledgedAt} IS NULL) = (${t.differenceAcknowledgedBy} IS NULL)`,
    ),
    check(
      'connection_stock_levels_held_lower_is_lower',
      sql`NOT ${t.heldLower} OR (${t.differenceShopifyQuantity} IS NOT NULL AND ${t.differenceTargetQuantity} IS NOT NULL AND ${t.differenceShopifyQuantity} < ${t.differenceTargetQuantity})`,
    ),
    check('connection_stock_levels_push_error_code_shape', upperCodeShape(t.pushErrorCode)),
  ],
);
