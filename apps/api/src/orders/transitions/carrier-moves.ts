import {
  LineCannotSplit,
  Money,
  RefusedReasonCode,
  ReasonCode,
  codDue,
  deliveredAmountOf,
  splitLine,
  type CashState,
  type FulfillmentState,
  type OrderLineState,
  type SplittableLine,
} from '@ssdashboard/contracts';
import { z } from 'zod';
import type { PlanLine } from '../editing/edit-plan.js';
import { InvalidOrderInput } from '../orders.errors.js';

/**
 * The pure half of the carrier and cash moves of spec 0013 milestone 5 (task 14, AC-15 to
 * AC-17): which carrier facts exist, which lines a fact moves, how a partial delivery splits the
 * lines, and the money each move leaves. It reads no database and no clock; `OrderTransitions`
 * applies the plans inside the order transaction through `OrderWriter`.
 */

/**
 * The fulfillment states a carrier fact may report through `recordShipmentFact` (AC-15).
 * `partially_delivered` is not one: it needs the line split, so it arrives only through
 * `recordPartialDelivery` (spec 0013 State machines).
 */
export const ShipmentFactState = z.enum([
  'shipped',
  'failed_attempt',
  'delivered',
  'refused',
  'returned_to_origin',
  'lost',
  'cancelled',
]);
/** One carrier fact state. */
export type ShipmentFactState = z.infer<typeof ShipmentFactState>;

/** The line state an open line takes when a fact moves the whole parcel. */
export type LineMoveState = Extract<OrderLineState, 'delivered' | 'returned_to_origin' | 'lost'>;

/** One open line moved whole to a new state. */
export interface LineMove {
  lineId: string;
  to: LineMoveState;
}

/** The reason code a carrier's `cancelled` fact must carry (a `carrier.` code, Q-16.4). */
const CARRIER_REASON_PREFIX = 'carrier.';

/**
 * Refuses a fact that is malformed rather than merely out of order (AC-15: "only a malformed fact
 * throws"): a state outside {@link ShipmentFactState}, a `refused` without a `RefusedReasonCode`,
 * or a `cancelled` without a `carrier.` reason code. Throws `InvalidOrderInput` with fixed words;
 * a fact that passes may still be refused by the transition table.
 */
export function assertWellFormedFact(fact: { to: unknown; reasonCode?: string | null }): void {
  const to = ShipmentFactState.safeParse(fact.to);
  if (!to.success) {
    throw new InvalidOrderInput('A shipment fact names a state outside the carrier facts');
  }
  if (to.data === 'refused' && !RefusedReasonCode.safeParse(fact.reasonCode).success) {
    throw new InvalidOrderInput('A refusal needs a refusal reason from the list');
  }
  if (to.data === 'cancelled') {
    const code = ReasonCode.safeParse(fact.reasonCode);
    if (!code.success || !code.data.startsWith(CARRIER_REASON_PREFIX)) {
      throw new InvalidOrderInput('A carrier cancel needs a reason code starting with carrier.');
    }
  }
}

/**
 * The line state a fact moves every open line to (spec 0002 fulfillment table): `delivered`,
 * `returned_to_origin`, and `lost` move the lines; every other fact moves none.
 */
export function lineMoveOf(to: FulfillmentState): LineMoveState | null {
  switch (to) {
    case 'delivered':
    case 'returned_to_origin':
    case 'lost':
      return to;
    case 'new':
    case 'confirmed':
    case 'packed':
    case 'shipped':
    case 'partially_delivered':
    case 'failed_attempt':
    case 'exchanged':
    case 'refused':
    case 'cancelled':
      return null;
    default: {
      const unreachable: never = to;
      return unreachable;
    }
  }
}

/** Every open line moved to `to`, in position order. */
export function planLineMoves(lines: readonly PlanLine[], to: LineMoveState): LineMove[] {
  return lines.filter((line) => line.lineState === 'open').map((line) => ({ lineId: line.id, to }));
}

/** A line as the money of a move reads it, after the move. */
export interface MovedLine {
  lineState: OrderLineState;
  grossAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
}

/** The lines of an order with the moves applied (lines no move names keep their state). */
export function linesAfterMoves(
  lines: readonly PlanLine[],
  moves: readonly LineMove[],
): MovedLine[] {
  const moved = new Map(moves.map((move) => [move.lineId, move.to]));
  return lines.map((line) => ({
    lineState: moved.get(line.id) ?? line.lineState,
    grossAmount: line.grossAmount,
    prepaidAmount: line.prepaidAmount,
    creditAppliedAmount: line.creditAppliedAmount,
  }));
}

/** The order figures a move leaves: `cod_due_amount` and `delivered_amount` (Value sourcing). */
export interface MoveMoney {
  codDueAmount: string;
  deliveredAmount: string;
}

/** `codDue` and `deliveredAmountOf` of the lines after a move, at the move's fulfillment state. */
export function moneyAfter(
  order: {
    shippingChargedAmount: string;
    shippingPrepaidAmount: string;
    shippingCreditAppliedAmount: string;
  },
  lines: readonly MovedLine[],
  fulfillmentState: FulfillmentState,
): MoveMoney {
  return {
    codDueAmount: codDue({
      lines,
      shippingChargedAmount: order.shippingChargedAmount,
      shippingPrepaidAmount: order.shippingPrepaidAmount,
      shippingCreditAppliedAmount: order.shippingCreditAppliedAmount,
      fulfillmentState,
    }),
    deliveredAmount: deliveredAmountOf(lines),
  };
}

