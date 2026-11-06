import { z } from 'zod';
import { Money } from '../money.js';

/**
 * The two order state machines (fulfillment for the parcel, cash for the money) as pure data and
 * functions: the enums, the transition tables of spec 0002 "orders", `nextState`, `replayStates`,
 * and the first cash state. The orders service applies them inside a transaction and writes the
 * `order_events` row; nothing here reads a database or a clock.
 */

/** Where the parcel is. Matches the `orders.fulfillment_state` enum. */
export const FulfillmentState = z.enum([
  'new',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'partially_delivered',
  'failed_attempt',
  'returned_to_origin',
  'exchanged',
  'refused',
  'cancelled',
  'lost',
]);
/** One fulfillment state. */
export type FulfillmentState = z.infer<typeof FulfillmentState>;

/** Where the money is. Matches the `orders.cash_state` enum. */
export const CashState = z.enum([
  'unpaid',
  'collected_by_carrier',
  'remitted',
  'reconciled',
  'prepaid',
  'nothing_to_collect',
]);
/** One cash state. */
export type CashState = z.infer<typeof CashState>;

/** What happened to one order line. Matches the `order_lines.line_state` enum. */
export const OrderLineState = z.enum([
  'open',
  'cancelled',
  'delivered',
  'returned_to_origin',
  'returned',
  'lost',
]);
/** One line state. */
export type OrderLineState = z.infer<typeof OrderLineState>;

/** Who made a move. Matches the `order_events.actor_type` enum (the names spec 0010 uses). */
export const OrderActorType = z.enum(['person', 'carrier', 'system_job', 'import']);
/** One actor type. */
export type OrderActorType = z.infer<typeof OrderActorType>;

/** Why a customer refused a parcel at the door. Matches the check on `orders.refused_reason_code` (feature 19 maps an unknown carrier reason to `other`). */
export const RefusedReasonCode = z.enum([
  'size',
  'changed_mind',
  'price',
  'not_ordered',
  'damaged',
  'other',
]);
/** One refusal reason code. */
export type RefusedReasonCode = z.infer<typeof RefusedReasonCode>;

/** The shape of every reason code column: a code, never a typed note. */
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * A reason, outcome, or account code: lower case letters, digits, `_` and `.`, starting with a
 * letter, at most 64 characters (`edit_removal`, `confirmation.call`). The Zod twin of the
 * database's `reasonCodeShape` check, used for every code column on append only history: the
 * ledger's `stock_movements.reason_code` (PostingLine, ReverseInput), `customer_merges.reason`,
 * `settlement_period_events.reason`, and the settlement match codes. A reason is a code, never a
 * typed note: a note would be personal data kept for ever (security review S4). Surrounding
 * spaces are trimmed first; never use it for free text.
 */
export const ReasonCode = z
  .string()
  .trim()
  .regex(REASON_CODE_PATTERN, 'A reason is a lower case code, for example wrong_supplier');
/** One ReasonCode value. */
export type ReasonCode = z.infer<typeof ReasonCode>;

/** Which of the two machines an event belongs to. Matches the `order_events.machine` enum. */
export const OrderMachine = z.enum(['fulfillment', 'cash']);
/** One order machine. */
export type OrderMachine = z.infer<typeof OrderMachine>;

/**
 * A task a transition asks the caller to open, because a carrier fact contradicted what the
 * order said. The move itself still happens: a carrier report is a fact and is never refused.
 */
export const OrderTaskKind = z.enum([
  'shipped_without_confirmation',
  'shipped_before_edit_synced',
  'shipped_after_cancellation',
  'late_cash_on_nothing_to_collect',
]);
/** One task kind. */
export type OrderTaskKind = z.infer<typeof OrderTaskKind>;

/** Thrown when a move is not in the transition table for its actor, or a guard of its row fails. Names both states. */
export class InvalidTransition extends Error {
  readonly code = 'InvalidTransition';

