import { describe, expect, it } from 'vitest';
import {
  InvalidAmountError,
  Money,
  allocatePayments,
  codDue,
  codExpected,
  linesGrossAmountOf,
  splitLine,
} from '../src/index.js';

describe('allocatePayments', () => {
  const lines = [
    { position: 1, lineState: 'open', grossAmount: '600.00' },
    { position: 2, lineState: 'open', grossAmount: '350.00' },
  ] as const;

  it('spreads 300.00 credit over lines 600 and 350 and shipping 50: 180.00, 105.00, 15.00', () => {
    const result = allocatePayments({
      lines,
      shippingChargedAmount: '50.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '300.00',
    });
    expect(result.lines).toEqual([
      { position: 1, prepaidAmount: '0.00', creditAppliedAmount: '180.00' },
      { position: 2, prepaidAmount: '0.00', creditAppliedAmount: '105.00' },
    ]);
    expect(result.shippingPrepaidAmount).toBe('0.00');
    expect(result.shippingCreditAppliedAmount).toBe('15.00');
  });

  it('allocates prepaid and credit independently', () => {
    const result = allocatePayments({
      lines,
      shippingChargedAmount: '50.00',
      prepaidAmount: '100.00',
      creditAppliedAmount: '300.00',
    });
    expect(result.lines[0]).toEqual({
      position: 1,
      prepaidAmount: '60.00',
      creditAppliedAmount: '180.00',
    });
    expect(result.lines[1]).toEqual({
      position: 2,
      prepaidAmount: '35.00',
      creditAppliedAmount: '105.00',
    });
    expect(result.shippingPrepaidAmount).toBe('5.00');
  });

  it('a cancelled line leaves the allocation of the others', () => {
    // Order is now 600 + 50 = 650; 300 credit: 600/650 -> 276.92, shipping takes the rest 23.08.
    const result = allocatePayments({
      lines: [
        { position: 1, lineState: 'open', grossAmount: '600.00' },
        { position: 2, lineState: 'cancelled', grossAmount: '350.00' },
      ],
      shippingChargedAmount: '50.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '300.00',
    });
    expect(result.lines).toEqual([
      { position: 1, prepaidAmount: '0.00', creditAppliedAmount: '276.92' },
      { position: 2, prepaidAmount: '0.00', creditAppliedAmount: '0.00' },
    ]);
    expect(result.shippingCreditAppliedAmount).toBe('23.08');
    expect(
      linesGrossAmountOf([
        { position: 1, lineState: 'open', grossAmount: '600.00' },
        { position: 2, lineState: 'cancelled', grossAmount: '350.00' },
      ]),
    ).toBe('600.00');
  });

  it('allocates in position order whatever order the lines arrive in', () => {
    const result = allocatePayments({
      lines: [
        { position: 2, lineState: 'open', grossAmount: '350.00' },
        { position: 1, lineState: 'open', grossAmount: '600.00' },
      ],
      shippingChargedAmount: '50.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '300.00',
    });
    expect(result.lines.map((l) => l.position)).toEqual([1, 2]);
  });

  it('gives everything 0 for a zero total (a gifted order)', () => {
    const result = allocatePayments({
      lines: [{ position: 1, lineState: 'open', grossAmount: '0.00' }],
      shippingChargedAmount: '0.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
    });
    expect(result.lines[0]?.prepaidAmount).toBe('0.00');
    expect(result.shippingCreditAppliedAmount).toBe('0.00');
  });

  it('always sums to the amount and never gives shipping a negative share', () => {
    for (const amount of ['0.01', '0.02', '0.05', '1.00', '2.99']) {
      const result = allocatePayments({
        lines: [
          { position: 1, lineState: 'open', grossAmount: '1.00' },
          { position: 2, lineState: 'open', grossAmount: '1.00' },
          { position: 3, lineState: 'open', grossAmount: '1.00' },
        ],
        shippingChargedAmount: '0.00',
        prepaidAmount: '0.00',
        creditAppliedAmount: amount,
      });
      const lineSum = result.lines.reduce(
        (sum, l) => sum.plus(Money.of(l.creditAppliedAmount)),
        Money.zero,
      );
      const total = lineSum.plus(Money.of(result.shippingCreditAppliedAmount));
      expect(total.toString(), amount).toBe(Money.of(amount).toString());
      expect(Money.of(result.shippingCreditAppliedAmount).sign()).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('allocatePayments at the cent boundary', () => {
  it('three lines of 100.00, no shipping, 100.00 credit: shipping stays 0.00, the last line takes the cent', () => {
    const result = allocatePayments({
      lines: [1, 2, 3].map(
        (position) => ({ position, lineState: 'open', grossAmount: '100.00' }) as const,
      ),
      shippingChargedAmount: '0.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '100.00',
    });
    expect(result.lines.map((l) => l.creditAppliedAmount)).toEqual(['33.33', '33.33', '33.34']);
    expect(result.shippingCreditAppliedAmount).toBe('0.00');
    expect(result.shippingPrepaidAmount).toBe('0.00');
  });

  it('lines 0.33, 0.33, 0.34 with prepaid 0.50 and credit 0.50: no line exceeds its gross', () => {
    const result = allocatePayments({
      lines: [
        { position: 1, lineState: 'open', grossAmount: '0.33' },
        { position: 2, lineState: 'open', grossAmount: '0.33' },
        { position: 3, lineState: 'open', grossAmount: '0.34' },
      ],
      shippingChargedAmount: '0.00',
      prepaidAmount: '0.50',
      creditAppliedAmount: '0.50',
    });
    expect(result.lines).toEqual([
      { position: 1, prepaidAmount: '0.17', creditAppliedAmount: '0.16' },
      { position: 2, prepaidAmount: '0.17', creditAppliedAmount: '0.16' },
      { position: 3, prepaidAmount: '0.16', creditAppliedAmount: '0.18' },
    ]);
  });

  it('throws when two lines share a position', () => {
    expect(() =>
      allocatePayments({
        lines: [
          { position: 1, lineState: 'open', grossAmount: '100.00' },
          { position: 1, lineState: 'open', grossAmount: '50.00' },
        ],
        shippingChargedAmount: '0.00',
        prepaidAmount: '0.00',
        creditAppliedAmount: '10.00',
      }),
    ).toThrow(InvalidAmountError);
  });

  it('throws when prepaid plus credit is more than the order total', () => {
    expect(() =>
      allocatePayments({
        lines: [{ position: 1, lineState: 'open', grossAmount: '100.00' }],
        shippingChargedAmount: '0.00',
        prepaidAmount: '60.00',
        creditAppliedAmount: '50.00',
      }),
    ).toThrow(InvalidAmountError);
  });

  it('keeps every check for 5,000 seeded random orders', () => {
    let seed = 987654321;
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const cents = (value: number): string => Money.fromCents(BigInt(value)).toString();
    for (let i = 0; i < 5000; i += 1) {
      const lines = Array.from({ length: 1 + next(5) }, (_, index) => ({
        position: index + 1,
        lineState: next(5) === 0 ? ('cancelled' as const) : ('open' as const),
        grossAmount: cents(1 + next(100_000)),
      }));
      const shipping = next(3) === 0 ? 0 : next(5000);
      const total =
        lines.reduce(
          (sum, l) => (l.lineState === 'cancelled' ? sum : sum + Money.of(l.grossAmount).cents),
          0n,
        ) + BigInt(shipping);
      const totalNumber = Number(total);
      const prepaid = next(totalNumber + 1);
      const credit = next(totalNumber - prepaid + 1);
      const result = allocatePayments({
        lines,
        shippingChargedAmount: cents(shipping),
        prepaidAmount: cents(prepaid),
        creditAppliedAmount: cents(credit),
      });
      let prepaidSum = Money.of(result.shippingPrepaidAmount);
      let creditSum = Money.of(result.shippingCreditAppliedAmount);
      expect(
        Money.of(result.shippingPrepaidAmount).plus(Money.of(result.shippingCreditAppliedAmount))
          .cents <= BigInt(shipping),
        `shipping within charge, case ${i}`,
      ).toBe(true);
      for (const share of result.lines) {
        const source = lines.find((l) => l.position === share.position);
        const gross =
          source?.lineState === 'cancelled' ? 0n : Money.of(source?.grossAmount ?? '0').cents;
        const p = Money.of(share.prepaidAmount);
        const c = Money.of(share.creditAppliedAmount);
        expect(p.sign()).toBeGreaterThanOrEqual(0);
        expect(c.sign()).toBeGreaterThanOrEqual(0);
        expect(p.plus(c).cents <= gross, `line within gross, case ${i}`).toBe(true);
        prepaidSum = prepaidSum.plus(p);
        creditSum = creditSum.plus(c);
      }
      expect(prepaidSum.toString(), `prepaid sum, case ${i}`).toBe(cents(prepaid));
      expect(creditSum.toString(), `credit sum, case ${i}`).toBe(cents(credit));
    }
  });
});

describe('codExpected', () => {
  it('is total minus prepaid minus credit', () => {
    expect(
      codExpected({
        totalAmount: '1000.00',
        prepaidAmount: '100.00',
        creditAppliedAmount: '300.00',
      }),
    ).toBe('600.00');
  });

  it('refuses a prepayment and credit above the total', () => {
    expect(() =>
      codExpected({ totalAmount: '100.00', prepaidAmount: '80.00', creditAppliedAmount: '30.00' }),
    ).toThrow(InvalidAmountError);
  });
});

describe('codDue', () => {
  const noShares = { prepaidAmount: '0.00', creditAppliedAmount: '0.00' };

  it('before delivery equals cod_expected', () => {
    expect(
      codDue({
        lines: [{ lineState: 'open', grossAmount: '2400.00', ...noShares }],
        shippingChargedAmount: '50.00',
        shippingPrepaidAmount: '0.00',
        shippingCreditAppliedAmount: '0.00',
      }),
    ).toBe('2450.00');
  });

  it('partial delivery: 2,400 of three pieces + 50 shipping all COD, one piece back', () => {
    const original = {
      quantity: 3,
      grossAmount: '2400.00',
      netAmount: '2105.26',
      taxAmount: '294.74',
      discountAmount: '0.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
    };
    const expected = codExpected({
      totalAmount: '2450.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
    });
    const { returned, delivered } = splitLine(original, 1);
    const due = codDue({
      lines: [
        { lineState: 'delivered', ...delivered },
        { lineState: 'returned_to_origin', ...returned },
      ],
      shippingChargedAmount: '50.00',
      shippingPrepaidAmount: '0.00',
      shippingCreditAppliedAmount: '0.00',
    });
    expect(expected).toBe('2450.00');
    expect(due).toBe('1650.00');
  });

  it('nets each kept line of its prepaid and credit shares and shipping of its own', () => {
    expect(
      codDue({
        lines: [
          {
            lineState: 'delivered',
            grossAmount: '600.00',
            prepaidAmount: '0.00',
            creditAppliedAmount: '180.00',
          },
          {
            lineState: 'returned',
            grossAmount: '350.00',
            prepaidAmount: '0.00',
            creditAppliedAmount: '105.00',
          },
          {
            lineState: 'lost',
            grossAmount: '100.00',
            prepaidAmount: '0.00',
            creditAppliedAmount: '0.00',
          },
        ],
        shippingChargedAmount: '50.00',
        shippingPrepaidAmount: '0.00',
        shippingCreditAppliedAmount: '15.00',
      }),
    ).toBe('700.00'); // 420 + 245 + 35
  });

  it.each(['returned_to_origin', 'lost', 'cancelled'] as const)(
    'is 0 when the only line is %s, shipping included',
    (lineState) => {
      expect(
        codDue({
          lines: [{ lineState, grossAmount: '500.00', ...noShares }],
          shippingChargedAmount: '50.00',
          shippingPrepaidAmount: '0.00',
          shippingCreditAppliedAmount: '0.00',
        }),
      ).toBe('0.00');
    },
  );

  it('never goes below 0', () => {
    expect(
      codDue({
        lines: [
          {
            lineState: 'open',
            grossAmount: '100.00',
            prepaidAmount: '100.00',
            creditAppliedAmount: '0.00',
          },
        ],
        shippingChargedAmount: '0.00',
        shippingPrepaidAmount: '0.00',
        shippingCreditAppliedAmount: '0.00',
      }),
    ).toBe('0.00');
    expect(
      codDue({
        lines: [
          {
            lineState: 'open',
            grossAmount: '100.00',
            prepaidAmount: '100.00',
            creditAppliedAmount: '0.00',
          },
        ],
        shippingChargedAmount: '10.00',
        shippingPrepaidAmount: '30.00',
        shippingCreditAppliedAmount: '0.00',
      }),
    ).toBe('0.00');
  });
});

describe('codDue on a cancelled order', () => {
  const lines = [
    {
      lineState: 'open',
      grossAmount: '800.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
    },
  ] as const;
  const shipping = {
    shippingChargedAmount: '50.00',
    shippingPrepaidAmount: '0.00',
    shippingCreditAppliedAmount: '0.00',
  };

  it('is 0 once the fulfillment state is cancelled, even with open lines', () => {
    expect(codDue({ lines, ...shipping, fulfillmentState: 'cancelled' })).toBe('0.00');
  });

  it('is unchanged for every other state or none', () => {
    expect(codDue({ lines, ...shipping })).toBe('850.00');
    expect(codDue({ lines, ...shipping, fulfillmentState: 'confirmed' })).toBe('850.00');
  });
});
