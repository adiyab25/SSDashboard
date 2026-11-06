import { describe, expect, it } from 'vitest';
import {
  InvalidAmountError,
  LineAmounts,
  Money,
  mulDivRound,
  Quantity,
  UnitCost,
} from '../src/index.js';

describe('mulDivRound', () => {
  it.each([
    [5n, 1n, 2n, 3n],
    [-5n, 1n, 2n, -3n],
    [4n, 1n, 3n, 1n],
    [-4n, 1n, 3n, -1n],
    [5n, -1n, 2n, -3n],
    [7n, 1n, -2n, -4n],
  ])('rounds %d × %d / %d half away from zero to %d', (a, b, c, expected) => {
    expect(mulDivRound(a, b, c)).toBe(expected);
  });

  it('refuses to divide by zero', () => {
    expect(() => mulDivRound(1n, 1n, 0n)).toThrow(InvalidAmountError);
  });
});

describe('Money', () => {
  it('keeps exactly 2 decimals in its text form', () => {
    expect(Money.of('12.5').toString()).toBe('12.50');
    expect(Money.of(-3).toString()).toBe('-3.00');
    expect(Money.of('0.07').toString()).toBe('0.07');
  });

  it('never copies the rejected input into the error message', () => {
    for (const bad of ['12,50 secret', '1.005', 'Mona 0100']) {
      try {
        Money.of(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidAmountError);
        expect((error as Error).message).not.toContain(bad);
      }
    }
    expect(() => Quantity.of(1.5)).toThrow(/whole number$/);
  });

  it('rejects more than 2 decimals instead of rounding silently', () => {
    expect(() => Money.of('1.005')).toThrow(InvalidAmountError);
  });

  it('rejects text that is not a number', () => {
    expect(() => Money.of('12,50')).toThrow(InvalidAmountError);
    expect(() => Money.of(Number.NaN)).toThrow(InvalidAmountError);
  });

  it('rejects amounts that do not fit numeric(14,2)', () => {
    expect(() => Money.of('1000000000000.00')).toThrow(InvalidAmountError);
    expect(Money.of('999999999999.99').toString()).toBe('999999999999.99');
  });

  it('takes an exact proportional share, rounded once', () => {
    // 33.33 × 4 / 10 = 13.332
    expect(Money.of('33.33').share(4n, 10n).toString()).toBe('13.33');
    // 0.05 × 1 / 2 = 0.025 → 0.03 (half away from zero)
    expect(Money.of('0.05').share(1n, 2n).toString()).toBe('0.03');
    expect(Money.of('-0.05').share(1n, 2n).toString()).toBe('-0.03');
  });
});

describe('UnitCost', () => {
  it('keeps exactly 4 decimals', () => {
    expect(UnitCost.of('3.3333').toString()).toBe('3.3333');
    expect(UnitCost.of(10).toString()).toBe('10.0000');
  });

  it('is never negative', () => {
    expect(() => UnitCost.of('-1')).toThrow(InvalidAmountError);
  });

  it('extends to whole units rounded to the cent', () => {
    expect(UnitCost.of('3.3333').times(10).toString()).toBe('33.33');
    expect(UnitCost.of('0.0050').times(1).toString()).toBe('0.01');
  });

  it('derives a per unit cost from an amount, rounded to 4 decimals', () => {
    expect(UnitCost.perUnit(Money.of('-13.33'), -4).toString()).toBe('3.3325');
    expect(UnitCost.perUnit(Money.of('10.00'), 3).toString()).toBe('3.3333');
  });
});

describe('Quantity', () => {
  it('accepts whole numbers only', () => {
    expect(Quantity.of(-4).value).toBe(-4);
    expect(() => Quantity.of(1.5)).toThrow(InvalidAmountError);
  });

  it('refuses a zero movement', () => {
    expect(() => Quantity.movement(0)).toThrow(InvalidAmountError);
  });

  it('converts a line to base units with the unit factor', () => {
    expect(Quantity.inBaseUnits(3, 12).value).toBe(36);
  });
});

describe('LineAmounts.compute', () => {
  it('splits a VAT inclusive price into net and tax', () => {
    const result = LineAmounts.compute({
      quantity: 1,
      unitPrice: '114.00',
      taxRate: '14.00',
      pricesIncludeVat: true,
    });

    expect(result.net.toString()).toBe('100.00');
    expect(result.tax.toString()).toBe('14.00');
    expect(result.gross.toString()).toBe('114.00');
  });

  it('adds tax to a VAT exclusive price', () => {
    const result = LineAmounts.compute({
      quantity: 3,
      unitPrice: '10.00',
      discount: '5.00',
      taxRate: '14',
      pricesIncludeVat: false,
    });

    expect(result.net.toString()).toBe('25.00');
    expect(result.tax.toString()).toBe('3.50');
    expect(result.gross.toString()).toBe('28.50');
  });

  it('rounds tax halves away from zero', () => {
    // 0.25 × 14% = 0.035 → 0.04
    const result = LineAmounts.compute({
      quantity: 1,
      unitPrice: '0.25',
      taxRate: '14',
      pricesIncludeVat: false,
    });

    expect(result.tax.toString()).toBe('0.04');
  });

  it('keeps net plus tax equal to gross when VAT is included', () => {
    const result = LineAmounts.compute({
      quantity: 7,
      unitPrice: '9.99',
      taxRate: '14',
      pricesIncludeVat: true,
    });

    expect(result.net.plus(result.tax).equals(result.gross)).toBe(true);
    expect(result.gross.toString()).toBe('69.93');
    expect(result.net.toString()).toBe('61.34');
  });

  it.each([
    ['a discount larger than the line', { discount: '20.01' }],
    ['a negative price', { unitPrice: '-1' }],
    ['a tax rate above 100', { taxRate: '100.01' }],
    ['a fractional quantity', { quantity: 1.5 }],
  ])('rejects %s', (_case, override) => {
    expect(() =>
      LineAmounts.compute({
        quantity: 2,
        unitPrice: '10.00',
        taxRate: '14',
        pricesIncludeVat: true,
        ...override,
      }),
    ).toThrow(InvalidAmountError);
  });
});
