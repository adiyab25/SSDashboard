import { describe, expect, it } from 'vitest';
import {
  OrderActorType,
  RefusedReasonCode,
  CashState,
  FulfillmentState,
  InvalidEventHistory,
  InvalidTransition,
  OrderLineState,
  firstCashState,
  nextState,
  replayStates,
  type OrderActorType as Actor,
  type CashState as Cash,
  type FulfillmentState as Fulfillment,
} from '../src/index.js';

type Rule<S extends string> = readonly [from: readonly S[], to: S, actors: readonly Actor[]];

/** The fulfillment transition table of spec 0002 orders, written out independently of the code. */
const FULFILLMENT_RULES: readonly Rule<Fulfillment>[] = [
  [['new'], 'confirmed', ['person']],
  [['new', 'confirmed', 'packed'], 'cancelled', ['person', 'system_job', 'carrier']],
  [['confirmed'], 'packed', ['person']],
  [['packed'], 'confirmed', ['person']],
  [['new', 'confirmed', 'packed'], 'shipped', ['carrier']],
  [['cancelled'], 'shipped', ['carrier']],
  [['shipped', 'failed_attempt'], 'failed_attempt', ['carrier']],
  [['shipped', 'failed_attempt'], 'delivered', ['carrier']],
  [['shipped', 'failed_attempt'], 'partially_delivered', ['carrier', 'person']],
  [['shipped', 'failed_attempt'], 'refused', ['carrier']],
  [['shipped', 'failed_attempt', 'refused'], 'returned_to_origin', ['carrier']],
  [['shipped', 'failed_attempt', 'refused'], 'lost', ['carrier', 'person']],
  [['delivered', 'partially_delivered'], 'exchanged', ['system_job']],
];

/** The cash transition table of spec 0002 orders, written out independently of the code. */
const CASH_RULES: readonly Rule<Cash>[] = [
  [['unpaid'], 'collected_by_carrier', ['carrier', 'person']],
  [['collected_by_carrier'], 'collected_by_carrier', ['carrier', 'person']],
  [['collected_by_carrier'], 'remitted', ['system_job']],
  [['remitted'], 'reconciled', ['system_job']],
  [['unpaid'], 'nothing_to_collect', ['system_job']],
  [['unpaid'], 'prepaid', ['system_job']],
  [['prepaid', 'nothing_to_collect'], 'unpaid', ['system_job']],
  [['nothing_to_collect'], 'collected_by_carrier', ['carrier']],
  [['prepaid'], 'reconciled', ['system_job', 'person']],
  [['reconciled'], 'remitted', ['system_job']],
  [['remitted'], 'collected_by_carrier', ['system_job']],
  [['collected_by_carrier'], 'unpaid', ['carrier', 'person']],
];

/** A reason code each actor can legally give for a move, so the product test isolates the table. */
function reasonFor(machine: 'fulfillment' | 'cash', to: string, actor: Actor): string {
  if (machine === 'cash') return actor === 'system_job' ? 'payment_method_rederived' : 'size';
  if (to === 'cancelled') {
    if (actor === 'system_job') return 'channel.customer';
    if (actor === 'carrier') return 'carrier.terminated_before_pickup';
    return 'duplicate';
  }
  return 'size';
}

function allowed<S extends string>(
  rules: readonly Rule<S>[],
  from: S,
  to: S,
  actor: Actor,
): boolean {
  return rules.some(([f, t, a]) => f.includes(from) && t === to && a.includes(actor));
}

