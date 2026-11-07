import { z } from 'zod';

/** The connectors module's closed lists, matching the database enums of the same meaning (spec 0015 data model). */

/** How well a connection works. Matches `connections.health`. */
export const ConnectionHealth = z.enum(['connecting', 'ok', 'degraded', 'failing']);
/** One ConnectionHealth value. */
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

/** What an outbound command is about. Matches `outbound_commands.linked_type`. */
export const OutboundLinkedType = z.enum([
  'order',
  'customer',
  'variant',
  'exchange',
  'refund',
  'connection',
]);
/** One OutboundLinkedType value. */
export type OutboundLinkedType = z.infer<typeof OutboundLinkedType>;

/** Where an inbox event came from. Matches `inbound_events.source`. */
export const InboundSource = z.enum(['webhook', 'sweep', 'backfill', 'reconcile']);
/** One InboundSource value. */
export type InboundSource = z.infer<typeof InboundSource>;

/** What an inbox event is about. Matches `inbound_events.subject_type`. */
export const InboundSubject = z.enum([
  'order',
  'product',
  'customer',
  'inventory_level',
  'app',
  'bulk_operation',
]);
/** One InboundSubject value. */
export type InboundSubject = z.infer<typeof InboundSubject>;

/** Where an inbox event stands. Matches `inbound_events.status`. */
export const InboundStatus = z.enum([
  'received',
  'processed',
  'ignored',
  'ignored_unlicensed',
  'echo',
  'failed',
]);
/** One InboundStatus value. */
export type InboundStatus = z.infer<typeof InboundStatus>;

/** What an external id maps. Matches `connection_external_ids.entity`. */
export const ExternalEntity = z.enum(['product', 'variant', 'order']);
/** One ExternalEntity value. */
export type ExternalEntity = z.infer<typeof ExternalEntity>;

/** What a sync run did. Matches `connection_sync_runs.kind`. */
export const SyncRunKind = z.enum([
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
/** One SyncRunKind value. */
export type SyncRunKind = z.infer<typeof SyncRunKind>;

/** How a sync run ended. Matches `connection_sync_runs.status`. */
export const SyncRunStatus = z.enum(['running', 'succeeded', 'partial', 'failed']);
/** One SyncRunStatus value. */
export type SyncRunStatus = z.infer<typeof SyncRunStatus>;
