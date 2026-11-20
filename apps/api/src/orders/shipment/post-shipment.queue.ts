import type { SendOptions } from 'pg-boss';
import { z } from 'zod';
import { defineQueue } from '../../platform/jobs/job-declarations.js';

/**
 * The retry policy of every `orders.post_shipment` job (spec 0013 AC-24): pg-boss retries a failed
 * job `retryLimit` times with exponential backoff from `retryDelay` seconds, each wait capped at
 * `retryDelayMax`. The last attempt that still fails for a reason other than stock raises
 * `shipment_not_posted` instead of throwing (a posting is never refused for stock, so a failure is
 * a fault: the database, a lock wait, a SKU the carrier cannot name). Sent with every job too, so a
 * queue created by an earlier build with other options still retries this way.
 */
export const POST_SHIPMENT_RETRY = Object.freeze({
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
});

/**
 * The one pg-boss queue of the order's stock out jobs (spec 0013 *Configuration required*), owned
 * by the core capability `orders.shipment_posting` (`windDown: none`). It carries the shipment
 * posting (`post`), the after cancel job (`after_cancel`), and the fulfillment reversal
 * (`fulfillment_reversal`), each with the order's stock out generation, and the daily awaiting
 * restock check (`awaiting_restock_overdue`, its own schedule). Every order job is sent in its
 * order's group (`orderGroup`) and the worker takes a group concurrency of 1, so at most one job
 * per order runs at a time across every worker process.
 */
export const POST_SHIPMENT_QUEUE = defineQueue({
  name: 'orders.post_shipment',
  capability: 'orders.shipment_posting',
  options: { ...POST_SHIPMENT_RETRY, expireInSeconds: 300 },
  work: { groupConcurrency: 1 },
});

/** Who cancelled the order an after cancel job follows (the `OrderCancelled` origin). */
export const CancelOrigin = z.enum(['person', 'channel', 'carrier']);
/** One cancel origin. */
export type CancelOrigin = z.infer<typeof CancelOrigin>;

/**
 * The data of a job on `orders.post_shipment`, besides the `capability` stamp `JobSender` adds:
 * ids, a generation, and codes only, never personal data.
 *
 * - `post`: book generation `generation`'s `order_shipment` (AC-24).
 * - `after_cancel`: decide what a cancel does to generation `generation`'s posting, by the
 *   *After a cancel* table (AC-27 b); `origin` and `reasonCode` are the cancel's.
 * - `fulfillment_reversal`: reverse generation `generation`'s posting because every Shopify
 *   fulfillment of the order was cancelled (AC-27 c).
 * - `awaiting_restock_overdue`: the daily check that raises `awaiting_restock_overdue` (AC-27 g).
 */
export const PostShipmentJobData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('post'),
    orderId: z.uuid(),
    generation: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal('after_cancel'),
    orderId: z.uuid(),
    generation: z.number().int().min(1),
    origin: CancelOrigin,
    reasonCode: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('fulfillment_reversal'),
    orderId: z.uuid(),
    generation: z.number().int().min(1),
  }),
  z.object({ kind: z.literal('awaiting_restock_overdue') }),
]);
/** The parsed PostShipmentJobData. */
export type PostShipmentJobData = z.infer<typeof PostShipmentJobData>;

/** The send options of an order's stock out job: its order's group and the retry policy. */
export function orderGroup(orderId: string): SendOptions {
  return { ...POST_SHIPMENT_RETRY, group: { id: orderId.toLowerCase() } };
}

/** The key of the after cancel reversal of generation `generation` (the *After a cancel* table, row 4). */
export function cancelReversalKey(orderId: string, generation: number): string {
  return `order_shipment_reversal:${orderId}:${generation}`;
}

/** The key of the fulfillment reversal of generation `generation` (AC-27 c), read by row 2. */
export function fulfillmentReversalKey(orderId: string, generation: number): string {
  return `order_shipment_fulfillment_reversal:${orderId}:${generation}`;
}

/** The key of the daily awaiting restock check's schedule (spec 0013 *Configuration required*). */
export const AWAITING_RESTOCK_OVERDUE_SCHEDULE = 'orders-awaiting-restock-overdue';

/**
 * When the daily awaiting restock check runs, in the install `timezone`: 06:00, after the usual
 * operating day cutoff, so it counts whole operating days.
 */
export const AWAITING_RESTOCK_OVERDUE_CRON = '0 6 * * *';

/** How many operating days a line awaits restock before `awaiting_restock_overdue` (AC-27 g). */
export const AWAITING_RESTOCK_OVERDUE_DAYS = 10;
