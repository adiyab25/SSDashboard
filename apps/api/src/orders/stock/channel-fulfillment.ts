import type { FulfillmentState, OrderLineState, StockOutSource } from '@ssdashboard/contracts';

/** One quantity Shopify fulfilled, by its own line id (spec 0015 AC-28). */
export interface ChannelFulfilledLine {
  channelLineId: string;
  quantity: number;
}

/** An order line as the stock out checks read it. */
export interface StockOutCandidateLine {
  id: string;
  channelLineId: string | null;
  quantity: number;
  lineState: OrderLineState;
}

/**
 * Whether Shopify's fulfilled quantities differ from the order's open lines (spec 0013 AC-27 a):
 * the open lines summed per channel line id must equal the fulfilled quantities summed per Shopify
 * line id, exactly. An open line with no channel line id (added in the app) can never match, so it
 * counts as a difference; a fulfilled quantity of 0 counts as nothing. Pure.
 */
export function fulfilledLinesDiffer(
  lines: readonly StockOutCandidateLine[],
  fulfilled: readonly ChannelFulfilledLine[],
): boolean {
  const open = new Map<string, number>();
  for (const line of lines) {
    if (line.lineState !== 'open') continue;
    if (line.channelLineId === null) return true;
    open.set(line.channelLineId, (open.get(line.channelLineId) ?? 0) + line.quantity);
  }
  const shipped = new Map<string, number>();
  for (const line of fulfilled) {
    if (line.quantity <= 0) continue;
    shipped.set(line.channelLineId, (shipped.get(line.channelLineId) ?? 0) + line.quantity);
  }
  if (open.size !== shipped.size) return true;
  for (const [channelLineId, quantity] of open) {
    if (shipped.get(channelLineId) !== quantity) return true;
  }
  return false;
}

/**
 * The quantity a channel return puts on each order line's awaiting restock list (spec 0013 AC-27
 * d): each Shopify line's returned quantity is spread over the order lines carrying that channel
 * line id, in position order, each taking at most what it still may await (`stock_out_quantity`
 * less what already awaits, was restocked, or was closed; owner ruling 2026-11-21). Quantities
 * beyond that are dropped (every return caps at what was posted). Pure.
 */
export function returnedQuantitiesOf(
  lines: readonly {
    id: string;
    channelLineId: string | null;
    stockOutQuantity: number | null;
    awaitingRestockQuantity: number;
    restockedQuantity: number;
    closedQuantity: number;
  }[],
  returned: readonly ChannelFulfilledLine[],
): { lineId: string; quantity: number }[] {
  const room = new Map(
    lines.map((line) => [
      line.id,
      Math.max(
        (line.stockOutQuantity ?? 0) -
          line.awaitingRestockQuantity -
          line.restockedQuantity -
          line.closedQuantity,
        0,
      ),
    ]),
  );
  const out = new Map<string, number>();
  for (const back of returned) {
    let left = back.quantity;
    for (const line of lines) {
      if (left <= 0) break;
      if (line.channelLineId !== back.channelLineId) continue;
      const take = Math.min(left, room.get(line.id) ?? 0);
      if (take <= 0) continue;
      room.set(line.id, (room.get(line.id) ?? 0) - take);
      out.set(line.id, (out.get(line.id) ?? 0) + take);
      left -= take;
    }
  }
  return [...out].map(([lineId, quantity]) => ({ lineId, quantity }));
}

/**
 * Whether a carrier `shipped` fact exists for the order (spec 0013 AC-27 c): its fulfillment is
 * past the states a cancel allows (`shipped` and every state after it), or its current stock out
 * was requested by the carrier's `shipped` fact. A cancelled order the courier never picked up
 * stays `cancelled`; a late pickup moves it to `shipped`. Pure.
 */
export function carrierShippedFactExists(order: {
  fulfillmentState: FulfillmentState;
  stockOutSource: StockOutSource | null;
}): boolean {
  if (order.stockOutSource === 'carrier_shipped') return true;
  switch (order.fulfillmentState) {
    case 'new':
    case 'confirmed':
    case 'packed':
    case 'cancelled':
      return false;
    case 'shipped':
    case 'failed_attempt':
    case 'delivered':
    case 'partially_delivered':
    case 'refused':
    case 'returned_to_origin':
    case 'lost':
    case 'exchanged':
      return true;
  }
}
