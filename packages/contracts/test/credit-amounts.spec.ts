import { describe, expect, it } from 'vitest';
import {
  CreditExceedsLine,
  DebtPaymentExceedsDebt,
  InsufficientCredit,
  InvalidAmountError,
  Money,
  creditBalance,
  creditBalanceByFunding,
  fundingOfTender,
  planConsumption,
  planDebtPayment,
  planPayout,
  returnCreditTotal,
  splitReturnCredit,
  splitReturnShares,
  type CreditFunding,
  type SplitReturnCreditInput,
} from '../src/index.js';

const none = 0;

describe('fundingOfTender', () => {
  it('maps each tender to its funding', () => {
    expect(fundingOfTender('cod')).toBe('cod_cash');
    expect(fundingOfTender('gateway')).toBe('gateway');
    expect(fundingOfTender('instapay')).toBe('instapay_or_transfer');
    expect(fundingOfTender('bank_transfer')).toBe('instapay_or_transfer');
    expect(fundingOfTender('wallet')).toBe('instapay_or_transfer');
  });
});

describe('returnCreditTotal', () => {
  it('credits a line of 2 at 999.99 as 500.00 then 499.99, and refuses a third unit', () => {
    const first = returnCreditTotal({
      quantity: 2,
      grossAmount: '999.99',
      units: 1,
      alreadyCredited: none,
    });
    expect(first).toBe('500.00');
    const second = returnCreditTotal({
      quantity: 2,
      grossAmount: '999.99',
      units: 1,
      alreadyCredited: 1,
    });
    expect(second).toBe('499.99');
    expect(() =>
      returnCreditTotal({
        quantity: 2,
        grossAmount: '999.99',
        units: 1,
        alreadyCredited: 2,
      }),
    ).toThrow(CreditExceedsLine);
  });

  it('refuses more units than the line holds in one posting', () => {
    expect(() =>
      returnCreditTotal({ quantity: 2, grossAmount: '10.00', units: 3, alreadyCredited: none }),
    ).toThrow(CreditExceedsLine);
  });

  it('credits everything in one posting of all units', () => {
    expect(
      returnCreditTotal({ quantity: 3, grossAmount: '100.00', units: 3, alreadyCredited: none }),
    ).toBe('100.00');
  });

  it('carries a typed code on the error', () => {
    try {
      returnCreditTotal({ quantity: 1, grossAmount: '1.00', units: 2, alreadyCredited: none });
      expect.unreachable();
    } catch (error) {
      expect((error as CreditExceedsLine).code).toBe('CreditExceedsLine');
    }
  });
});

