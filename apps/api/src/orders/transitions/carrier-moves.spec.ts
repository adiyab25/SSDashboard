import { describe, expect, it } from 'vitest';
import type { PlanLine } from '../editing/edit-plan.js';
import { InvalidOrderInput } from '../orders.errors.js';
import {
  assertWellFormedFact,
  leavesNothingToCollect,
  lineMoveOf,
  linesAfterMoves,
  moneyAfter,
  planLineMoves,
  planPartialDelivery,
} from './carrier-moves.js';

const line = (over: Partial<PlanLine> & Pick<PlanLine, 'id' | 'position'>): PlanLine => ({
  variantId: null,
  quantity: 1,
  unitPrice: '800.00',
  discountAmount: '0.00',
  netAmount: '701.75',
  taxRate: '14.00',
  taxAmount: '98.25',
  grossAmount: '800.00',
  lineState: 'open',
  channelLineId: null,
  prepaidAmount: '0.00',
  creditAppliedAmount: '0.00',
  ...over,
});

const SHIPPING = {
  shippingChargedAmount: '50.00',
  shippingPrepaidAmount: '0.00',
  shippingCreditAppliedAmount: '0.00',
};

describe('assertWellFormedFact (spec 0013 AC-15: only a malformed fact throws)', () => {
  it('accepts every carrier fact with what it needs', () => {
    expect(() => assertWellFormedFact({ to: 'shipped' })).not.toThrow();
    expect(() => assertWellFormedFact({ to: 'refused', reasonCode: 'size' })).not.toThrow();
    expect(() =>
      assertWellFormedFact({ to: 'cancelled', reasonCode: 'carrier.terminated_before_pickup' }),
    ).not.toThrow();
  });

  it.each([
    ['a state outside the facts', { to: 'teleported' }],
    ['partially_delivered (it needs the split)', { to: 'partially_delivered' }],
    ['a refusal without a reason', { to: 'refused' }],
    ['a refusal with an unknown reason', { to: 'refused', reasonCode: 'weather' }],
    ['a carrier cancel without a carrier code', { to: 'cancelled', reasonCode: 'fake' }],
  ])('refuses %s with InvalidOrderInput', (_name, fact) => {
    expect(() => assertWellFormedFact(fact)).toThrow(InvalidOrderInput);
  });
});

describe('line moves of a carrier fact', () => {
  it('moves every open line, and only open lines, for delivered, returned, and lost', () => {
    const lines = [
      line({ id: 'a', position: 1 }),
      line({ id: 'b', position: 2, lineState: 'cancelled' }),
      line({ id: 'c', position: 3 }),
    ];
    expect(lineMoveOf('returned_to_origin')).toBe('returned_to_origin');
    expect(planLineMoves(lines, 'lost')).toEqual([
      { lineId: 'a', to: 'lost' },
      { lineId: 'c', to: 'lost' },
    ]);
  });

  it.each(['shipped', 'failed_attempt', 'refused', 'cancelled'] as const)(
    'moves no line for %s',
    (to) => {
      expect(lineMoveOf(to)).toBeNull();
    },
  );

  it('takes cod_due_amount to 0 once every line came back (spec 0002 B2)', () => {
    const lines = [line({ id: 'a', position: 1 }), line({ id: 'b', position: 2 })];
    const moves = planLineMoves(lines, 'returned_to_origin');
    expect(moneyAfter(SHIPPING, linesAfterMoves(lines, moves), 'returned_to_origin')).toEqual({
      codDueAmount: '0.00',
      deliveredAmount: '0.00',
    });
  });

  it('keeps the whole amount due and counts the delivered gross on delivered', () => {
    const lines = [line({ id: 'a', position: 1 }), line({ id: 'b', position: 2 })];
    const moves = planLineMoves(lines, 'delivered');
    expect(moneyAfter(SHIPPING, linesAfterMoves(lines, moves), 'delivered')).toEqual({
      codDueAmount: '1650.00',
      deliveredAmount: '1600.00',
    });
  });
});

describe('leavesNothingToCollect (the guard nextState leaves to the service)', () => {
  const base = {
    cashState: 'unpaid' as const,
    fulfillmentState: 'returned_to_origin' as const,
    codDueAmount: '0.00',
    codCollectedAmount: '0.00',
  };

  it('holds for unpaid cash, a final failed state, nothing due, and nothing collected', () => {
    expect(leavesNothingToCollect(base)).toBe(true);
  });

  it.each([
    ['an amount still due', { codDueAmount: '10.00' }],
    ['cash already collected', { codCollectedAmount: '10.00' }],
    ['cash that is not unpaid', { cashState: 'collected_by_carrier' as const }],
    ['a delivered order', { fulfillmentState: 'delivered' as const }],
  ])('does not hold with %s', (_name, over) => {
    expect(leavesNothingToCollect({ ...base, ...over })).toBe(false);
  });
});

