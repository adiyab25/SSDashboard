import { describe, expect, it } from 'vitest';
import {
  FulfillmentState,
  OrderOutcome,
  deliveredAmountOf,
  deriveOrderOutcome,
  refundedAmountOf,
  type FulfillmentState as Fulfillment,
} from '../src/index.js';

const zero = {
  deliveredAmount: '0.00',
  returnedCreditAmount: '0.00',
  exchangeConsumedAmount: '0.00',
};

function outcome(fulfillmentState: Fulfillment, amounts: Partial<typeof zero> = {}): OrderOutcome {
  return deriveOrderOutcome({ fulfillmentState, ...zero, deliveredAmount: '1000.00', ...amounts });
}

describe('deriveOrderOutcome table rows', () => {
  it('lists the outcomes', () => {
    expect(OrderOutcome.options).toEqual([
      'open',
      'kept',
      'cancelled_before_shipping',
      'failed_delivery',
      'refunded',
      'partially_refunded',
    ]);
  });

  it('cancelled is cancelled_before_shipping', () => {
    expect(outcome('cancelled')).toBe('cancelled_before_shipping');
  });

  it.each(['new', 'confirmed', 'packed', 'shipped', 'failed_attempt'] as const)(
    '%s is open',
    (state) => {
      expect(outcome(state)).toBe('open');
    },
  );

  it.each(['refused', 'returned_to_origin', 'lost'] as const)('%s is failed_delivery', (state) => {
    expect(outcome(state)).toBe('failed_delivery');
  });

  it.each(['delivered', 'partially_delivered', 'exchanged'] as const)(
    '%s with nothing refunded is kept',
    (state) => {
      expect(outcome(state)).toBe('kept');
    },
  );

  it.each(['delivered', 'partially_delivered', 'exchanged'] as const)(
    '%s with 0 < refunded < delivered is partially_refunded',
    (state) => {
      expect(outcome(state, { returnedCreditAmount: '500.00' })).toBe('partially_refunded');
    },
  );

  it.each(['delivered', 'partially_delivered', 'exchanged'] as const)(
    '%s with refunded >= delivered is refunded',
    (state) => {
      expect(outcome(state, { returnedCreditAmount: '1000.00' })).toBe('refunded');
      expect(outcome(state, { returnedCreditAmount: '1200.00' })).toBe('refunded');
    },
  );

  it('covers every fulfillment state', () => {
    for (const state of FulfillmentState.options) {
      expect(OrderOutcome.options).toContain(outcome(state));
    }
  });
});

describe('deriveOrderOutcome scenarios', () => {
  it('two delivered 500 pieces, one returned and refunded: partially_refunded, delivered still 1,000', () => {
    const delivered = deliveredAmountOf([
      { lineState: 'delivered', grossAmount: '500.00' },
      { lineState: 'returned', grossAmount: '500.00' },
    ]);
    expect(delivered).toBe('1000.00');
    expect(
      deriveOrderOutcome({
        fulfillmentState: 'delivered',
        deliveredAmount: delivered,
        returnedCreditAmount: '500.00',
        exchangeConsumedAmount: '0.00',
      }),
    ).toBe('partially_refunded');
  });

  it('an 800 to 500 exchange refunds 300 of 800: partially_refunded', () => {
    const input = {
      fulfillmentState: 'exchanged',
      deliveredAmount: '800.00',
      returnedCreditAmount: '800.00',
      exchangeConsumedAmount: '500.00',
    } as const;
    expect(refundedAmountOf(input)).toBe('300.00');
    expect(deriveOrderOutcome(input)).toBe('partially_refunded');
  });

  it('a 500 to 800 exchange consumes all the credit: kept', () => {
    const input = {
      fulfillmentState: 'exchanged',
      deliveredAmount: '500.00',
      returnedCreditAmount: '500.00',
      exchangeConsumedAmount: '500.00',
    } as const;
    expect(refundedAmountOf(input)).toBe('0.00');
    expect(deriveOrderOutcome(input)).toBe('kept');
  });

  it('never lets the refunded amount go negative', () => {
    expect(
      refundedAmountOf({
        returnedCreditAmount: '100.00',
        exchangeConsumedAmount: '400.00',
      }),
    ).toBe('0.00');
  });

  it('a refund only return that leaves fulfillment delivered is refunded', () => {
    expect(
      deriveOrderOutcome({
        fulfillmentState: 'delivered',
        deliveredAmount: '1000.00',
        returnedCreditAmount: '1000.00',
        exchangeConsumedAmount: '0.00',
      }),
    ).toBe('refunded');
  });

  it('a delivered state with no delivered amount and nothing refunded is kept, not refunded', () => {
    expect(outcome('delivered', { deliveredAmount: '0.00' })).toBe('kept');
  });
});

describe('deliveredAmountOf', () => {
  it('sums gross over delivered and returned lines only', () => {
    expect(
      deliveredAmountOf([
        { lineState: 'delivered', grossAmount: '666.67' },
        { lineState: 'returned', grossAmount: '100.00' },
        { lineState: 'returned_to_origin', grossAmount: '333.33' },
        { lineState: 'lost', grossAmount: '50.00' },
        { lineState: 'cancelled', grossAmount: '70.00' },
        { lineState: 'open', grossAmount: '10.00' },
      ]),
    ).toBe('766.67');
  });

  it('is 0.00 for no lines', () => {
    expect(deliveredAmountOf([])).toBe('0.00');
  });
});
