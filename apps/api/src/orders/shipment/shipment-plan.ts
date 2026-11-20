import {
  Money,
  UnitCost,
  type CarrierShipmentLine,
  type FulfillmentState,
  type PostedMovement,
  type StockOutSource,
} from '@ssdashboard/contracts';
import type { CancelOrigin } from './post-shipment.queue.js';

/** One order line a stock out request covers: what the shipment job reads (AC-24). */
export interface StockOutLine {
  id: string;
  /** Null while the line is unmapped: it is skipped with `shipped_with_unmapped_lines`. */
  variantId: string | null;
  /** The line's `stock_out_quantity`, above 0. */
  quantity: number;
}

/** A line's active reservation, as the ledger answers it. */
export interface HeldReservation {
  sourceLineId: string;
  reservationId: string;
  locationId: string;
}

/** What the catalog says of a SKU: whether it holds stock at all. */
export interface SkuKind {
  kind: string;
}

/** The posting the job builds from the order's lines, and the lines it leaves out and why. */
export interface ShipmentPlan {
  /** The lines of the `order_shipment`, in the order's line order. */
  post: CarrierShipmentLine[];
  /** Lines with no variant: skipped, raising `shipped_with_unmapped_lines`. */
  unmapped: string[];
  /** Lines with no reservation and no online location: skipped, raising `shipment_not_posted`. */
  unlocated: string[];
}

/**
 * Builds the shipment posting from the order's stock out lines (spec 0013 AC-24: from the order's
 * lines, never from the source): each mapped line whose SKU holds stock posts its
 * `stock_out_quantity` at the location of its active reservation (naming it, so it is fulfilled
 * first), else at the online location. A line whose SKU holds no stock (not of the `stocked` kind)
 * is left out, as it was never reserved or short (AC-13). An unmapped line and a line with nowhere
 * to post from are left out and reported. Pure.
 */
export function planShipment(
  lines: readonly StockOutLine[],
  reservations: readonly HeldReservation[],
  skus: ReadonlyMap<string, SkuKind>,
  onlineLocationId: string | null,
): ShipmentPlan {
  const heldBy = new Map(reservations.map((held) => [held.sourceLineId.toLowerCase(), held]));
  const plan: ShipmentPlan = { post: [], unmapped: [], unlocated: [] };
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    if (line.variantId === null) {
      plan.unmapped.push(line.id);
      continue;
    }
    if (skus.get(line.variantId)?.kind !== 'stocked') continue;
    const held = heldBy.get(line.id.toLowerCase());
    const locationId = held?.locationId ?? onlineLocationId;
    if (locationId === null) {
      plan.unlocated.push(line.id);
      continue;
    }
    plan.post.push({
      sourceLineId: line.id,
      variantId: line.variantId,
      locationId,
      quantity: line.quantity,
      ...(held ? { reservationId: held.reservationId } : {}),
    });
  }
  return plan;
}

/**
 * The `unit_cost` of each posted line from the posting's movements, by `sourceLineId` (spec 0013
 * Value sourcing, shipment job): the movement's own unit cost, or, when one line has two
 * movements, their total cost over their quantity, rounded to 4 decimals (the ledger's average
 * rule). Pure.
 */
export function unitCostsOf(
  movements: readonly Pick<
    PostedMovement,
    'sourceLineId' | 'quantity' | 'unitCost' | 'totalCost'
  >[],
): Map<string, string> {
  const byLine = new Map<
    string,
    { total: Money; quantity: number; unitCost: string; count: number }
  >();
  for (const movement of movements) {
    if (movement.sourceLineId === null) continue;
    const seen = byLine.get(movement.sourceLineId);
    const total = Money.of(movement.totalCost);
    const absolute = total.sign() < 0 ? total.negate() : total;
    byLine.set(movement.sourceLineId, {
      total: (seen?.total ?? Money.zero).plus(absolute),
      quantity: (seen?.quantity ?? 0) + Math.abs(movement.quantity),
      unitCost: movement.unitCost,
      count: (seen?.count ?? 0) + 1,
    });
  }
  const costs = new Map<string, string>();
  for (const [lineId, line] of byLine) {
    costs.set(
      lineId,
      line.count === 1
        ? UnitCost.of(line.unitCost).toString()
        : UnitCost.perUnit(line.total, line.quantity).toString(),
    );
  }
  return costs;
}

/** What the after cancel job reads before it decides (spec 0013 *After a cancel*). */
export interface AfterCancelFacts {
  /** The generation the job was enqueued for. */
  jobGeneration: number;
  /** The order's generation as the job runs. */
  orderGeneration: number;
  /** Something is posted under generation `jobGeneration`'s key. */
  posted: boolean;
  /** That posting is already reversed (by either reversal key). */
  reversed: boolean;
  fulfillmentState: FulfillmentState;
  origin: CancelOrigin;
  reasonCode: string;
  stockOutSource: StockOutSource | null;
}

/** The decision of the after cancel job: one row of the *After a cancel* table. */
export type AfterCancelDecision =
  | { row: 1 | 2 | 3; then: 'nothing' }
  | { row: 4; then: 'reverse' }
  | { row: 5; then: 'await_restock' }
  | { row: 6; then: 'fault' };

/** The carrier's reason for a delivery cancelled or terminated before any pickup. */
export const TERMINATED_BEFORE_PICKUP = 'carrier.terminated_before_pickup';

/**
 * Decides what a cancel does to a posting by the ordered *After a cancel* table of spec 0013
 * (AC-27 b): the first row that matches wins. Pure; a stock out request cleared while a posting
 * stands is not a case the table lists and answers row 1's nothing.
 */
export function decideAfterCancel(facts: AfterCancelFacts): AfterCancelDecision {
  if (facts.orderGeneration !== facts.jobGeneration || !facts.posted) {
    return { row: 1, then: 'nothing' };
  }
  if (facts.reversed) return { row: 2, then: 'nothing' };
  if (facts.fulfillmentState !== 'cancelled') return { row: 3, then: 'nothing' };
  if (facts.origin === 'carrier' && facts.reasonCode === TERMINATED_BEFORE_PICKUP) {
    return { row: 4, then: 'reverse' };
  }
  switch (facts.stockOutSource) {
    case 'shopify_fulfillment':
    case 'pick_pack_ship':
      return { row: 5, then: 'await_restock' };
    case 'carrier_shipped':
      return { row: 6, then: 'fault' };
    case null:
      return { row: 1, then: 'nothing' };
  }
}
