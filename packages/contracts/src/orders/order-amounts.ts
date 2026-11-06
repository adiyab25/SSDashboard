import { InvalidAmountError, Money } from '../money.js';
import type { OrderLineState } from './order-states.js';

/** The part of a line that allocation and totals need. Amounts are `numeric` text in EGP. */
export interface AmountLine {
  position: number;
  lineState: OrderLineState;
  grossAmount: string;
}

/** What `allocatePayments` reads. */
export interface AllocationInput {
  lines: readonly AmountLine[];
  shippingChargedAmount: string;
  /** The order's `prepaid_amount`. */
  prepaidAmount: string;
  /** The order's `credit_applied_amount`. */
  creditAppliedAmount: string;
}

/** One line's share of the order's prepayment and credit (`order_lines.prepaid_amount`, `credit_applied_amount`). */
export interface LineShare {
  position: number;
  prepaidAmount: string;
  creditAppliedAmount: string;
}

/** The shares of every line (in position order) and of shipping. */
export interface AllocationResult {
  lines: LineShare[];
  shippingPrepaidAmount: string;
  shippingCreditAppliedAmount: string;
}

/** `lines_gross_amount`: the sum of `gross_amount` over lines that are not `cancelled`. */
export function linesGrossAmountOf(lines: readonly AmountLine[]): string {
  return sumGross(lines).toString();
}

function sumGross(lines: readonly AmountLine[]): Money {
  let total = Money.zero;
  for (const line of lines) {
    if (line.lineState !== 'cancelled') total = total.plus(Money.of(line.grossAmount));
  }
  return total;
}

/** What is left to give on each line (by position) and on shipping. */
interface Rooms {
  lines: Map<number, Money>;
  shipping: Money;
}

/**
 * Spreads one amount over the non cancelled lines by gross share: each line, by `position`, takes
 * `round(amount × line gross / total, 2)` half away from zero, capped at its room and at what
 * remains; shipping then takes the rest up to its room; any rest beyond that goes back to the
 * non cancelled lines in reverse position order, each up to its room. Spec 0002 rule, changed
 * only where it would break a table check at the cent boundary. Reduces `rooms` by what it gives.
 */
function spread(
  amount: Money,
  lines: readonly AmountLine[],
  total: Money,
  rooms: Rooms,
): { shares: Map<number, Money>; shipping: Money } {
  const shares = new Map<number, Money>();
  for (const line of lines) shares.set(line.position, Money.zero);
  if (amount.isZero()) return { shares, shipping: Money.zero };

  const kept = lines.filter((line) => line.lineState !== 'cancelled');
  const roomOf = (position: number): Money => rooms.lines.get(position) ?? Money.zero;
  const smaller = (a: Money, b: Money): Money => (a.cents <= b.cents ? a : b);
  const give = (position: number, wanted: Money): void => {
    const taken = smaller(wanted, smaller(roomOf(position), remaining));
    shares.set(position, (shares.get(position) ?? Money.zero).plus(taken));
    rooms.lines.set(position, roomOf(position).minus(taken));
    remaining = remaining.minus(taken);
  };

  let remaining = amount;
  for (const line of kept) {
    give(line.position, amount.share(Money.of(line.grossAmount).cents, total.cents));
  }
  const shipping = smaller(remaining, rooms.shipping);
  rooms.shipping = rooms.shipping.minus(shipping);
  remaining = remaining.minus(shipping);
  for (const line of [...kept].reverse()) give(line.position, remaining);
  if (!remaining.isZero()) {
    throw new InvalidAmountError('The amount does not fit in the order lines and shipping');
  }
  return { shares, shipping };
}

/**
 * Allocates `prepaid_amount` then `credit_applied_amount` over the non cancelled lines by gross
 * share, in position order, and gives shipping the rest (spec 0002 "Money on the order"). The
 * total spread over is `lines gross + shipping charged`. A share never exceeds its line's room
 * (gross minus what was already given on that line) or shipping's room (shipping charged minus
 * what it already took), so the line check (prepaid plus credit within gross) and the shipping
 * check (its prepaid plus credit within shipping charged) always hold; a cent that does not fit
 * moves to the last lines. Recompute on every edit until the carrier delivery exists, then freeze:
 * this function does not know about
 * freezing. Throws `InvalidAmountError` when prepaid plus credit is more than the total or two lines share a position.
 */
