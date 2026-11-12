import { z } from 'zod';
import { LocalizedText } from '../localized-text.js';

/**
 * The back office freshness line (spec 0015 AC-8, AC-18, *Connection screen and freshness line*):
 * `GET /api/connections/freshness`, read by the shell once a minute for every hat with
 * `orders.view`. One entry per active connection. Ids, times, and counts only: never a credential,
 * a customer's data, or provider text.
 */

/** A UTC instant as the api issues it (microseconds, `Z`). */
const Instant = z.iso.datetime({ offset: true });

/**
 * How fresh one connection is (spec 0015 *Value sourcing*, freshness rows):
 * - `failing`: the connection's health is `failing` (keys refused, app not installed, and the
 *   other `failing` codes); this wins over `late`.
 * - `late`: the connection is live (its first backfill finished, so it has an orders sweep
 *   watermark) and its last successful orders sweep is older than 15 minutes, or it never had one.
 * - `fresh`: anything else, including a connection still being set up (no backfill finished yet),
 *   which has no sweep to be late on.
 *
 * The shell line turns to its warning ("tell the manager") on `late`, `failing`, or a count above
 * 0; that rule is the screen's, from these fields.
 */
export const ConnectionFreshnessState = z.enum(['fresh', 'late', 'failing']);
/** One ConnectionFreshnessState value. */
export type ConnectionFreshnessState = z.infer<typeof ConnectionFreshnessState>;

/** The minutes after which a live connection's last successful orders sweep is `late` (AC-18). */
export const FRESHNESS_LATE_AFTER_MINUTES = 15;

/** One active connection on the freshness line. */
export const ConnectionFreshnessItem = z.object({
  /** The connection's id (`connections.id`). */
  connectionId: z.uuid(),
  /**
   * The store's public name in both languages (`ChannelsService`, the store's `public_name`): the
   * screen shows the user's language and falls back to the other. Empty when the connection has
   * no store.
   */
  storePublicName: LocalizedText,
  /** When the connection last applied a new order (`connections.last_order_at`), or null. */
  lastOrderAt: Instant.nullable(),
  /** When its last orders sweep succeeded (`connections.last_sweep_at`), or null. */
  lastSweepAt: Instant.nullable(),
  /**
   * Its outbound commands in `failed` (`outbound_commands.sync_state = 'failed'`): "N Shopify
   * writes failed". 0 until the outbound framework (spec 0015 milestone 3) writes commands.
   */
  failedCommands: z.number().int().nonnegative(),
  /**
   * Its Shopify orders whose latest inbox event is `failed` (AC-8): "N orders failed to arrive". An
   * order counts once, however many of its events failed, and stops counting once a later event
   * of it (a sweep retry, a new webhook) is applied.
   */
  failedOrderEvents: z.number().int().nonnegative(),
  /** `fresh`, `late`, or `failing` (see `ConnectionFreshnessState`). */
  state: ConnectionFreshnessState,
});
/** The parsed ConnectionFreshnessItem. */
export type ConnectionFreshnessItem = z.infer<typeof ConnectionFreshnessItem>;

/**
 * `GET /api/connections/freshness` (`orders.view`): every active connection, oldest first, and the
 * server's instant the answer was read at, so the screen computes "N minutes ago" against the
 * server's clock rather than the browser's.
 */
export const ConnectionFreshnessResponse = z.object({
  /** The server instant the answer was read at. */
  asOf: Instant,
  /** One entry per active connection, ordered by connection creation. */
  items: z.array(ConnectionFreshnessItem),
});
/** The parsed ConnectionFreshnessResponse. */
export type ConnectionFreshnessResponse = z.infer<typeof ConnectionFreshnessResponse>;