describe('splitReturnCredit', () => {
  const codLine: SplitReturnCreditInput = {
    quantity: 1,
    grossAmount: '1200.00',
    creditAppliedAmount: '300.00',
    prepaidAmount: '0.00',
    paymentMethod: 'cod',
    prepaidMethod: null,
    consumptionDraws: [{ funding: 'credit_only', amount: '300.00' }],
    units: 1,
    alreadyCredited: none,
  };

  it('splits a 1,200.00 COD line with a 300.00 credit_only share into 300.00 credit_only and 900.00 cod_cash', () => {
    expect(splitReturnCredit(codLine)).toEqual([
      { funding: 'credit_only', amount: '300.00' },
      { funding: 'cod_cash', amount: '900.00' },
    ]);
  });

  it('puts the prepaid share on the prepaid method funding', () => {
    expect(
      splitReturnCredit({
        ...codLine,
        grossAmount: '1000.00',
        creditAppliedAmount: '0.00',
        prepaidAmount: '300.00',
        prepaidMethod: 'instapay',
        consumptionDraws: [],
      }),
    ).toEqual([
      { funding: 'instapay_or_transfer', amount: '300.00' },
      { funding: 'cod_cash', amount: '700.00' },
    ]);
  });

  it('merges shares that land on one funding into one entry', () => {
    expect(
      splitReturnCredit({
        ...codLine,
        creditAppliedAmount: '300.00',
        consumptionDraws: [{ funding: 'cod_cash', amount: '300.00' }],
      }),
    ).toEqual([{ funding: 'cod_cash', amount: '1200.00' }]);
  });

  it('returns the credit share to the fundings the order drew, in proportion, the last taking the rest', () => {
    expect(
      splitReturnCredit({
        ...codLine,
        grossAmount: '1000.00',
        creditAppliedAmount: '100.00',
        consumptionDraws: [
          { funding: 'credit_only', amount: '200.00' },
          { funding: 'cod_cash', amount: '100.00' },
          { funding: 'gateway', amount: '0.01' },
        ],
      }),
    ).toEqual([
      { funding: 'credit_only', amount: '66.66' },
      { funding: 'cod_cash', amount: '933.33' },
      { funding: 'gateway', amount: '0.01' },
    ]);
  });

  it('splits each share by k/n and lets the last units take the rest', () => {
    const base: SplitReturnCreditInput = {
      quantity: 3,
      grossAmount: '100.00',
      creditAppliedAmount: '10.00',
      prepaidAmount: '20.00',
      paymentMethod: 'cod',
      prepaidMethod: 'gateway',
      consumptionDraws: [{ funding: 'credit_only', amount: '10.00' }],
      units: 1,
      alreadyCredited: none,
    };
    expect(splitReturnCredit(base)).toEqual([
      { funding: 'credit_only', amount: '3.33' },
      { funding: 'gateway', amount: '6.67' },
      { funding: 'cod_cash', amount: '23.33' },
    ]);
    expect(
      splitReturnCredit({
        ...base,
        units: 2,
        alreadyCredited: 1,
      }),
    ).toEqual([
      { funding: 'credit_only', amount: '6.67' },
      { funding: 'gateway', amount: '13.33' },
      { funding: 'cod_cash', amount: '46.67' },
    ]);
  });

  it('refuses units beyond the line', () => {
    expect(() => splitReturnCredit({ ...codLine, units: 2 })).toThrow(CreditExceedsLine);
  });
});

describe('return credit cumulative rounding', () => {
  const line = {
    quantity: 4,
    grossAmount: '0.02',
    creditAppliedAmount: '0.01',
    prepaidAmount: '0.01',
    paymentMethod: 'cod' as const,
    prepaidMethod: 'gateway' as const,
    consumptionDraws: [{ funding: 'credit_only' as const, amount: '0.01' }],
  };

  it('credits a line of 4 at 0.02 one unit at a time without ever going negative', () => {
    const totals = [0, 1, 2, 3].map((done) =>
      returnCreditTotal({ ...line, units: 1, alreadyCredited: done }),
    );
    expect(totals).toEqual(['0.01', '0.00', '0.01', '0.00']);
    const shares = [0, 1, 2, 3].map((done) =>
      splitReturnShares({ ...line, units: 1, alreadyCredited: done }),
    );
    for (const share of shares) {
      for (const part of [share.credit, share.prepaid, share.remainder]) {
        expect(part.sign()).toBeGreaterThanOrEqual(0);
      }
    }
    expect(shares.reduce((acc, s) => acc.plus(s.total), Money.zero).toString()).toBe('0.02');
    expect(shares.reduce((acc, s) => acc.plus(s.credit), Money.zero).toString()).toBe('0.01');
    expect(shares.reduce((acc, s) => acc.plus(s.prepaid), Money.zero).toString()).toBe('0.01');
  });

  it('refuses units already credited beyond the line', () => {
    expect(() => returnCreditTotal({ ...line, units: 1, alreadyCredited: 5 })).toThrow(
      CreditExceedsLine,
    );
  });
});

