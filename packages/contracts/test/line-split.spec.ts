import { describe, expect, it } from 'vitest';
import { LineCannotSplit, Money, splitLine, type SplittableLine } from '../src/index.js';

const line: SplittableLine = {
  quantity: 3,
  grossAmount: '1000.00',
  netAmount: '877.19',
  taxAmount: '122.81',
  discountAmount: '100.00',
  prepaidAmount: '0.00',
  creditAppliedAmount: '0.00',
};

describe('splitLine worked example', () => {
  it('splits 3 pieces at gross 1,000.00 with discount 100.00 into 2 delivered and 1 returned', () => {
    const { returned, delivered } = splitLine(line, 1);
    expect(returned.quantity).toBe(1);
    expect(returned.grossAmount).toBe('333.33');
    expect(returned.discountAmount).toBe('33.33');
    expect(delivered.quantity).toBe(2);
    expect(delivered.grossAmount).toBe('666.67');
    expect(delivered.discountAmount).toBe('66.67');
  });

  it('rounds net on the returned row and derives its tax as gross minus net', () => {
    const { returned, delivered } = splitLine(line, 1);
    expect(returned.netAmount).toBe('292.40'); // 877.19 / 3 = 292.3967
    expect(returned.taxAmount).toBe('40.93'); // 333.33 - 292.40
    expect(delivered.netAmount).toBe('584.79');
    expect(delivered.taxAmount).toBe('81.88');
  });

  it('splits prepaid and credit shares the same way', () => {
    const { returned, delivered } = splitLine(
      { ...line, prepaidAmount: '300.00', creditAppliedAmount: '100.00' },
      1,
    );
    expect(returned.prepaidAmount).toBe('100.00');
    expect(delivered.prepaidAmount).toBe('200.00');
    expect(returned.creditAppliedAmount).toBe('33.33');
    expect(delivered.creditAppliedAmount).toBe('66.67');
  });

  it('rounds half away from zero on the returned row', () => {
    // 0.05 * 1 / 2 = 0.025 -> 0.03 on the returned row, 0.02 stays.
    const { returned, delivered } = splitLine(
      {
        ...line,
        quantity: 2,
        grossAmount: '0.05',
        netAmount: '0.05',
        taxAmount: '0.00',
        discountAmount: '0.00',
      },
      1,
    );
    expect(returned.grossAmount).toBe('0.03');
    expect(delivered.grossAmount).toBe('0.02');
  });
});

describe('splitLine keeps prepaid + credit within gross on both rows', () => {
  it('splits 1.00 over 3 with prepaid 0.50 and credit 0.50 without breaking either row', () => {
    const { returned, delivered } = splitLine(
      {
        quantity: 3,
        grossAmount: '1.00',
        netAmount: '0.88',
        taxAmount: '0.12',
        discountAmount: '0.00',
        prepaidAmount: '0.50',
        creditAppliedAmount: '0.50',
      },
      1,
    );
    expect(returned.grossAmount).toBe('0.33');
    expect(returned.prepaidAmount).toBe('0.17');
    expect(returned.creditAppliedAmount).toBe('0.16');
    expect(delivered.prepaidAmount).toBe('0.33');
    expect(delivered.creditAppliedAmount).toBe('0.34');
  });
});

describe('splitLine refusals', () => {
  it('cannot split a line of one piece', () => {
    expect(() => splitLine({ ...line, quantity: 1 }, 1)).toThrow(LineCannotSplit);
  });

  it.each([0, 3, 4, -1, 1.5])('cannot return %d of 3 pieces', (returnedQuantity) => {
    expect(() => splitLine(line, returnedQuantity)).toThrow(LineCannotSplit);
  });

  it('carries a stable code', () => {
    try {
      splitLine({ ...line, quantity: 1 }, 1);
      expect.unreachable();
    } catch (error) {
      expect((error as LineCannotSplit).code).toBe('LineCannotSplit');
    }
  });
});

describe('splitLine property: the two rows always sum to the original', () => {
  // A small deterministic generator keeps the test fast and repeatable without a new dependency.
  let seed = 123456789;
  const next = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };

  it('holds for 5,000 generated lines', () => {
    for (let i = 0; i < 5000; i += 1) {
      const quantity = 2 + next(40);
      const returnedQuantity = 1 + next(quantity - 1);
      const gross = 1 + next(5_000_000);
      const net = Math.max(0, gross - next(Math.floor(gross / 4) + 1));
      const discount = next(gross);
      const prepaid = next(gross + 1);
      const credit = next(gross - prepaid + 1);
      const original: SplittableLine = {
        quantity,
        grossAmount: Money.fromCents(BigInt(gross)).toString(),
        netAmount: Money.fromCents(BigInt(net)).toString(),
        taxAmount: Money.fromCents(BigInt(gross - net)).toString(),
        discountAmount: Money.fromCents(BigInt(discount)).toString(),
        prepaidAmount: Money.fromCents(BigInt(prepaid)).toString(),
        creditAppliedAmount: Money.fromCents(BigInt(credit)).toString(),
      };
      const { returned, delivered } = splitLine(original, returnedQuantity);
      expect(returned.quantity + delivered.quantity).toBe(quantity);
      for (const key of [
        'grossAmount',
        'netAmount',
        'taxAmount',
        'discountAmount',
        'prepaidAmount',
        'creditAppliedAmount',
      ] as const) {
        const sum = Money.of(returned[key]).plus(Money.of(delivered[key]));
        expect(sum.toString(), `${key} case ${i}`).toBe(original[key]);
      }
      for (const row of [returned, delivered]) {
        const shares = Money.of(row.prepaidAmount).plus(Money.of(row.creditAppliedAmount));
        expect(
          shares.cents <= Money.of(row.grossAmount).cents,
          `shares within gross, case ${i}`,
        ).toBe(true);
        expect(Money.of(row.prepaidAmount).sign()).toBeGreaterThanOrEqual(0);
        expect(Money.of(row.creditAppliedAmount).sign()).toBeGreaterThanOrEqual(0);
        expect(Money.of(row.netAmount).plus(Money.of(row.taxAmount)).toString()).toBe(
          row.grossAmount,
        );
      }
    }
  });
});
