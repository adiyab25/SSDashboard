import { Money, UnitCost } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { costInbound, costOutbound, type BalanceState, type CostedLine } from './costing.js';

const empty: BalanceState = { onHand: 0, totalValue: Money.zero, avgUnitCost: UnitCost.zero };

function balance(onHand: number, totalValue: string, avgUnitCost: string): BalanceState {
  return { onHand, totalValue: Money.of(totalValue), avgUnitCost: UnitCost.of(avgUnitCost) };
}

function receive(state: BalanceState, quantity: number, price: string): CostedLine {
  return costInbound(state, quantity, UnitCost.of(price));
}

function text(line: CostedLine) {
  return {
    totalCost: line.totalCost.toString(),
    unitCost: line.unitCost.toString(),
    costVariance: line.costVariance.toString(),
    costUnknown: line.costUnknown,
    onHand: line.next.onHand,
    totalValue: line.next.totalValue.toString(),
    avgUnitCost: line.next.avgUnitCost.toString(),
  };
}

describe('ledger costing (spec 0002)', () => {
  it('values a receipt at quantity × unit cost, rounded once', () => {
    expect(text(receive(empty, 10, '3.3333'))).toEqual({
      totalCost: '33.33',
      unitCost: '3.3333',
      costVariance: '0.00',
      costUnknown: false,
      onHand: 10,
      totalValue: '33.33',
      avgUnitCost: '3.3330',
    });
  });

  it('takes the exact remaining value on the outbound that empties a balance (AC-12)', () => {
    const received = receive(empty, 10, '3.3333').next;

    const first = costOutbound(received, -4);
    const second = costOutbound(first.next, -6);

    expect(first.totalCost.toString()).toBe('-13.33');
    expect(first.unitCost.toString()).toBe('3.3325');
    expect(second.totalCost.toString()).toBe('-20.00');
    expect(second.next.onHand).toBe(0);
    expect(second.next.totalValue.toString()).toBe('0.00');
    // The average survives the balance reaching zero.
    expect(second.next.avgUnitCost.toString()).toBe('3.3330');
  });

  it('never changes the average on an outbound line', () => {
    const state = balance(3, '10.00', '3.3333');

    expect(costOutbound(state, -1).next.avgUnitCost.toString()).toBe('3.3333');
  });

  describe('negative stock', () => {
    // 3 on hand at 30.00, ship 5: the first 3 take 30.00, the other 2 cost 20.00.
    const shipped = costOutbound(balance(3, '30.00', '10.0000'), -5);

    it('costs units beyond zero at the kept average', () => {
      expect(shipped.totalCost.toString()).toBe('-50.00');
      expect(shipped.next.onHand).toBe(-2);
      expect(shipped.next.totalValue.toString()).toBe('-20.00');
    });

    it('closes the shortfall at its own value and costs the rest at the receipt price', () => {
      expect(text(receive(shipped.next, 5, '12.0000'))).toEqual({
        totalCost: '56.00',
        unitCost: '12.0000',
        costVariance: '4.00',
        costUnknown: false,
        onHand: 3,
        totalValue: '36.00',
        avgUnitCost: '12.0000',
      });
    });

    it('lands on exactly 0.00 when a receipt fills the shortfall exactly', () => {
      const line = receive(shipped.next, 2, '12.0000');

      expect(line.next.onHand).toBe(0);
      expect(line.next.totalValue.toString()).toBe('0.00');
      expect(line.costVariance.toString()).toBe('4.00');
    });

    it('takes a proportional share of the shortfall when a receipt does not fill it', () => {
      const line = receive(shipped.next, 1, '12.0000');

      expect(line.totalCost.toString()).toBe('10.00');
      expect(line.next.onHand).toBe(-1);
      expect(line.next.totalValue.toString()).toBe('-10.00');
      expect(line.next.avgUnitCost.toString()).toBe('10.0000');
    });

    it('costs an outbound from an empty, never costed balance at 0 and flags it', () => {
      const line = costOutbound(empty, -2);

      expect(line.totalCost.toString()).toBe('0.00');
      expect(line.costUnknown).toBe(true);
      expect(line.next.onHand).toBe(-2);
    });

    it('closes an unknown cost shortfall at 0, with the whole receipt as variance', () => {
      const short = costOutbound(empty, -2).next;

      const line = receive(short, 2, '5.0000');

      expect(line.totalCost.toString()).toBe('0.00');
      expect(line.costVariance.toString()).toBe('10.00');
      expect(line.next.totalValue.toString()).toBe('0.00');
    });

    it('still gives a zero cost receipt the shortfall value, so its variance is negative', () => {
      const line = receive(shipped.next, 2, '0');

      expect(line.totalCost.toString()).toBe('20.00');
      expect(line.costVariance.toString()).toBe('-20.00');
    });
  });

  it('costs a reversed receipt by the outbound rule and records the gap as variance', () => {
    // Receive 5 at 10 and 5 at 20 (10, 150.00), ship 5 (5, 75.00), receive 3 at 1 (8, 78.00).
    let state = receive(empty, 5, '10.0000').next;
    const reversed = receive(state, 5, '20.0000');
    state = costOutbound(reversed.next, -5).next;
    state = receive(state, 3, '1.0000').next;
    expect(state.totalValue.toString()).toBe('78.00');

    // Reversing the 5 at 20.0000 receipt: reference cost is −(100.00 + 0.00).
    const line = costOutbound(state, -5, reversed.totalCost.plus(reversed.costVariance).negate());

    expect(line.totalCost.toString()).toBe('-48.75');
    expect(line.costVariance.toString()).toBe('-51.25');
    expect(line.next.onHand).toBe(3);
    expect(line.next.totalValue.toString()).toBe('29.25');
  });

  it('keeps value and on hand on the same sign through a long mixed sequence', () => {
    let state = empty;
    const steps: [number, string][] = [
      [7, '1.1111'],
      [-3, ''],
      [-9, ''],
      [4, '2.5000'],
      [-1, ''],
      [11, '0.3333'],
      [-12, ''],
      [3, '9.9999'],
    ];
    for (const [quantity, price] of steps) {
      state = (quantity > 0 ? receive(state, quantity, price) : costOutbound(state, quantity)).next;
      if (state.onHand === 0) expect(state.totalValue.isZero()).toBe(true);
      else if (!state.totalValue.isZero()) {
        expect(state.totalValue.sign()).toBe(Math.sign(state.onHand));
      }
    }
  });
});
