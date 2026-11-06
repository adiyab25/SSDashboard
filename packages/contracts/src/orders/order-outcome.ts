import { z } from 'zod';
import { Money } from '../money.js';
import type { FulfillmentState, OrderLineState } from './order-states.js';

/** How an order ended up, for every report. Matches the `orders.outcome` enum. */
export const OrderOutcome = z.enum([
  'open',
  'kept',
  'cancelled_before_shipping',
  'failed_delivery',
  'refunded',
  'partially_refunded',
]);
/** One order outcome. */
export type OrderOutcome = z.infer<typeof OrderOutcome>;

/** What `deriveOrderOutcome` reads. Amounts are `numeric` text in EGP. */
export interface OrderOutcomeInput {
  fulfillmentState: FulfillmentState;
  /** Gross of the lines delivered at the door (see `deliveredAmountOf`). */
  deliveredAmount: string;
  /** Return credits posted on this order's lines. */
  returnedCreditAmount: string;
  /** Credit consumed by replacement orders whose original is this order, net of releases. */
  exchangeConsumedAmount: string;
}

/**
 * `refunded = max(0, returned credit − exchange consumed)`: credit spent on this order's own
 * exchange is not a refund. Returns the 2 decimal text.
 */
export function refundedAmountOf(
  input: Pick<OrderOutcomeInput, 'returnedCreditAmount' | 'exchangeConsumedAmount'>,
): string {
  const refunded = Money.of(input.returnedCreditAmount).minus(
    Money.of(input.exchangeConsumedAmount),
  );
  return (refunded.sign() < 0 ? Money.zero : refunded).toString();
}

/**
 * The only place an order's outcome is computed (spec 0002 "The derived outcome"). A total,
 * exhaustive switch over the fulfillment state: delivered style orders are `kept` until something
 * is refunded, `partially_refunded` below the delivered amount, `refunded` at or above it. Must
 * never be bypassed by setting `orders.outcome` directly.
 */
export function deriveOrderOutcome(input: OrderOutcomeInput): OrderOutcome {
  switch (input.fulfillmentState) {
    case 'cancelled':
      return 'cancelled_before_shipping';
    case 'new':
    case 'confirmed':
    case 'packed':
    case 'shipped':
    case 'failed_attempt':
      return 'open';
    case 'refused':
    case 'returned_to_origin':
    case 'lost':
      return 'failed_delivery';
    case 'delivered':
    case 'partially_delivered':
    case 'exchanged': {
      const refunded = Money.of(refundedAmountOf(input));
      if (refunded.isZero()) return 'kept';
      const delivered = Money.of(input.deliveredAmount);
      return refunded.cents >= delivered.cents ? 'refunded' : 'partially_refunded';
    }
    default: {
      const unreachable: never = input.fulfillmentState;
      return unreachable;
    }
  }
}

/** The part of a line `deliveredAmountOf` needs. */
export interface DeliveredLine {
  lineState: OrderLineState;
  grossAmount: string;
}

/**
 * `delivered_amount`: the gross of lines delivered at the door, which is `delivered` plus
 * `returned` (a line returned after delivery was still delivered and paid for), never
 * `returned_to_origin`, `lost`, `cancelled`, or `open`. So returning one of two delivered pieces
 * leaves the denominator at both.
 */
export function deliveredAmountOf(lines: readonly DeliveredLine[]): string {
  let total = Money.zero;
  for (const line of lines) {
    if (line.lineState === 'delivered' || line.lineState === 'returned') {
      total = total.plus(Money.of(line.grossAmount));
    }
  }
  return total.toString();
}
