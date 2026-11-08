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

/**
 * The data of a job on `connector-shopify`, besides the `capability` stamp `JobSender` adds: the
 * job kind, the connection id, and for an inbox job the inbox event id. Never a credential, a
 * token, or any shop data (AC-2). Task 6 has the `connect` kind, task 7 the `inbox` kind (one
 * verified webhook's event, read back and applied by `InboxJob`); later tasks add theirs here.
 */
export const ShopifyJobData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connect'), connectionId: z.uuid() }),
  z.object({ kind: z.literal('inbox'), connectionId: z.uuid(), eventId: z.uuid() }),
]);
/** The parsed ShopifyJobData. */
export type ShopifyJobData = z.infer<typeof ShopifyJobData>;

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
