import { z } from 'zod';
import { defineQueue } from '../../platform/jobs/job-declarations.js';

/**
 * The one pg-boss queue of every Shopify job (spec 0015, *Inbound processing* item 2), owned by
 * the core capability `connectors.shopify.sync`. Each job is sent in its connection's group
 * (`connectionGroup`) and the worker takes a group concurrency of 1, so at most one job per
 * connection runs at a time across every worker process. A transient Shopify failure throws, and
 * pg-boss retries with backoff (5 times, from 30 seconds); every job ends well within its expiry.
 */
export const CONNECTOR_SHOPIFY_QUEUE = defineQueue({
  name: 'connector-shopify',
  capability: 'connectors.shopify.sync',
  options: { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
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

/** The send options of a job for one connection: its group, so jobs of one connection never overlap. */
export function connectionGroup(connectionId: string): { group: { id: string } } {
  return { group: { id: connectionId } };
}
