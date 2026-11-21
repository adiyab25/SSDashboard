import {
  EgyptianPhone,
  InvalidPhone,
  type NormalizedPhone,
  type OrderListQuery,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { pgArray } from '../../database/sql.js';
import {
  InvalidCursorError,
  decodeKeyset,
  decodeTimeIdKeyset,
  encodeKeyset,
} from '../../platform/keyset-cursor.js';

/** A timestamp as the api issues it: UTC with microseconds, so a keyset cursor never loses precision. */
export const MICRO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The phone a search text is, or null when the text is not a phone `EgyptianPhone` reads. */
export function phoneOfSearch(text: string): NormalizedPhone | null {
  try {
    return EgyptianPhone.parse(text);
  } catch (error) {
    if (error instanceof InvalidPhone) return null;
    throw error;
  }
}

/** What the filters need beyond the query itself: ids the orders module cannot read from its own tables. */
export interface ListLookups {
  /** Every id of the filtered customer, or null when no customer filter applies. */
  customerIds: string[] | null;
  /** The phone searched in E.164, or null. */
  phone: string | null;
  /** Every id of the customer holding the searched phone, or an empty list. */
  phoneCustomerIds: string[];
}

/**
 * The `WHERE` of the order list (spec 0013 AC-4): one condition per filter, each an equality,
 * `ANY`, or range the list indexes serve (`orders_store_placed_idx`, `orders_placed_idx`,
 * `orders_fulfillment_placed_idx`, `orders_customer_idx`, `orders_ship_to_phone_idx`,
 * `orders_ship_to_phone_alt_idx`, `orders_order_number_idx`, `orders_write_back_idx`,
 * `order_lines_short_idx`, `order_lines_awaiting_restock_idx`), plus the keyset condition on
 * (`placed_at`, `id`) for the page after `cursor`, except for the awaiting restock filter, whose
 * own order and keyset `awaitingOrder` adds. Throws `InvalidCursorError` for a cursor this
 * endpoint did not issue.
 */
export function listWhere(query: OrderListQuery, lookups: ListLookups): SQL {
  const parts: SQL[] = [];
  if (query.storeId) parts.push(sql`o.store_id = ${query.storeId}::uuid`);
  if (query.channelId) parts.push(sql`o.channel_id = ${query.channelId}::uuid`);
  if (lookups.customerIds) {
    parts.push(sql`o.customer_id = ANY(${pgArray(lookups.customerIds)}::uuid[])`);
  }
  if (query.fulfillment) {
    parts.push(
      sql`o.fulfillment_state = ANY(${pgArray(query.fulfillment)}::order_fulfillment_state[])`,
    );
  }
  if (query.cash) parts.push(sql`o.cash_state = ANY(${pgArray(query.cash)}::order_cash_state[])`);
  if (query.outcome) parts.push(sql`o.outcome = ${query.outcome}::order_outcome`);
  if (query.type) parts.push(sql`o.type = ${query.type}::order_type`);
  if (query.hold === true) parts.push(sql`o.write_back_state <> 'none'`);
  if (query.hold === false) parts.push(sql`o.write_back_state = 'none'`);
  if (query.short === true) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM order_lines sl WHERE sl.order_id = o.id AND sl.short_quantity > 0)`,
    );
  }
  if (query.short === false) {
    parts.push(
      sql`NOT EXISTS (SELECT 1 FROM order_lines sl WHERE sl.order_id = o.id AND sl.short_quantity > 0)`,
    );
  }
  if (query.awaitingRestock === true) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM order_lines al WHERE al.order_id = o.id AND al.awaiting_restock_quantity > 0)`,
    );
  }
  if (query.awaitingRestock === false) {
    parts.push(
      sql`NOT EXISTS (SELECT 1 FROM order_lines al WHERE al.order_id = o.id AND al.awaiting_restock_quantity > 0)`,
    );
  }
  if (query.dayFrom) parts.push(sql`o.operating_day >= ${query.dayFrom}::date`);
  if (query.dayTo) parts.push(sql`o.operating_day <= ${query.dayTo}::date`);
  if (query.q !== undefined) parts.push(searchCondition(query.q, lookups));
  if (query.cursor && query.awaitingRestock !== true) {
    const { at, id } = decodeTimeIdKeyset(query.cursor);
    parts.push(sql`(o.placed_at, o.id) < (${at}::timestamptz, ${id}::uuid)`);
  }
  return parts.length ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;
}

/** The sort key of an order in the awaiting restock filter (spec 0013 AC-27 g). */
export interface AwaitingKey {
  /** 0 for a cancelled order (its lines come first), 1 otherwise. */
  rank: 0 | 1;
  /** The oldest awaiting line's `awaiting_restock_since`, microsecond UTC text. */
  since: string;
  id: string;
}

/** The cursor of the awaiting restock filter: the last row's (rank, since, id). */
export function encodeAwaitingCursor(key: AwaitingKey): string {
  return encodeKeyset([String(key.rank), key.since, key.id]);
}

/**
 * Decodes an awaiting restock cursor, or throws `InvalidCursorError` (400): the rank must be 0 or
 * 1 and the rest a (timestamp, id) pair `decodeTimeIdKeyset` accepts.
 */
export function decodeAwaitingCursor(cursor: string): AwaitingKey {
  const [rank, since, id] = decodeKeyset(cursor, 3);
  if ((rank !== '0' && rank !== '1') || !since || !id) throw new InvalidCursorError();
  const pair = decodeTimeIdKeyset(encodeKeyset([since, id]));
  return { rank: rank === '0' ? 0 : 1, since: pair.at, id: pair.id };
}

/**
 * The order of the awaiting restock filter (spec 0013 AC-27 g): the orders cancelled with pieces
 * expected back first (an order cancelled with no carrier delivery: feature 19's `shipments` table
 * does not exist yet, so every cancelled order counts), then the oldest awaiting line first, then
 * the id; with the keyset condition for the page after `cursor`. Reads the derived columns
 * `awaiting_rank` and `awaiting_since_at` of the list's inner select.
 */
export function awaitingOrder(cursor: string | undefined): { after: SQL; order: SQL } {
  const order = sql`ORDER BY x.awaiting_rank, x.awaiting_since_at, x.id`;
  if (!cursor) return { after: sql``, order };
  const key = decodeAwaitingCursor(cursor);
  return {
    after: sql`WHERE (x.awaiting_rank, x.awaiting_since_at, x.id) > (${key.rank}::int, ${key.since}::timestamptz, ${key.id}::uuid)`,
    order,
  };
}

/**
 * The search box (AC-4): a phone matches the order's main or second ship to phone or any phone of
 * its customer; any other text matches an order number in every store, `1001` finding `#1001`.
 */
function searchCondition(text: string, lookups: ListLookups): SQL {
  if (lookups.phone !== null) {
    const byCustomer = lookups.phoneCustomerIds.length
      ? sql` OR o.customer_id = ANY(${pgArray(lookups.phoneCustomerIds)}::uuid[])`
      : sql``;
    return sql`(o.ship_to_phone = ${lookups.phone} OR o.ship_to_phone_alt = ${lookups.phone}${byCustomer})`;
  }
  return sql`o.order_number IN (${text}, ${`#${text}`})`;
}