describe('credit arithmetic input validation', () => {
  const ok: SplitReturnCreditInput = {
    quantity: 2,
    grossAmount: '10.00',
    creditAppliedAmount: '2.00',
    prepaidAmount: '3.00',
    paymentMethod: 'cod',
    prepaidMethod: 'gateway',
    consumptionDraws: [{ funding: 'credit_only', amount: '2.00' }],
    units: 1,
    alreadyCredited: 0,
  };

  it('refuses units that are not whole numbers in range', () => {
    for (const bad of [Number.NaN, -2, 0.5, 0, Number.POSITIVE_INFINITY]) {
      expect(() => splitReturnCredit({ ...ok, units: bad })).toThrow(InvalidAmountError);
    }
    for (const bad of [Number.NaN, -2, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => splitReturnCredit({ ...ok, alreadyCredited: bad })).toThrow(InvalidAmountError);
    }
    expect(() => splitReturnCredit({ ...ok, alreadyCredited: 3 })).toThrow(CreditExceedsLine);
    expect(() => splitReturnCredit({ ...ok, quantity: 0 })).toThrow(InvalidAmountError);
  });

  it('refuses negative line amounts and credit plus prepaid above gross', () => {
    expect(() => splitReturnCredit({ ...ok, grossAmount: '-1.00' })).toThrow(InvalidAmountError);
    expect(() => splitReturnCredit({ ...ok, creditAppliedAmount: '-1.00' })).toThrow(
      InvalidAmountError,
    );
    expect(() => splitReturnCredit({ ...ok, prepaidAmount: '-1.00' })).toThrow(InvalidAmountError);
    expect(() =>
      splitReturnCredit({ ...ok, creditAppliedAmount: '6.00', prepaidAmount: '5.00' }),
    ).toThrow(InvalidAmountError);
  });

  it('refuses consumption draws that are zero or negative', () => {
    for (const amount of ['0.00', '-1.00']) {
      expect(() =>
        splitReturnCredit({ ...ok, consumptionDraws: [{ funding: 'credit_only', amount }] }),
      ).toThrow(InvalidAmountError);
    }
  });

  it('refuses a negative order total or prepaid amount in a consumption', () => {
    expect(() =>
      planConsumption({ balanceByFunding: {}, orderTotal: '-1.00', prepaid: '0.00' }),
    ).toThrow(InvalidAmountError);
    expect(() =>
      planConsumption({ balanceByFunding: {}, orderTotal: '1.00', prepaid: '-1.00' }),
    ).toThrow(InvalidAmountError);
  });
});

describe('planConsumption', () => {
  it('spends a 500 credit on an 800 replacement and leaves a balance due of 300', () => {
    const plan = planConsumption({
      balanceByFunding: { credit_only: '500.00' },
      orderTotal: '800.00',
      prepaid: '0.00',
    });
    expect(plan.amount).toBe('500.00');
    expect(plan.balanceDue).toBe('300.00');
    expect(plan.leftover).toBe('0.00');
    expect(plan.draws).toEqual([{ funding: 'credit_only', amount: '500.00' }]);
  });

  it('leaves 300 over when an 800 credit meets a 500 replacement', () => {
    const plan = planConsumption({
      balanceByFunding: { cod_cash: '800.00' },
      orderTotal: '500.00',
      prepaid: '0.00',
    });
    expect(plan.amount).toBe('500.00');
    expect(plan.balanceDue).toBe('0.00');
    expect(plan.leftover).toBe('300.00');
  });

  it('consumes nothing from a balance of -200', () => {
    const plan = planConsumption({
      balanceByFunding: { cod_cash: '-200.00' },
      orderTotal: '500.00',
      prepaid: '0.00',
    });
    expect(plan.amount).toBe('0.00');
    expect(plan.draws).toEqual([]);
    expect(plan.balanceDue).toBe('500.00');
    expect(plan.leftover).toBe('0.00');
  });

  it('draws 700 as 200 credit_only then 500 cod_cash', () => {
    const plan = planConsumption({
      balanceByFunding: { credit_only: '200.00', cod_cash: '900.00' },
      orderTotal: '700.00',
      prepaid: '0.00',
    });
    expect(plan.draws).toEqual([
      { funding: 'credit_only', amount: '200.00' },
      { funding: 'cod_cash', amount: '500.00' },
    ]);
    expect(plan.leftover).toBe('400.00');
  });

  it('draws credit_only, cod_cash, instapay_or_transfer, then gateway', () => {
    const plan = planConsumption({
      balanceByFunding: {
        gateway: '10.00',
        instapay_or_transfer: '10.00',
        cod_cash: '10.00',
        credit_only: '10.00',
      },
      orderTotal: '40.00',
      prepaid: '0.00',
    });
    expect(plan.draws.map((d) => d.funding)).toEqual([
      'credit_only',
      'cod_cash',
      'instapay_or_transfer',
      'gateway',
    ]);
  });

  it('subtracts the prepaid amount and honors a smaller amount the agent applies', () => {
    const plan = planConsumption({
      balanceByFunding: { credit_only: '500.00' },
      orderTotal: '800.00',
      prepaid: '600.00',
      apply: '100.00',
    });
    expect(plan.amount).toBe('100.00');
    expect(plan.balanceDue).toBe('100.00');
    expect(plan.leftover).toBe('400.00');
  });

  it('never takes a funding below zero when another funding is in debt', () => {
    const plan = planConsumption({
      balanceByFunding: { credit_only: '500.00', cod_cash: '-300.00' },
      orderTotal: '1000.00',
      prepaid: '0.00',
    });
    expect(plan.amount).toBe('200.00');
    expect(plan.draws).toEqual([{ funding: 'credit_only', amount: '200.00' }]);
  });

  it('refuses to apply more than the allowed consumption', () => {
    expect(() =>
      planConsumption({
        balanceByFunding: { credit_only: '100.00' },
        orderTotal: '800.00',
        prepaid: '0.00',
        apply: '200.00',
      }),
    ).toThrow(InsufficientCredit);
  });
});

