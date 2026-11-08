import type {
  CashState,
  ChannelOrderInput,
  FulfillmentState,
  OrderLineState,
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
 * placed time); an `import` may send the states it found, with the lines in the matching state
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
  const { fulfillment, cash } = firstStates;
  if (fulfillment === 'partially_delivered') {
    throw new InvalidOrderInput('A partially delivered order cannot be imported yet');
  }
  const given = firstStates.carrierDeliveryCreatedAt;
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
  };
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