export function allocatePayments(input: AllocationInput): AllocationResult {
  const ordered = [...input.lines].sort((a, b) => a.position - b.position);
  if (new Set(ordered.map((line) => line.position)).size !== ordered.length) {
    throw new InvalidAmountError('Two lines share one position');
  }
  const shippingCharged = Money.of(input.shippingChargedAmount);
  const total = sumGross(ordered).plus(shippingCharged);
  const prepaidAmount = Money.of(input.prepaidAmount);
  const creditAmount = Money.of(input.creditAppliedAmount);
  if (prepaidAmount.plus(creditAmount).cents > total.cents) {
    throw new InvalidAmountError('Prepaid and credit applied are more than the order total');
  }
  const rooms: Rooms = {
    lines: new Map(
      ordered.map((line) => [
        line.position,
        line.lineState === 'cancelled' ? Money.zero : Money.of(line.grossAmount),
      ]),
    ),
    shipping: shippingCharged,
  };
  const prepaid = spread(prepaidAmount, ordered, total, rooms);
  const credit = spread(creditAmount, ordered, total, rooms);
  return {
    lines: ordered.map((line) => ({
      position: line.position,
      prepaidAmount: (prepaid.shares.get(line.position) ?? Money.zero).toString(),
      creditAppliedAmount: (credit.shares.get(line.position) ?? Money.zero).toString(),
    })),
    shippingPrepaidAmount: prepaid.shipping.toString(),
    shippingCreditAppliedAmount: credit.shipping.toString(),
  };
}

/**
 * `cod_expected_amount`: what the courier is told to collect, `total − prepaid − credit applied`.
 * Throws `InvalidAmountError` when the prepayment and credit exceed the total. Freeze it when the
 * carrier delivery exists; the delivery's own COD is compared with this, never with `codDue`.
 */
export function codExpected(input: {
  totalAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
}): string {
  const expected = Money.of(input.totalAmount)
    .minus(Money.of(input.prepaidAmount))
    .minus(Money.of(input.creditAppliedAmount));
  if (expected.sign() < 0) {
    throw new InvalidAmountError('Prepaid and credit applied are more than the order total');
  }
  return expected.toString();
}

/** A line as `codDue` reads it. */
export interface CodDueLine {
  lineState: OrderLineState;
  grossAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
}

/**
 * `cod_due_amount`: what the customer owes for what she kept. The sum over `open`, `delivered`,
 * and `returned` lines of gross minus their prepaid and credit shares, plus the whole shipping
 * charge net of its shares while at least one such line remains, never below 0. It reads line
 * states only: a partial delivery lowers it by the returned rows (shipping is charged in full), and
 * it reaches 0 once every line is `returned_to_origin`, `lost`, or `cancelled`. A refusal moves no
 * line, so a refused order keeps its full due amount until the carrier reports the parcel back
 * and its lines move (spec 0002 orders child; feature 19 carries the rule). Reconciliation compares
 * collected cash with this, not with `codExpected`.
 */
export function codDue(input: {
  lines: readonly CodDueLine[];
  shippingChargedAmount: string;
  shippingPrepaidAmount: string;
  shippingCreditAppliedAmount: string;
}): string {
  let due = Money.zero;
  let keptLine = false;
  for (const line of input.lines) {
    if (
      line.lineState !== 'open' &&
      line.lineState !== 'delivered' &&
      line.lineState !== 'returned'
    ) {
      continue;
    }
    keptLine = true;
    due = due
      .plus(Money.of(line.grossAmount))
      .minus(Money.of(line.prepaidAmount))
      .minus(Money.of(line.creditAppliedAmount));
  }
  if (keptLine) {
    due = due
      .plus(Money.of(input.shippingChargedAmount))
      .minus(Money.of(input.shippingPrepaidAmount))
      .minus(Money.of(input.shippingCreditAppliedAmount));
  }
  return (due.sign() < 0 ? Money.zero : due).toString();
}