describe('planPayout', () => {
  const balances = {
    cod_cash: '400.00',
    instapay_or_transfer: '100.00',
    gateway: '250.00',
    credit_only: '200.00',
  };

  it('pays gateway_refund only from gateway', () => {
    expect(
      planPayout({ payoutMethod: 'gateway_refund', amount: '250.00', balanceByFunding: balances }),
    ).toEqual([{ funding: 'gateway', amount: '250.00' }]);
    expect(() =>
      planPayout({ payoutMethod: 'gateway_refund', amount: '250.01', balanceByFunding: balances }),
    ).toThrow(InsufficientCredit);
  });

  it('pays cash methods from cod_cash then instapay_or_transfer, never gateway or credit_only', () => {
    for (const payoutMethod of ['carrier_cash_refund', 'instapay_or_transfer'] as const) {
      expect(planPayout({ payoutMethod, amount: '450.00', balanceByFunding: balances })).toEqual([
        { funding: 'cod_cash', amount: '400.00' },
        { funding: 'instapay_or_transfer', amount: '50.00' },
      ]);
      expect(() =>
        planPayout({ payoutMethod, amount: '500.01', balanceByFunding: balances }),
      ).toThrow(InsufficientCredit);
    }
  });

  it('never pays out a credit_only balance', () => {
    expect(() =>
      planPayout({
        payoutMethod: 'instapay_or_transfer',
        amount: '10.00',
        balanceByFunding: { credit_only: '1200.00' },
      }),
    ).toThrow(InsufficientCredit);
  });

  it('refuses a payout that would take the whole balance below zero', () => {
    expect(() =>
      planPayout({
        payoutMethod: 'instapay_or_transfer',
        amount: '500.00',
        balanceByFunding: { cod_cash: '500.00', gateway: '-300.00' },
      }),
    ).toThrow(InsufficientCredit);
  });

  it('caps the retention case at 1,000 and leaves the 200 bonus as credit', () => {
    const retained = { cod_cash: '1000.00', credit_only: '200.00' };
    expect(
      planPayout({
        payoutMethod: 'instapay_or_transfer',
        amount: '1000.00',
        balanceByFunding: retained,
      }),
    ).toEqual([{ funding: 'cod_cash', amount: '1000.00' }]);
    expect(() =>
      planPayout({
        payoutMethod: 'instapay_or_transfer',
        amount: '1200.00',
        balanceByFunding: retained,
      }),
    ).toThrow(InsufficientCredit);
  });
});

