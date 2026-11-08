import {
  Money,
  type CashState,
  type ChannelOrderInput,
  type FulfillmentState,
  type OrderLineState,
} from '@ssdashboard/contracts';
import type { OrderActor } from '../order-actor.js';
import { InvalidOrderInput } from '../orders.errors.js';

/** What the first states of a channel order decide for its row, lines, and events. */
export interface FirstStatesPlan {
  fulfillment: FulfillmentState;
  /** The reason code of the first fulfillment event (`go_live_import`, a found cancel reason). */
  fulfillmentReason: string | null;
  /** The found cash state of an import; null means `firstCashState` of the amounts. */
  cash: CashState | null;
  /** The state every line starts in (an imported delivered order has delivered lines). */
  lineState: OrderLineState;
  /**
   * False for an order created past `packed` or cancelled: it takes no reservation and posts no
   * shipment movement (AC-14, Value sourcing), because the opening stock snapshot already excludes
   * those pieces. Milestone 4's reservations read it.
   */
  takesStock: boolean;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelReasonCode: string | null;
  refusedReasonCode: string | null;
  carrierDeliveryCreatedAt: Date | null;
  /** The found cash says the carrier collected what was due (`cod_collected_amount` = due). */
  collected: boolean;
  /** The found cash says the collection was remitted (`remitted_amount` = due). */
  remitted: boolean;
  /**
   * Where the first events came from: the import run for an `import` actor (security M1: kept in
   * `order_events.source_type` `import_run` and `source_id` the run id), else null.
   */
  eventSource: { type: 'import_run'; id: string } | null;
}

/** The found cash states a found fulfillment state may carry (security M1). */
const FIRST_CASH: readonly CashState[] = ['unpaid', 'prepaid', 'nothing_to_collect'];