describe('planPartialDelivery (spec 0013 AC-16, spec 0002 worked example)', () => {
  it('splits the worked example: 3 pieces of 2,400.00 plus 50.00 shipping, one back', () => {
    const lines = [
      line({
        id: 'tee',
        position: 1,
        quantity: 3,
        unitPrice: '800.00',
        grossAmount: '2400.00',
        netAmount: '2105.26',
        taxAmount: '294.74',
      }),
    ];
    const plan = planPartialDelivery(lines, [{ lineId: 'tee', deliveredQuantity: 2 }]);

    expect(plan.moves).toEqual([]);
    expect(plan.splits).toHaveLength(1);
    expect(plan.splits[0]?.returned).toMatchObject({ quantity: 1, grossAmount: '800.00' });
    expect(plan.splits[0]?.delivered).toMatchObject({ quantity: 2, grossAmount: '1600.00' });
    expect(plan.deliveredUnits).toBe(2);
    expect(plan.returnedUnits).toBe(1);
    expect(moneyAfter(SHIPPING, plan.after, 'partially_delivered')).toEqual({
      codDueAmount: '1650.00',
      deliveredAmount: '1600.00',
    });
  });

  it('splits the discounted line of the worked example to the cent (333.33 and 666.67)', () => {
    const lines = [
      line({
        id: 'x',
        position: 1,
        quantity: 3,
        unitPrice: '366.67',
        discountAmount: '100.00',
        grossAmount: '1000.00',
        netAmount: '877.19',
        taxAmount: '122.81',
      }),
    ];
    const [split] = planPartialDelivery(lines, [{ lineId: 'x', deliveredQuantity: 2 }]).splits;

    expect(split?.returned).toMatchObject({ grossAmount: '333.33', discountAmount: '33.33' });
    expect(split?.delivered).toMatchObject({ grossAmount: '666.67', discountAmount: '66.67' });
  });

  it('delivers or returns a line of one piece whole and delivers every line not named', () => {
    const lines = [
      line({ id: 'one', position: 1 }),
      line({ id: 'two', position: 2 }),
      line({ id: 'gone', position: 3, lineState: 'cancelled' }),
    ];
    const plan = planPartialDelivery(lines, [{ lineId: 'one', deliveredQuantity: 0 }]);

    expect(plan.moves).toEqual([
      { lineId: 'one', to: 'returned_to_origin' },
      { lineId: 'two', to: 'delivered' },
    ]);
    expect(plan.splits).toEqual([]);
    expect(plan.after.map((row) => row.lineState)).toEqual([
      'returned_to_origin',
      'delivered',
      'cancelled',
    ]);
  });

  it.each([
    [
      'a line named twice',
      [
        { lineId: 'a', deliveredQuantity: 1 },
        { lineId: 'A', deliveredQuantity: 0 },
      ],
    ],
    ['an unknown line', [{ lineId: 'zz', deliveredQuantity: 0 }]],
    ['a cancelled line', [{ lineId: 'c', deliveredQuantity: 0 }]],
    ['more than the quantity', [{ lineId: 'a', deliveredQuantity: 3 }]],
    ['a negative quantity', [{ lineId: 'a', deliveredQuantity: -1 }]],
    ['a fraction', [{ lineId: 'a', deliveredQuantity: 0.5 }]],
  ])('refuses %s', (_name, asked) => {
    const lines = [
      line({
        id: 'a',
        position: 1,
        quantity: 2,
        grossAmount: '1600.00',
        netAmount: '1403.51',
        taxAmount: '196.49',
      }),
      line({ id: 'c', position: 2, lineState: 'cancelled' }),
    ];
    expect(() => planPartialDelivery(lines, asked)).toThrow(InvalidOrderInput);
  });

  it('reports no returned unit when everything was delivered (the caller refuses it)', () => {
    const plan = planPartialDelivery([line({ id: 'a', position: 1 })], []);
    expect(plan.returnedUnits).toBe(0);
    expect(plan.deliveredUnits).toBe(1);
  });
});