/** The fulfillment states after which nothing may be left to collect (spec 0002 cash table). */
const NOTHING_TO_COLLECT_AFTER: readonly FulfillmentState[] = [
  'cancelled',
  'returned_to_origin',
  'refused',
  'lost',
];

/**
 * The guard `nextState` leaves to the service for the automatic `unpaid` to `nothing_to_collect`
 * move (spec 0013 State machines): cash `unpaid`, a fulfillment of `cancelled`,
 * `returned_to_origin`, `refused`, or `lost`, nothing due, and nothing collected.
 */
export function leavesNothingToCollect(input: {
  cashState: CashState;
  fulfillmentState: FulfillmentState;
  codDueAmount: string;
  codCollectedAmount: string;
}): boolean {
  return (
    input.cashState === 'unpaid' &&
    NOTHING_TO_COLLECT_AFTER.includes(input.fulfillmentState) &&
    Money.of(input.codDueAmount).isZero() &&
    Money.of(input.codCollectedAmount).isZero()
  );
}

/** One named line of a partial delivery: how many of its pieces were delivered. */
export interface DeliveredQuantity {
  lineId: string;
  deliveredQuantity: number;
}

/** One line split into a delivered row (the original, updated) and a new returned row. */
export interface PlannedSplit {
  lineId: string;
  delivered: SplittableLine;
  returned: SplittableLine;
}

/** What a partial delivery does to the lines (spec 0002 "Partial delivery splits lines"). */
export interface PartialDeliveryPlan {
  /** Lines delivered or returned whole. */
  moves: LineMove[];
  /** Lines split in two. */
  splits: PlannedSplit[];
  /** The lines as the plan leaves them, for the money (split rows included). */
  after: MovedLine[];
  deliveredUnits: number;
  returnedUnits: number;
}

/**
 * Plans a partial delivery (AC-16): each named open line is delivered whole (`deliveredQuantity`
 * equal to its quantity), returned whole (0), or split with `splitLine` (a line of one piece is
 * never split, it is one or the other); every open line not named is delivered whole. Throws
 * `InvalidOrderInput` for a line named twice, a line that is not an open line of the order, or a
 * quantity that is not a whole number from 0 to the line's quantity. It does not check that at
 * least one unit was delivered and one returned: the caller reads `deliveredUnits` and
 * `returnedUnits` and refuses with the transition table's words.
 */
export function planPartialDelivery(
  lines: readonly PlanLine[],
  asked: readonly DeliveredQuantity[],
): PartialDeliveryPlan {
  const byId = new Map(lines.map((line) => [line.id.toLowerCase(), line]));
  const named = new Map<string, number>();
  for (const entry of asked) {
    const key = entry.lineId.toLowerCase();
    if (named.has(key)) throw new InvalidOrderInput('A line is named twice');
    const line = byId.get(key);
    if (!line || line.lineState !== 'open') {
      throw new InvalidOrderInput('A partial delivery names a line that is not an open line');
    }
    const quantity = entry.deliveredQuantity;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > line.quantity) {
      throw new InvalidOrderInput('A delivered quantity is outside 0 to the line quantity');
    }
    named.set(key, quantity);
  }
  const plan: PartialDeliveryPlan = {
    moves: [],
    splits: [],
    after: [],
    deliveredUnits: 0,
    returnedUnits: 0,
  };
  for (const line of lines) {
    if (line.lineState !== 'open') {
      plan.after.push(movedLine(line, line.lineState));
      continue;
    }
    const delivered = named.get(line.id.toLowerCase()) ?? line.quantity;
    const returned = line.quantity - delivered;
    plan.deliveredUnits += delivered;
    plan.returnedUnits += returned;
    if (returned === 0) {
      plan.moves.push({ lineId: line.id, to: 'delivered' });
      plan.after.push(movedLine(line, 'delivered'));
    } else if (delivered === 0) {
      plan.moves.push({ lineId: line.id, to: 'returned_to_origin' });
      plan.after.push(movedLine(line, 'returned_to_origin'));
    } else {
      const split = splitOf(line, returned);
      plan.splits.push({ lineId: line.id, ...split });
      plan.after.push({ ...shareOf(split.delivered), lineState: 'delivered' });
      plan.after.push({ ...shareOf(split.returned), lineState: 'returned_to_origin' });
    }
  }
  return plan;
}

function splitOf(
  line: PlanLine,
  returned: number,
): { delivered: SplittableLine; returned: SplittableLine } {
  try {
    return splitLine(line, returned);
  } catch (error) {
    // Unreachable after the checks above; kept typed so no raw error leaves the plan.
    if (error instanceof LineCannotSplit) throw new InvalidOrderInput(error.message);
    throw error;
  }
}

function movedLine(line: PlanLine, lineState: OrderLineState): MovedLine {
  return { ...shareOf(line), lineState };
}

function shareOf(line: SplittableLine): Omit<MovedLine, 'lineState'> {
  return {
    grossAmount: line.grossAmount,
    prepaidAmount: line.prepaidAmount,
    creditAppliedAmount: line.creditAppliedAmount,
  };
}