describe('order enums', () => {
  it('lists the fulfillment states including cancelled and lost', () => {
    expect(FulfillmentState.options).toEqual([
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
  });

  it('lists the cash, line, and actor values', () => {
    expect(CashState.options).toEqual([
      'unpaid',
      'collected_by_carrier',
      'remitted',
      'reconciled',
      'prepaid',
      'nothing_to_collect',
    ]);
    expect(OrderLineState.options).toEqual([
      'open',
      'cancelled',
      'delivered',
      'returned_to_origin',
      'returned',
      'lost',
    ]);
    expect(OrderActorType.options).toEqual(['person', 'carrier', 'system_job', 'import']);
  });
});

describe('nextState over the whole enum product', () => {
  it('accepts exactly the fulfillment table and raises InvalidTransition for every other triple', () => {
    let accepted = 0;
    for (const from of FulfillmentState.options) {
      for (const to of FulfillmentState.options) {
        for (const actor of OrderActorType.options) {
          const input = {
            machine: 'fulfillment',
            from,
            to,
            actor,
            reasonCode: reasonFor('fulfillment', to, actor),
          } as const;
          if (allowed(FULFILLMENT_RULES, from, to, actor)) {
            expect(nextState(input).state, `${from} -> ${to} by ${actor}`).toBe(to);
            accepted += 1;
          } else {
            expect(() => nextState(input), `${from} -> ${to} by ${actor}`).toThrow(
              InvalidTransition,
            );
          }
        }
      }
    }
    expect(accepted).toBe(
      FULFILLMENT_RULES.reduce((sum, [f, , a]) => sum + f.length * a.length, 0),
    );
  });

  it('accepts exactly the cash table and raises InvalidTransition for every other triple', () => {
    let accepted = 0;
    for (const from of CashState.options) {
      for (const to of CashState.options) {
        for (const actor of OrderActorType.options) {
          const input = {
            machine: 'cash',
            from,
            to,
            actor,
            reasonCode: reasonFor('cash', to, actor),
          } as const;
          if (allowed(CASH_RULES, from, to, actor)) {
            expect(nextState(input).state, `${from} -> ${to} by ${actor}`).toBe(to);
            accepted += 1;
          } else {
            expect(() => nextState(input), `${from} -> ${to} by ${actor}`).toThrow(
              InvalidTransition,
            );
          }
        }
      }
    }
    expect(accepted).toBe(CASH_RULES.reduce((sum, [f, , a]) => sum + f.length * a.length, 0));
  });

  it.each([
    ['fulfillment', 'delivered', 'new', 'person'],
    ['fulfillment', 'delivered', 'new', 'carrier'],
    ['fulfillment', 'cancelled', 'shipped', 'person'],
    ['fulfillment', 'lost', 'delivered', 'carrier'],
    ['cash', 'reconciled', 'unpaid', 'person'],
    ['cash', 'reconciled', 'unpaid', 'system_job'],
  ] as const)(
    'refuses the named case %s %s -> %s by %s, naming both states',
    (machine, from, to, actor) => {
      const error = (() => {
        try {
          nextState({ machine, from, to, actor, reasonCode: 'size' } as never);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(InvalidTransition);
      const invalid = error as InvalidTransition;
      expect(invalid.from).toBe(from);
      expect(invalid.to).toBe(to);
      expect(invalid.message).toContain(from);
      expect(invalid.message).toContain(to);
      expect(invalid.code).toBe('InvalidTransition');
    },
  );
});

describe('nextState guards and tasks', () => {
  const base = { machine: 'fulfillment', actor: 'person', reasonCode: 'size' } as const;

  it('refuses confirmed to packed while a write back is open', () => {
    expect(() =>
      nextState({ ...base, from: 'confirmed', to: 'packed', writeBackOpen: true }),
    ).toThrow(InvalidTransition);
    expect(
      nextState({ ...base, from: 'confirmed', to: 'packed', writeBackOpen: false }).state,
    ).toBe('packed');
  });

  it('refuses cancelling without a reason, and allows it after the carrier delivery exists', () => {
    const cancel = {
      machine: 'fulfillment',
      actor: 'person',
      from: 'confirmed',
      to: 'cancelled',
    } as const;
    expect(() => nextState(cancel)).toThrow(InvalidTransition);
    expect(() => nextState({ ...cancel, reasonCode: '  ' })).toThrow(InvalidTransition);
    expect(nextState({ ...cancel, reasonCode: 'fake', carrierDeliveryCreated: true }).state).toBe(
      'cancelled',
    );
    expect(nextState({ ...cancel, reasonCode: 'fake' }).state).toBe('cancelled');
  });

  it('shapes the reason of a channel or carrier cancel and of a rederived payment method', () => {
    const cancel = { machine: 'fulfillment', from: 'packed', to: 'cancelled' } as const;
    expect(() => nextState({ ...cancel, actor: 'system_job', reasonCode: 'fake' })).toThrow(
      InvalidTransition,
    );
    expect(nextState({ ...cancel, actor: 'system_job', reasonCode: 'channel.fake' }).state).toBe(
      'cancelled',
    );
    expect(() => nextState({ ...cancel, actor: 'carrier', reasonCode: 'channel.fake' })).toThrow(
      InvalidTransition,
    );
    expect(
      nextState({ ...cancel, actor: 'carrier', reasonCode: 'carrier.terminated_before_pickup' })
        .state,
    ).toBe('cancelled');
    const rederive = { machine: 'cash', actor: 'system_job' } as const;
    for (const [from, to] of [
      ['unpaid', 'prepaid'],
      ['prepaid', 'unpaid'],
      ['nothing_to_collect', 'unpaid'],
    ] as const) {
      expect(() => nextState({ ...rederive, from, to, reasonCode: 'size' })).toThrow(
        InvalidTransition,
      );
      expect(
        nextState({ ...rederive, from, to, reasonCode: 'payment_method_rederived' }).state,
      ).toBe(to);
    }
  });

  it('refuses packed to confirmed once the carrier delivery exists', () => {
    expect(() =>
      nextState({ ...base, from: 'packed', to: 'confirmed', carrierDeliveryCreated: true }),
    ).toThrow(InvalidTransition);
  });

  it('requires a reason for a person recording lost', () => {
    const lost = { machine: 'fulfillment', actor: 'person', from: 'shipped', to: 'lost' } as const;
    expect(() => nextState(lost)).toThrow(InvalidTransition);
    expect(nextState({ ...lost, reasonCode: 'lost_by_carrier' }).state).toBe('lost');
    expect(nextState({ ...lost, actor: 'carrier' }).state).toBe('lost');
  });

  it('never refuses a carrier shipped fact, and reports the tasks it opens', () => {
    const shipped = { machine: 'fulfillment', actor: 'carrier', to: 'shipped' } as const;
    expect(nextState({ ...shipped, from: 'confirmed' }).tasks).toEqual([]);
    expect(nextState({ ...shipped, from: 'packed', carrierDeliveryCreated: true }).tasks).toEqual(
      [],
    );
    expect(nextState({ ...shipped, from: 'new' }).tasks).toEqual(['shipped_without_confirmation']);
    expect(nextState({ ...shipped, from: 'confirmed', writeBackOpen: true }).tasks).toEqual([
      'shipped_before_edit_synced',
    ]);
    expect(nextState({ ...shipped, from: 'new', writeBackOpen: true }).tasks).toEqual([
      'shipped_without_confirmation',
      'shipped_before_edit_synced',
    ]);
    expect(nextState({ ...shipped, from: 'cancelled' }).tasks).toEqual([
      'shipped_after_cancellation',
    ]);
    expect(
      nextState({
        ...shipped,
        from: 'cancelled',
        carrierDeliveryCreated: true,
        writeBackOpen: true,
      }).tasks,
    ).toEqual(['shipped_after_cancellation']);
  });

  it('opens a task for late cash on nothing_to_collect', () => {
    const late = nextState({
      machine: 'cash',
      from: 'nothing_to_collect',
      to: 'collected_by_carrier',
      actor: 'carrier',
    });
    expect(late.tasks).toEqual(['late_cash_on_nothing_to_collect']);
    expect(
      nextState({ machine: 'cash', from: 'unpaid', to: 'collected_by_carrier', actor: 'carrier' })
        .tasks,
    ).toEqual([]);
  });

  it.each([
    ['unpaid', 'collected_by_carrier'],
    ['collected_by_carrier', 'collected_by_carrier'],
    ['collected_by_carrier', 'unpaid'],
  ] as const)('requires a reason when a person moves cash %s -> %s', (from, to) => {
    const move = { machine: 'cash', from, to, actor: 'person' } as const;
    expect(() => nextState(move)).toThrow(InvalidTransition);
    expect(nextState({ ...move, reasonCode: 'courier_note' }).state).toBe(to);
    expect(nextState({ ...move, actor: 'carrier' }).state).toBe(to);
  });

  it.each([
    ['reconciled', 'remitted'],
    ['remitted', 'collected_by_carrier'],
  ] as const)('requires a reason to revoke cash %s -> %s', (from, to) => {
    const move = { machine: 'cash', from, to, actor: 'system_job' } as const;
    expect(() => nextState(move)).toThrow(InvalidTransition);
    expect(nextState({ ...move, reasonCode: 'match_revoked' }).state).toBe(to);
  });
});

describe('reason code shapes', () => {
  const refuse = {
    machine: 'fulfillment',
    from: 'shipped',
    to: 'refused',
    actor: 'carrier',
  } as const;

  it('lists the refusal reason codes', () => {
    expect(RefusedReasonCode.options).toEqual([
      'size',
      'changed_mind',
      'price',
      'not_ordered',
      'damaged',
      'other',
    ]);
  });

  it('requires a carrier refusal to carry a RefusedReasonCode', () => {
    expect(() => nextState(refuse)).toThrow(InvalidTransition);
    expect(() => nextState({ ...refuse, reasonCode: 'too_big' })).toThrow(InvalidTransition);
    for (const code of RefusedReasonCode.options) {
      expect(nextState({ ...refuse, reasonCode: code }).state).toBe('refused');
    }
  });

  it.each(['Duplicate', '1fake', 'has space', 'a'.repeat(65), '', 'dup!'])(
    'refuses a person cancelling with the reason %j',
    (reasonCode) => {
      expect(() =>
        nextState({
          machine: 'fulfillment',
          from: 'new',
          to: 'cancelled',
          actor: 'person',
          reasonCode,
        }),
      ).toThrow(InvalidTransition);
    },
  );

  it.each(['duplicate', 'customer_cancelled', 'out.of_stock', 'a'.repeat(64)])(
    'accepts a person cancelling with the reason %j',
    (reasonCode) => {
      expect(
        nextState({
          machine: 'fulfillment',
          from: 'new',
          to: 'cancelled',
          actor: 'person',
          reasonCode,
        }).state,
      ).toBe('cancelled');
    },
  );
});

describe('firstCashState', () => {
  it.each([
    ['0.00', '0.00', 'nothing_to_collect'],
    ['0.00', '300.00', 'prepaid'],
    ['2450.00', '0.00', 'unpaid'],
    ['50.00', '300.00', 'unpaid'],
  ] as const)('cod %s with prepaid %s starts %s', (codExpected, prepaid, expected) => {
    expect(firstCashState({ codExpectedAmount: codExpected, prepaidAmount: prepaid })).toBe(
      expected,
    );
  });
});

describe('replayStates', () => {
  const event = (machine: 'fulfillment' | 'cash', fromState: string | null, toState: string) => ({
    machine,
    fromState,
    toState,
  });

  it('rebuilds both states from an ordered event list', () => {
    const states = replayStates([
      event('fulfillment', null, 'new'),
      event('cash', null, 'unpaid'),
      event('fulfillment', 'new', 'confirmed'),
      event('fulfillment', 'confirmed', 'packed'),
      event('fulfillment', 'packed', 'shipped'),
      event('fulfillment', 'shipped', 'delivered'),
      event('cash', 'unpaid', 'collected_by_carrier'),
      event('cash', 'collected_by_carrier', 'remitted'),
    ]);
    expect(states).toEqual({ fulfillment: 'delivered', cash: 'remitted' });
  });

  it('lets an import set the first state as found', () => {
    const states = replayStates([
      event('fulfillment', null, 'delivered'),
      event('cash', null, 'reconciled'),
    ]);
    expect(states).toEqual({ fulfillment: 'delivered', cash: 'reconciled' });
  });

  it('gives null for a machine with no events', () => {
    expect(replayStates([])).toEqual({ fulfillment: null, cash: null });
  });

  it('refuses a first event with a from state', () => {
    expect(() => replayStates([event('fulfillment', 'new', 'confirmed')])).toThrow(
      InvalidEventHistory,
    );
  });

  it('refuses a later event whose from state is null or is not the current state', () => {
    expect(() =>
      replayStates([event('fulfillment', null, 'new'), event('fulfillment', null, 'confirmed')]),
    ).toThrow(InvalidEventHistory);
    expect(() =>
      replayStates([event('fulfillment', null, 'new'), event('fulfillment', 'packed', 'shipped')]),
    ).toThrow(InvalidEventHistory);
  });

  it('refuses a value outside the machine enum', () => {
    expect(() => replayStates([event('cash', null, 'delivered')])).toThrow(InvalidEventHistory);
  });
});
