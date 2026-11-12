import { z } from 'zod';
import { defineQueue } from '../../platform/jobs/job-declarations.js';

/**
 * The retry policy of every Shopify job (spec 0015 AC-8, code review M1): pg-boss retries a
 * failed job `retryLimit` times with exponential backoff from `retryDelay` seconds, each wait
 * capped at `retryDelayMax`. pg-boss draws a wait after the n-th failure (n from 0) from
 * `[retryDelay * 2^n, retryDelay * 2^(n+1)]`, capped, so the shortest possible window is
 * 30 + 60 + 120 + 240 + 480 + 12 * 900 = 11,730 seconds (3 h 15 min 30 s): longer than the 3 hours
 * after which a connection's reads count as failing (`READS_FAILING`), so the last retry of a read
 * that kept failing always meets that rule. Sent with every job too (`connectionGroup`), so a
 * queue created by an earlier build with other options still retries this way.
 */
export const CONNECTOR_SHOPIFY_RETRY = Object.freeze({
  retryLimit: 17,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
});

/** The shortest retry window `CONNECTOR_SHOPIFY_RETRY` allows, in seconds (see there). */
export function shortestRetryWindowSeconds(retry: typeof CONNECTOR_SHOPIFY_RETRY): number {
  let total = 0;
  for (let n = 0; n < retry.retryLimit; n += 1) {
    total += Math.min(retry.retryDelayMax, retry.retryDelay * 2 ** Math.min(16, n));
  }
  return total;
}

/**
 * The one pg-boss queue of every Shopify job (spec 0015, *Inbound processing* item 2), owned by
 * the core capability `connectors.shopify.sync`. Each job is sent in its connection's group
 * (`connectionGroup`) and the worker takes a group concurrency of 1, so at most one job per
 * connection runs at a time across every worker process (pg-boss enforces the group limit in its
 * fetch query, server side). A transient Shopify failure throws, and pg-boss retries it by
 * `CONNECTOR_SHOPIFY_RETRY` (over 3 h 15 min); every attempt ends well within its expiry.
 */
export const CONNECTOR_SHOPIFY_QUEUE = defineQueue({
  name: 'connector-shopify',
  capability: 'connectors.shopify.sync',
  options: { ...CONNECTOR_SHOPIFY_RETRY, expireInSeconds: 300 },
  work: { groupConcurrency: 1 },
});

/** The capability that owns the inbox purge schedule on the shared queue (spec 0009, 0015). */
export const CONNECTORS_INBOX_CAPABILITY = 'connectors.inbox';

/**
 * The data of a job on `connector-shopify`, besides the `capability` stamp `JobSender` adds: the
 * job kind, and for a connection's own job its id (and the run and step it continues). Never a
 * credential, a token, a bulk result address, or any shop data (AC-2).
 *
 * - `connect` (task 6) and `inbox` (task 7, one inbox event, read back and applied by `InboxJob`).
 * - The scheduled kinds of task 12, which carry no connection: `orders_sweep_tick`,
 *   `products_sweep_tick`, and `hourly_check_tick` fan out one job per live connection;
 *   `inbox_purge` (capability `connectors.inbox`) deletes old inbox rows and sync runs.
 * - A connection's task 12 jobs: `sweep_orders` and `sweep_products` (a new sweep, or with `runId`
 *   and `step` the continuation of a partial one), `hourly_check`, and `gateway_scan` and
 *   `backfill` (always a run and the step that run expects next: a job whose step the run has
 *   moved past is a duplicate and is skipped).
 */
export const ShopifyJobData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connect'), connectionId: z.uuid() }),
  z.object({ kind: z.literal('inbox'), connectionId: z.uuid(), eventId: z.uuid() }),
  z.object({ kind: z.literal('orders_sweep_tick') }),
  z.object({ kind: z.literal('products_sweep_tick') }),
  z.object({ kind: z.literal('hourly_check_tick') }),
  z.object({ kind: z.literal('inbox_purge') }),
  z.object({
    kind: z.literal('sweep_orders'),
    connectionId: z.uuid(),
    runId: z.uuid().optional(),
    step: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('sweep_products'),
    connectionId: z.uuid(),
    runId: z.uuid().optional(),
    step: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('hourly_check'), connectionId: z.uuid() }),
  z.object({
    kind: z.literal('gateway_scan'),
    connectionId: z.uuid(),
    runId: z.uuid(),
    step: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('backfill'),
    connectionId: z.uuid(),
    runId: z.uuid(),
    step: z.number().int().nonnegative(),
  }),
]);
/** The parsed ShopifyJobData. */
export type ShopifyJobData = z.infer<typeof ShopifyJobData>;

/** One kind of `ShopifyJobData`. */
export type ShopifyJobKind = ShopifyJobData['kind'];

/** The sweep jobs' pg-boss priority (spec 0015 Inbound processing item 2). */
export const SWEEP_JOB_PRIORITY = 10;

/** The backfill and gateway scan jobs' pg-boss priority (spec 0015 Inbound processing item 2). */
export const BACKFILL_JOB_PRIORITY = 0;

/**
 * One keyed cron schedule of the connectors module on `connector-shopify` (spec 0009 *Connector
 * jobs and the shared queue*; spec 0015 *Settings requested from feature 9*, jobs row). The
 * `ModuleJobSupervisor` registers each in the install `timezone` while its capability runs; every
 * schedule has its own `key`, so the supervisor can remove one capability's schedules without
 * stopping the queue.
 */
export interface ConnectorSchedule {
  /** The schedule's own key on the queue. */
  readonly key: string;
  /** The capability it serves. */
  readonly capability: string;
  /** Its cron, read in the install time zone. */
  readonly cron: string;
  /** The data each scheduled job starts with (its kind). */
  readonly data: { readonly kind: ShopifyJobKind };
}

/**
 * The four schedules of spec 0015 task 12 (spec 0009's table): the orders sweep every 5 minutes,
 * the products sweep every 30 minutes, and the hourly check, under `connectors.shopify.sync`; the
 * inbox purge at 04:00 under `connectors.inbox`. The stock schedules (`shopify-stock-push`,
 * `shopify-stock-reconcile`) join with milestone 3.
 */
export const CONNECTOR_SCHEDULES: readonly ConnectorSchedule[] = Object.freeze([
  {
    key: 'shopify-orders-sweep',
    capability: 'connectors.shopify.sync',
    cron: '*/5 * * * *',
    data: { kind: 'orders_sweep_tick' },
  },
  {
    key: 'shopify-products-sweep',
    capability: 'connectors.shopify.sync',
    cron: '*/30 * * * *',
    data: { kind: 'products_sweep_tick' },
  },
  {
    key: 'shopify-hourly-check',
    capability: 'connectors.shopify.sync',
    cron: '0 * * * *',
    data: { kind: 'hourly_check_tick' },
  },
  {
    key: 'connector-inbox-purge',
    capability: CONNECTORS_INBOX_CAPABILITY,
    cron: '0 4 * * *',
    data: { kind: 'inbox_purge' },
  },
]);

/** The pg-boss priority of an inbox event job (spec 0015 Inbound processing item 2). */
export const INBOX_JOB_PRIORITY = 20;

/**
 * The send options of a job for one connection: its group, so jobs of one connection never
 * overlap, and the retry policy (`CONNECTOR_SHOPIFY_RETRY`), so the job retries by it even on a
 * queue an earlier build created with other options.
 */
export function connectionGroup(
  connectionId: string,
): { group: { id: string } } & typeof CONNECTOR_SHOPIFY_RETRY {
  return { group: { id: connectionId }, ...CONNECTOR_SHOPIFY_RETRY };
}