describe('planDebtPayment', () => {
  it('funds a 300 payment against -300 cod_cash as a 300 cod_cash debt_payment', () => {
    expect(
      planDebtPayment({
        amount: '300.00',
        debts: [{ funding: 'cod_cash', balance: '-300.00', since: '2026-11-01T10:00:00Z' }],
      }),
    ).toEqual([{ funding: 'cod_cash', amount: '300.00' }]);
  });

  it('refuses a payment of 400 against a debt of 300', () => {
    expect(() =>
      planDebtPayment({
        amount: '400.00',
        debts: [{ funding: 'cod_cash', balance: '-300.00', since: '2026-11-01T10:00:00Z' }],
      }),
    ).toThrow(DebtPaymentExceedsDebt);
  });

  it('settles the oldest debt first and ignores fundings that are not in debt', () => {
    expect(
      planDebtPayment({
        amount: '350.00',
        debts: [
          { funding: 'gateway', balance: '-200.00', since: '2026-11-03T00:00:00Z' },
          { funding: 'credit_only', balance: '50.00', since: '2026-10-01T00:00:00Z' },
          { funding: 'cod_cash', balance: '-300.00', since: '2026-11-01T00:00:00Z' },
        ],
      }),
    ).toEqual([
      { funding: 'cod_cash', amount: '300.00' },
      { funding: 'gateway', amount: '50.00' },
    ]);
  });
});

describe('balances', () => {
  const entries = [
    { funding: 'credit_only' as const, amount: '200.00' },
    { funding: 'cod_cash' as const, amount: '900.00' },
    { funding: 'cod_cash' as const, amount: '-300.50' },
  ];

  it('sums the balance and the balance by funding', () => {
    expect(creditBalance(entries)).toBe('799.50');
    expect(creditBalanceByFunding(entries)).toEqual({
      cod_cash: '599.50',
      gateway: '0.00',
      instapay_or_transfer: '0.00',
      credit_only: '200.00',
    });
    expect(creditBalance([])).toBe('0.00');
  });
});