  /** Takes the machine, both states, the actor, and the plain words of why. */
  constructor(
    readonly machine: OrderMachine,
    readonly from: string,
    readonly to: string,
    readonly actor: OrderActorType,
    why: string,
  ) {
    super(`The ${machine} cannot move from "${from}" to "${to}" by ${actor}: ${why}`);
    this.name = 'InvalidTransition';
  }
}

/** Thrown when a recorded event list cannot be replayed (a broken chain or a value outside the machine's enum). */
export class InvalidEventHistory extends Error {
  readonly code = 'InvalidEventHistory';

  /** Takes the plain words of what is wrong. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventHistory';
  }
}

/** What `nextState` needs besides the move itself. */
export interface TransitionContext {
  actor: OrderActorType;
  /** The reason code the move was recorded with; required by the rows that say so. */
  reasonCode?: string | null;
  /** True when the order's `write_back_state` is not `none` or the connectors service reports an open command. */
  writeBackOpen?: boolean;
  /** True once `carrier_delivery_created_at` is set. */
  carrierDeliveryCreated?: boolean;
}

/** A fulfillment or a cash move with its context. */
export type NextStateInput = TransitionContext &
  (
    | { machine: 'fulfillment'; from: FulfillmentState; to: FulfillmentState }
    | { machine: 'cash'; from: CashState; to: CashState }
  );

/** The answer of `nextState`: the new state and the tasks the caller must open in the same transaction. */
export interface NextStateResult<S extends string> {
  state: S;
  tasks: OrderTaskKind[];
}

interface TransitionRule<S extends string> {
  from: readonly S[];
  to: S;
  actors: readonly OrderActorType[];
  /** Actors that must supply a reason code. */
  reasonFrom?: readonly OrderActorType[];
  /** Actors whose reason code must also pass `valid`; the check replaces the plain presence check. */
  reasonShape?: {
    actors: readonly OrderActorType[];
    valid: (reasonCode: string) => boolean;
    expected: string;
  };
  /** Returns the words of why the move is refused, or null when the row's guards pass. */
  refuse?: (from: S, context: TransitionContext) => string | null;
  /** Tasks a carrier fact opens. */
  tasks?: (from: S, context: TransitionContext) => OrderTaskKind[];
}

const FULFILLMENT_RULES: readonly TransitionRule<FulfillmentState>[] = [
  { from: ['new'], to: 'confirmed', actors: ['person'] },
  {
    from: ['new', 'confirmed', 'packed'],
    to: 'cancelled',
    actors: ['person'],
    reasonShape: {
      actors: ['person'],
      valid: (code) => REASON_CODE_PATTERN.test(code),
      expected: 'a reason code like "duplicate" (a lower case code, not a note)',
    },
    refuse: (_from, c) =>
      c.carrierDeliveryCreated ? 'a carrier delivery already exists for the order' : null,
  },
  {
    from: ['confirmed'],
    to: 'packed',
    actors: ['person'],
    refuse: (_from, c) => (c.writeBackOpen ? 'an edit has not synced to the channel yet' : null),
  },
  {
    from: ['packed'],
    to: 'confirmed',
    actors: ['person'],
    refuse: (_from, c) =>
      c.carrierDeliveryCreated ? 'a carrier delivery already exists for the order' : null,
  },
  {
    from: ['new', 'confirmed', 'packed'],
    to: 'shipped',
    actors: ['carrier'],
    tasks: (from, c) => [
      ...(from === 'new' ? (['shipped_without_confirmation'] as const) : []),
      ...(c.writeBackOpen ? (['shipped_before_edit_synced'] as const) : []),
    ],
  },
  {
    from: ['cancelled'],
    to: 'shipped',
    actors: ['carrier'],
    tasks: () => ['shipped_after_cancellation'],
  },
  { from: ['shipped', 'failed_attempt'], to: 'failed_attempt', actors: ['carrier'] },
  { from: ['shipped', 'failed_attempt'], to: 'delivered', actors: ['carrier'] },
  { from: ['shipped', 'failed_attempt'], to: 'partially_delivered', actors: ['carrier', 'person'] },
  {
    from: ['shipped', 'failed_attempt'],
    to: 'refused',
    actors: ['carrier'],
    reasonShape: {
      actors: ['carrier'],
      valid: (code) => RefusedReasonCode.safeParse(code).success,
      expected: 'a refusal reason: size, changed_mind, price, not_ordered, damaged, or other',
    },
  },
  {
    from: ['shipped', 'failed_attempt', 'refused'],
    to: 'returned_to_origin',
    actors: ['carrier'],
  },
  {
    from: ['shipped', 'failed_attempt', 'refused'],
    to: 'lost',
    actors: ['carrier', 'person'],
    reasonFrom: ['person'],
  },
  { from: ['delivered', 'partially_delivered'], to: 'exchanged', actors: ['system_job'] },
];

const CASH_RULES: readonly TransitionRule<CashState>[] = [
  {
    from: ['unpaid'],
    to: 'collected_by_carrier',
    actors: ['carrier', 'person'],
    reasonFrom: ['person'],
  },
  {
    from: ['collected_by_carrier'],
    to: 'collected_by_carrier',
    actors: ['carrier', 'person'],
    reasonFrom: ['person'],
  },
  { from: ['collected_by_carrier'], to: 'remitted', actors: ['system_job'] },
  { from: ['remitted'], to: 'reconciled', actors: ['system_job'] },
  { from: ['unpaid'], to: 'nothing_to_collect', actors: ['system_job'] },
  {
    from: ['nothing_to_collect'],
    to: 'collected_by_carrier',
    actors: ['carrier'],
    tasks: () => ['late_cash_on_nothing_to_collect'],
  },
  { from: ['prepaid'], to: 'reconciled', actors: ['system_job', 'person'] },
  { from: ['reconciled'], to: 'remitted', actors: ['system_job'], reasonFrom: ['system_job'] },
  {
    from: ['remitted'],
    to: 'collected_by_carrier',
    actors: ['system_job'],
    reasonFrom: ['system_job'],
  },
  {
    from: ['collected_by_carrier'],
    to: 'unpaid',
    actors: ['carrier', 'person'],
    reasonFrom: ['person'],
  },
];

function apply<S extends string>(
  machine: OrderMachine,
  rules: readonly TransitionRule<S>[],
  from: S,
  to: S,
  context: TransitionContext,
): NextStateResult<S> {
  const rule = rules.find(
    (r) => r.to === to && r.from.includes(from) && r.actors.includes(context.actor),
  );
  if (!rule) {
    throw new InvalidTransition(
      machine,
      from,
      to,
      context.actor,
      'the transition table has no such move',
    );
  }
  if (rule.reasonFrom?.includes(context.actor) && !context.reasonCode?.trim()) {
    throw new InvalidTransition(machine, from, to, context.actor, 'a reason code is required');
  }
  const shape = rule.reasonShape;
  if (shape?.actors.includes(context.actor) && !shape.valid(context.reasonCode ?? '')) {
    throw new InvalidTransition(machine, from, to, context.actor, `needs ${shape.expected}`);
  }
  const refusal = rule.refuse?.(from, context) ?? null;
  if (refusal !== null) {
    throw new InvalidTransition(machine, from, to, context.actor, refusal);
  }
  return { state: to, tasks: rule.tasks?.(from, context) ?? [] };
}

/**
 * Checks one move against the transition table of its machine and returns the new state plus the
 * tasks a carrier fact opens. Raises `InvalidTransition` naming both states for any pair or actor
 * outside the table, a missing required reason, a `packed` move while a write back is open, or a
 * cancel or un-pack after the carrier delivery exists. Must never refuse a carrier report that the
 * table lists (shipped from `new`, shipped during an open write back, shipped after a cancel, late
 * cash): those are facts and open a task instead. Imports never move a state; they set the first.
 *
 * Reason codes: a person cancelling needs a code matching `^[a-z][a-z0-9_.]{0,63}$`; a carrier
 * `refused` needs a `RefusedReasonCode` (map an unknown carrier reason to `other` before calling).
 *
 * Guards NOT checked here, which the orders service must enforce in its transaction:
 * `unpaid` to `nothing_to_collect` needs fulfillment `cancelled`, `returned_to_origin`, `refused`,
 * or `lost` with `cod_due_amount = 0` and nothing collected; `remitted` needs a settlement
 * statement with a deposit date; order edits lock at `carrier_delivery_created_at` (only the
 * cancel and un-pack moves read that flag here); `confirmed` to `packed` must also ask
 * `ConnectorsService.openCommandsFor('order', id)`, beyond the `writeBackOpen` flag the caller
 * passes; `partially_delivered` needs the line split and `delivered` needs every open line
 * delivered.
 */
export function nextState(
  input: NextStateInput,
): NextStateResult<FulfillmentState> | NextStateResult<CashState> {
  switch (input.machine) {
    case 'fulfillment':
      return apply('fulfillment', FULFILLMENT_RULES, input.from, input.to, input);
    case 'cash':
      return apply('cash', CASH_RULES, input.from, input.to, input);
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
}

/**
 * The cash state a new order starts in: `nothing_to_collect` when there is nothing to collect and
 * nothing was prepaid, `prepaid` when only prepayment covers it, otherwise `unpaid`. Amounts cross
 * as `MoneyString`; a malformed amount throws `InvalidAmountError`.
 */
export function firstCashState(order: {
  codExpectedAmount: string;
  prepaidAmount: string;
}): CashState {
  const codExpected = Money.of(order.codExpectedAmount);
  const prepaid = Money.of(order.prepaidAmount);
  if (!codExpected.isZero()) return 'unpaid';
  return prepaid.isZero() ? 'nothing_to_collect' : 'prepaid';
}

/** One recorded `order_events` row, as `replayStates` reads it. */
export interface ReplayEvent {
  machine: OrderMachine;
  /** Null only on a machine's first event. */
  fromState: string | null;
  toState: string;
}

/** The current state of each machine; null when the machine has no event yet. */
export interface ReplayedStates {
  fulfillment: FulfillmentState | null;
  cash: CashState | null;
}

/**
 * Rebuilds both states from an order's events in recorded order. The first event of a machine has
 * a null `fromState` and sets its state as found (an import sets whatever the old system had);
 * every later event must start from the state the previous one reached. It checks the chain and
 * the enum values, not the transition table: the table was applied when each event was written,
 * and some rows depend on context a replay does not have. Throws `InvalidEventHistory` on a break.
 */
export function replayStates(events: readonly ReplayEvent[]): ReplayedStates {
  const states: ReplayedStates = { fulfillment: null, cash: null };
  for (const event of events) {
    const current = states[event.machine];
    if (current === null) {
      if (event.fromState !== null) {
        throw new InvalidEventHistory(
          `The first ${event.machine} event must have no from state, found "${event.fromState}"`,
        );
      }
    } else if (event.fromState !== current) {
      throw new InvalidEventHistory(
        `A ${event.machine} event starts from "${String(event.fromState)}" but the state was "${current}"`,
      );
    }
    if (event.machine === 'fulfillment') {
      const parsed = FulfillmentState.safeParse(event.toState);
      if (!parsed.success) {
        throw new InvalidEventHistory(`"${event.toState}" is not a fulfillment state`);
      }
      states.fulfillment = parsed.data;
    } else {
      const parsed = CashState.safeParse(event.toState);
      if (!parsed.success) throw new InvalidEventHistory(`"${event.toState}" is not a cash state`);
      states.cash = parsed.data;
    }
  }
  return states;
}