/** The found cash states past a first state: the carrier collected, it was remitted or settled. */
const CASH_PAST_FIRST: readonly CashState[] = ['collected_by_carrier', 'remitted', 'reconciled'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The found cash states each found fulfillment state allows (security M1). */
function allowedCash(fulfillment: FulfillmentState): readonly CashState[] {
  if (HOLDING_STATES.includes(fulfillment)) return FIRST_CASH;
  // A live cancel always moves the cash to `nothing_to_collect` (security R3).
  if (fulfillment === 'cancelled') return ['nothing_to_collect'];
  return [...FIRST_CASH, ...CASH_PAST_FIRST];
}

/** The fulfillment states in which an order still holds its stock (spec 0013 AC-13). */
const HOLDING_STATES: readonly FulfillmentState[] = ['new', 'confirmed', 'packed'];

/** The fulfillment states a carrier fact has already touched: the freeze is set. */
const CARRIER_STATES: readonly FulfillmentState[] = [
  'shipped',
  'failed_attempt',
  'delivered',
  'partially_delivered',
  'refused',
  'returned_to_origin',
  'lost',
  'exchanged',
];

/**
 * Decides the first states of an order from the channel (spec 0013 AC-14, AC-25 a, State machines
 * rule 5). Without `firstStates` every order starts `new` with `firstCashState`. A `system_job`
 * may send only the go live state (`confirmed`, reason `go_live_import`, `confirmed_at` the
 * placed time); an `import` (whose run id must be a uuid, recorded on the events) may send the states it found, a
 * pair the allow list accepts (a held order only in a first cash state, a cancelled one only
 * `nothing_to_collect`, as a live cancel leaves it, collected, remitted, or reconciled cash only once a carrier fact
 * touched the order and with its carrier delivery time), with the lines in the matching state
 * (`delivered` for a delivered or exchanged order, `returned_to_origin` for a refused or returned
 * one, `lost` for a lost one, `open` otherwise, a cancelled order's lines included), the carrier
 * delivery set at the given time or, for an order a carrier fact has touched, its placed time, and
 * a collected and remitted cash taken as the full amount due. Throws `InvalidOrderInput` for first
 * states from any other actor, and for an imported `partially_delivered` order (its line split is
 * not known). Pure.
 */
export function planFirstStates(
  firstStates: ChannelOrderInput['firstStates'],
  actor: OrderActor,
  placedAt: Date,
): FirstStatesPlan {
  const plain: FirstStatesPlan = {
    fulfillment: 'new',
    fulfillmentReason: null,
    cash: null,
    lineState: 'open',
    takesStock: true,
    confirmedAt: null,
    cancelledAt: null,
    cancelReasonCode: null,
    refusedReasonCode: null,
    carrierDeliveryCreatedAt: null,
    collected: false,
    remitted: false,
    eventSource: null,
  };
  if (firstStates === null) return plain;
  if (!('cash' in firstStates)) {
    if (actor.type !== 'system_job') {
      throw new InvalidOrderInput('Only a system job starts an order at its go live state');
    }
    return {
      ...plain,
      fulfillment: 'confirmed',
      fulfillmentReason: firstStates.reasonCode,
      confirmedAt: placedAt,
    };
  }
  if (actor.type !== 'import') {
    throw new InvalidOrderInput('Only an import creates an order in the states it found');
  }
  if (!UUID.test(actor.runId)) {
    throw new InvalidOrderInput('An import names its run by a uuid');
  }
  const { fulfillment, cash } = firstStates;
  if (fulfillment === 'partially_delivered') {
    throw new InvalidOrderInput('A partially delivered order cannot be imported yet');
  }
  if (!allowedCash(fulfillment).includes(cash)) {
    throw new InvalidOrderInput('The found cash state does not fit the found fulfillment state');
  }
  const given = firstStates.carrierDeliveryCreatedAt;
  if (CASH_PAST_FIRST.includes(cash) && given === null) {
    throw new InvalidOrderInput('A collected order names when its carrier delivery was made');
  }
  const reason = firstStates.cancelReasonCode ?? firstStates.refusedReasonCode ?? null;
  return {
    fulfillment,
    fulfillmentReason: reason,
    cash,
    lineState: lineStateOf(fulfillment),
    takesStock: HOLDING_STATES.includes(fulfillment),
    confirmedAt: fulfillment === 'new' || fulfillment === 'cancelled' ? null : placedAt,
    cancelledAt: fulfillment === 'cancelled' ? placedAt : null,
    cancelReasonCode: firstStates.cancelReasonCode ?? null,
    refusedReasonCode: firstStates.refusedReasonCode ?? null,
    carrierDeliveryCreatedAt:
      given !== null ? new Date(given) : CARRIER_STATES.includes(fulfillment) ? placedAt : null,
    collected: cash === 'collected_by_carrier' || cash === 'remitted' || cash === 'reconciled',
    remitted: cash === 'remitted' || cash === 'reconciled',
    eventSource: { type: 'import_run', id: actor.runId },
  };
}

/** The amounts a found cash state is checked against. */
export interface FoundAmounts {
  codExpectedAmount: string;
  codDueAmount: string;
  prepaidAmount: string;
}

/**
 * Checks a found cash state against the order's own amounts (security M1), once they are priced:
 * `unpaid` needs a COD expected above 0; `prepaid` a prepayment and nothing expected on delivery;
 * `nothing_to_collect` nothing due (`cod_due_amount` 0, which also holds for a cancelled, refused,
 * or returned order); `collected_by_carrier` and `remitted` an amount due; `reconciled` an amount
 * due or a full prepayment. Throws `InvalidOrderInput` otherwise. A plan without found cash (a
 * plain or go live order, whose cash is `firstCashState`) passes. Pure.
 */
export function assertFoundAmounts(plan: FirstStatesPlan, amounts: FoundAmounts): void {
  if (plan.cash === null) return;
  const expected = !Money.of(amounts.codExpectedAmount).isZero();
  const due = !Money.of(amounts.codDueAmount).isZero();
  const prepaid = !Money.of(amounts.prepaidAmount).isZero();
  let fits: boolean;
  switch (plan.cash) {
    case 'unpaid':
      fits = expected;
      break;
    case 'prepaid':
      fits = prepaid && !expected;
      break;
    case 'nothing_to_collect':
      fits = !due;
      break;
    case 'collected_by_carrier':
    case 'remitted':
      fits = due;
      break;
    case 'reconciled':
      fits = due || (prepaid && !expected);
      break;
    default: {
      const unreachable: never = plan.cash;
      return unreachable;
    }
  }
  if (!fits) throw new InvalidOrderInput('The found cash state does not fit the order amounts');
}

/** The line state an imported order's lines take in a found fulfillment state. */
function lineStateOf(fulfillment: FulfillmentState): OrderLineState {
  switch (fulfillment) {
    case 'delivered':
    case 'exchanged':
      return 'delivered';
    case 'refused':
    case 'returned_to_origin':
      return 'returned_to_origin';
    case 'lost':
      return 'lost';
    case 'new':
    case 'confirmed':
    case 'packed':
    case 'cancelled':
    case 'shipped':
    case 'failed_attempt':
    case 'partially_delivered':
      return 'open';
  }
}