describe('credit arithmetic properties (seeded)', () => {
  let seed = 424242;
  const next = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  const text = (cents: number): string => Money.fromCents(BigInt(cents)).toString();
  const FUNDINGS: CreditFunding[] = ['credit_only', 'cod_cash', 'instapay_or_transfer', 'gateway'];

  it('credits every posting sequence with non negative parts that add up to the line', () => {
    for (let i = 0; i < 3000; i += 1) {
      const quantity = 1 + next(12);
      const gross = next(2_000_000);
      const prepaid = next(gross + 1);
      const credit = next(gross - prepaid + 1);
      const draws = FUNDINGS.slice(0, 1 + next(4)).map((funding) => ({
        funding,
        amount: text(1 + next(10_000)),
      }));
      const line = {
        quantity,
        grossAmount: text(gross),
        creditAppliedAmount: text(credit),
        prepaidAmount: text(prepaid),
        paymentMethod: 'cod' as const,
        prepaidMethod: 'gateway' as const,
        consumptionDraws: draws,
      };
      let done = 0;
      let sumGross = Money.zero;
      let sumCredit = Money.zero;
      let sumPrepaid = Money.zero;
      while (done < quantity) {
        const units = 1 + next(quantity - done);
        const input: SplitReturnCreditInput = { ...line, units, alreadyCredited: done };
        const shares = splitReturnShares(input);
        for (const part of [shares.credit, shares.prepaid, shares.remainder]) {
          expect(part.sign()).toBeGreaterThanOrEqual(0);
        }
        expect(shares.credit.plus(shares.prepaid).cents).toBeLessThanOrEqual(shares.total.cents);
        expect(shares.total.toString()).toBe(returnCreditTotal(input));
        const entries = splitReturnCredit(input);
        let sum = Money.zero;
        for (const entry of entries) {
          expect(Money.of(entry.amount).sign()).toBe(1);
          sum = sum.plus(Money.of(entry.amount));
        }
        expect(sum.toString()).toBe(shares.total.toString());
        expect(new Set(entries.map((e) => e.funding)).size).toBe(entries.length);
        sumGross = sumGross.plus(shares.total);
        sumCredit = sumCredit.plus(shares.credit);
        sumPrepaid = sumPrepaid.plus(shares.prepaid);
        done += units;
      }
      expect(sumGross.toString()).toBe(text(gross));
      expect(sumCredit.toString()).toBe(text(credit));
      expect(sumPrepaid.toString()).toBe(text(prepaid));
    }
  });

  it('keeps every posting part non negative on tiny amounts, where rounding bites hardest', () => {
    for (let i = 0; i < 6000; i += 1) {
      const quantity = 1 + next(9);
      const gross = next(41);
      const prepaid = next(gross + 1);
      const credit = next(gross - prepaid + 1);
      const line = {
        quantity,
        grossAmount: text(gross),
        creditAppliedAmount: text(credit),
        prepaidAmount: text(prepaid),
        paymentMethod: 'cod' as const,
        prepaidMethod: 'gateway' as const,
        consumptionDraws: [{ funding: 'credit_only' as const, amount: '1.00' }],
      };
      const sums = [Money.zero, Money.zero, Money.zero];
      for (let done = 0; done < quantity; done += 1) {
        const shares = splitReturnShares({ ...line, units: 1, alreadyCredited: done });
        [shares.credit, shares.prepaid, shares.remainder].forEach((part, index) => {
          expect(part.sign()).toBeGreaterThanOrEqual(0);
          sums[index] = (sums[index] ?? Money.zero).plus(part);
        });
      }
      expect(sums.map(String)).toEqual([
        text(credit),
        text(prepaid),
        text(gross - credit - prepaid),
      ]);
    }
  });

  it('gives the same totals whatever way the units are split into postings (a function of units alone)', () => {
    for (let i = 0; i < 1500; i += 1) {
      const quantity = 2 + next(10);
      const gross = next(500_000);
      const prepaid = next(gross + 1);
      const credit = next(gross - prepaid + 1);
      const line = {
        quantity,
        grossAmount: text(gross),
        creditAppliedAmount: text(credit),
        prepaidAmount: text(prepaid),
        paymentMethod: 'cod' as const,
        prepaidMethod: null,
        consumptionDraws: [{ funding: 'credit_only' as const, amount: '1.00' }],
      };
      const cut = 1 + next(quantity - 1);
      const whole = splitReturnShares({ ...line, units: quantity, alreadyCredited: 0 });
      const first = splitReturnShares({ ...line, units: cut, alreadyCredited: 0 });
      const second = splitReturnShares({ ...line, units: quantity - cut, alreadyCredited: cut });
      expect(first.credit.plus(second.credit).toString()).toBe(whole.credit.toString());
      expect(first.prepaid.plus(second.prepaid).toString()).toBe(whole.prepaid.toString());
      expect(first.total.plus(second.total).toString()).toBe(whole.total.toString());
    }
  });

  it('never makes a funding negative when consuming, and the draws add up to the amount', () => {
    for (let i = 0; i < 5000; i += 1) {
      const balanceByFunding: Partial<Record<CreditFunding, string>> = {};
      for (const funding of FUNDINGS) {
        balanceByFunding[funding] = text(next(3) === 0 ? -next(100_000) : next(100_000));
      }
      const orderTotal = next(300_000);
      const prepaid = next(orderTotal + 1);
      const plan = planConsumption({
        balanceByFunding,
        orderTotal: text(orderTotal),
        prepaid: text(prepaid),
      });
      const amount = Money.of(plan.amount);
      expect(amount.sign()).toBeGreaterThanOrEqual(0);
      let drawn = Money.zero;
      for (const draw of plan.draws) {
        const before = Money.of(balanceByFunding[draw.funding] ?? '0');
        expect(before.minus(Money.of(draw.amount)).sign()).toBeGreaterThanOrEqual(0);
        drawn = drawn.plus(Money.of(draw.amount));
      }
      expect(drawn.toString()).toBe(amount.toString());
      expect(amount.cents).toBeLessThanOrEqual(BigInt(orderTotal - prepaid));
      expect(Money.of(plan.balanceDue).plus(amount).toString()).toBe(text(orderTotal - prepaid));
    }
  });
});
