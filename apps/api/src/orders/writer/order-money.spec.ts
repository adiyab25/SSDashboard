import { InvalidAmountError } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { priceLines, shippingTaxOf, totalsOf } from './order-money.js';

describe('priceLines', () => {
  it('prices VAT inclusive lines at the rate, positions from 1', () => {
    const lines = priceLines(
      [
        { quantity: 2, unitPrice: '570.00', discountAmount: '0.00' },
        { quantity: 1, unitPrice: '114.00', discountAmount: '14.00' },
      ],
      '14.00',
      true,
    );

    expect(lines.map((line) => line.position)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({
      grossAmount: '1140.00',
      netAmount: '1000.00',
      taxAmount: '140.00',
    });
    expect(lines[1]).toMatchObject({
      grossAmount: '100.00',
      netAmount: '87.72',
      taxAmount: '12.28',
    });
  });

  it('gives a gift line with an equal discount a gross of 0', () => {
    const [line] = priceLines(
      [{ quantity: 1, unitPrice: '500.00', discountAmount: '500.00' }],
      '14.00',
      true,
    );

    expect(line?.grossAmount).toBe('0.00');
  });
});

describe('shippingTaxOf', () => {
  it('splits an inclusive shipping charge', () => {
    expect(shippingTaxOf('57.00', '14.00')).toBe('7.00');
    expect(shippingTaxOf('0.00', '14.00')).toBe('0.00');
  });
});

describe('totalsOf', () => {
  const lines = priceLines(
    [
      { quantity: 1, unitPrice: '1000.00', discountAmount: '0.00' },
      { quantity: 1, unitPrice: '400.00', discountAmount: '0.00' },
    ],
    '14.00',
    true,
  );

  it('totals a cash on delivery order: expected and due equal the total, outcome open', () => {
    const totals = totalsOf({
      lines,
      shippingChargedAmount: '50.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
      taxRate: '14.00',
      fulfillmentState: 'new',
    });

    expect(totals).toMatchObject({
      linesGrossAmount: '1400.00',
      totalAmount: '1450.00',
      codExpectedAmount: '1450.00',
      codDueAmount: '1450.00',
      deliveredAmount: '0.00',
      outcome: 'open',
    });
  });

  it('allocates a full prepayment over the lines and shipping', () => {
    const totals = totalsOf({
      lines,
      shippingChargedAmount: '50.00',
      prepaidAmount: '1450.00',
      creditAppliedAmount: '0.00',
      taxRate: '14.00',
      fulfillmentState: 'new',
    });

    expect(totals.codExpectedAmount).toBe('0.00');
    expect(totals.codDueAmount).toBe('0.00');
    expect(totals.lineShares.map((share) => share.prepaidAmount)).toEqual(['1000.00', '400.00']);
    expect(totals.shippingPrepaidAmount).toBe('50.00');
  });

  it('owes nothing once the order is cancelled, whatever its lines say', () => {
    const totals = totalsOf({
      lines,
      shippingChargedAmount: '50.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
      taxRate: '14.00',
      fulfillmentState: 'cancelled',
    });

    expect(totals.codDueAmount).toBe('0.00');
    expect(totals.outcome).toBe('cancelled_before_shipping');
  });
});

// Security L1: a figure that cannot fit numeric(14,2) is refused before any insert.
describe('amounts that cannot fit the money columns', () => {
  it('refuses a line whose price times quantity passes the limit', () => {
    const attempt = () =>
      priceLines(
        [{ quantity: 10000, unitPrice: '999999999.00', discountAmount: '0.00' }],
        '14.00',
        true,
      );

    expect(attempt).toThrow(InvalidAmountError);
  });

  it('refuses an order whose lines add past the limit', () => {
    const lines = priceLines(
      [
        { quantity: 1, unitPrice: '999999999999.00', discountAmount: '0.00' },
        { quantity: 1, unitPrice: '999999999999.00', discountAmount: '0.00' },
      ],
      '14.00',
      true,
    );
    const attempt = () =>
      totalsOf({
        lines,
        shippingChargedAmount: '0.00',
        prepaidAmount: '0.00',
        creditAppliedAmount: '0.00',
        taxRate: '14.00',
        fulfillmentState: 'new',
      });

    expect(attempt).toThrow(InvalidAmountError);
  });
});
