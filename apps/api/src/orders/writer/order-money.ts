import {
  LineAmounts,
  Money,
  allocatePayments,
  codDue,
  codExpected,
  deliveredAmountOf,
  deriveOrderOutcome,
  linesGrossAmountOf,
  type FulfillmentState,
  type OrderLineState,
  type OrderOutcome,
} from '@ssdashboard/contracts';

/** What the manual path knows of one line before it is priced. */
export interface LineToPrice {
  quantity: number;
  unitPrice: string;
  discountAmount: string;
}

/** A line with its net, tax, and gross, in position order starting at 1. */
export interface PricedLine {
  position: number;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  lineState: OrderLineState;
}

/** Prices every line with `LineAmounts.compute` (the one rule for line amounts) at one tax rate. */
export function priceLines(
  lines: readonly LineToPrice[],
  taxRate: string,
  pricesIncludeVat: boolean,
): PricedLine[] {
  return lines.map((line, index) => {
    const amounts = LineAmounts.compute({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount: line.discountAmount,
      taxRate,
      pricesIncludeVat,
    });
    return {
      position: index + 1,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      taxRate,
      netAmount: amounts.net.toString(),
      taxAmount: amounts.tax.toString(),
      grossAmount: amounts.gross.toString(),
      lineState: 'open',
    };
  });
}

/**
 * The tax inside a shipping charge (`shipping_tax_amount`): shipping is VAT inclusive, so the tax
 * is the charge minus the charge divided by one plus the rate, the original line rule of spec 0002.
 */
export function shippingTaxOf(shippingCharged: string, taxRate: string): string {
  return LineAmounts.compute({
    quantity: 1,
    unitPrice: shippingCharged,
    discount: '0.00',
    taxRate,
    pricesIncludeVat: true,
  }).tax.toString();
}

/** What `totalsOf` needs. */
export interface TotalsInput {
  lines: readonly PricedLine[];
  shippingChargedAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
  taxRate: string;
  fulfillmentState: FulfillmentState;
  returnedCreditAmount?: string;
  exchangeConsumedAmount?: string;
}

/** Every derived figure of an order, computed once from its lines (spec 0013, Value sourcing). */
export interface OrderTotals {
  linesGrossAmount: string;
  shippingTaxAmount: string;
  totalAmount: string;
  codExpectedAmount: string;
  codDueAmount: string;
  deliveredAmount: string;
  outcome: OrderOutcome;
  shippingPrepaidAmount: string;
  shippingCreditAppliedAmount: string;
  /** Per line, in the order of `input.lines`. */
  lineShares: { prepaidAmount: string; creditAppliedAmount: string }[];
}

/**
 * Recomputes totals, allocation, `cod_expected_amount`, `cod_due_amount`, `delivered_amount`, and
 * the outcome from the lines with the existing contract functions (`linesGrossAmountOf`,
 * `allocatePayments`, `codExpected`, `codDue`, `deliveredAmountOf`, `deriveOrderOutcome`). Pure.
 * Throws `InvalidAmountError` when prepaid plus credit exceed the total.
 */
export function totalsOf(input: TotalsInput): OrderTotals {
  const linesGross = linesGrossAmountOf(input.lines);
  const total = Money.of(linesGross).plus(Money.of(input.shippingChargedAmount)).toString();
  const allocation = allocatePayments({
    lines: input.lines,
    shippingChargedAmount: input.shippingChargedAmount,
    prepaidAmount: input.prepaidAmount,
    creditAppliedAmount: input.creditAppliedAmount,
  });
  const shareOf = new Map(allocation.lines.map((share) => [share.position, share]));
  const lineShares = input.lines.map((line) => {
    const share = shareOf.get(line.position);
    return {
      prepaidAmount: share?.prepaidAmount ?? '0.00',
      creditAppliedAmount: share?.creditAppliedAmount ?? '0.00',
    };
  });
  const due = codDue({
    lines: input.lines.map((line, index) => ({
      lineState: line.lineState,
      grossAmount: line.grossAmount,
      prepaidAmount: lineShares[index]?.prepaidAmount ?? '0.00',
      creditAppliedAmount: lineShares[index]?.creditAppliedAmount ?? '0.00',
    })),
    shippingChargedAmount: input.shippingChargedAmount,
    shippingPrepaidAmount: allocation.shippingPrepaidAmount,
    shippingCreditAppliedAmount: allocation.shippingCreditAppliedAmount,
    fulfillmentState: input.fulfillmentState,
  });
  const delivered = deliveredAmountOf(input.lines);
  return {
    linesGrossAmount: linesGross,
    shippingTaxAmount: shippingTaxOf(input.shippingChargedAmount, input.taxRate),
    totalAmount: total,
    codExpectedAmount: codExpected({
      totalAmount: total,
      prepaidAmount: input.prepaidAmount,
      creditAppliedAmount: input.creditAppliedAmount,
    }),
    codDueAmount: due,
    deliveredAmount: delivered,
    outcome: deriveOrderOutcome({
      fulfillmentState: input.fulfillmentState,
      deliveredAmount: delivered,
      returnedCreditAmount: input.returnedCreditAmount ?? '0.00',
      exchangeConsumedAmount: input.exchangeConsumedAmount ?? '0.00',
    }),
    shippingPrepaidAmount: allocation.shippingPrepaidAmount,
    shippingCreditAppliedAmount: allocation.shippingCreditAppliedAmount,
    lineShares,
  };
}
