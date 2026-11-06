import { Money } from '../money.js';

/** Thrown when a line cannot be split: one piece, or a returned quantity outside `0 < r < q`. */
export class LineCannotSplit extends Error {
  readonly code = 'LineCannotSplit';

  /** Takes the plain words of why. */
  constructor(message: string) {
    super(message);
    this.name = 'LineCannotSplit';
  }
}

/** The quantity and the money columns of an order line that a split divides. Amounts are `numeric` text in EGP. */
export interface SplittableLine {
  quantity: number;
  grossAmount: string;
  netAmount: string;
  taxAmount: string;
  discountAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
}

/** The two rows a partial delivery leaves: the returned row is new, the delivered row is the original updated. */
export interface LineSplit {
  /** The new row (`returned_to_origin`): `round(original × r / q, 2)` on each money column. */
  returned: SplittableLine;
  /** The original row (`delivered`): each money column is the original minus the returned row. */
  delivered: SplittableLine;
}

const clamp = (value: Money, low: Money, high: Money): Money => {
  if (value.cents < low.cents) return low;
  if (value.cents > high.cents) return high;
  return value;
};

/**
 * The returned row's prepaid and credit: `round(p × r / q)` and `round(c × r / q)`, moved the
 * minimum needed so both rows keep `prepaid + credit <= gross` and every amount stays within
 * `[0, original]`. Prepaid is first held inside its own row limits, then credit is clamped, so a
 * cent of rounding never breaks the `order_lines` check on either row.
 */
function splitPayments(
  line: SplittableLine,
  returnedGross: Money,
  part: (amount: string) => Money,
): { prepaid: Money; credit: Money } {
  const p = Money.of(line.prepaidAmount);
  const c = Money.of(line.creditAppliedAmount);
  const g = Money.of(line.grossAmount);
  const zero = Money.zero;
  const deliveredGross = g.minus(returnedGross);
  // The least the returned row must hold so the delivered row's prepaid + credit fit its gross.
  const least = p.plus(c).minus(deliveredGross);
  const maxOf = (a: Money, b: Money): Money => (a.cents >= b.cents ? a : b);
  const minOf = (a: Money, b: Money): Money => (a.cents <= b.cents ? a : b);

  const prepaid = clamp(
    part(line.prepaidAmount),
    maxOf(zero, p.minus(deliveredGross)),
    minOf(p, returnedGross),
  );
  const credit = clamp(
    part(line.creditAppliedAmount),
    maxOf(zero, least.minus(prepaid)),
    minOf(c, returnedGross.minus(prepaid)),
  );
  return { prepaid, credit };
}

/**
 * Splits a line when `returnedQuantity` of its `quantity` pieces come back (spec 0002 "Partial
 * delivery splits lines"). Gross, net, and discount on the returned row are
 * `round(original × r / q, 2)` half away from zero, computed exactly; prepaid and credit are the
 * same rounding moved the minimum needed to keep `prepaid + credit <= gross` on both rows; its
 * tax is its gross minus its net; the delivered row keeps the rest, so the two rows always sum to the original and
 * `gross = net + tax` holds on both. Throws `LineCannotSplit` for a line of one piece or for
 * `r` outside `0 < r < q`. Must never be used to split by any other rounding.
 */
export function splitLine(line: SplittableLine, returnedQuantity: number): LineSplit {
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
    throw new LineCannotSplit('A line needs a whole quantity of at least 1');
  }
  if (line.quantity === 1) {
    throw new LineCannotSplit('A line of one piece is delivered or returned whole, never split');
  }
  if (
    !Number.isSafeInteger(returnedQuantity) ||
    returnedQuantity <= 0 ||
    returnedQuantity >= line.quantity
  ) {
    throw new LineCannotSplit(
      `The returned quantity must be a whole number above 0 and below ${line.quantity}`,
    );
  }
  const r = BigInt(returnedQuantity);
  const q = BigInt(line.quantity);
  const part = (amount: string): Money => Money.of(amount).share(r, q);

  const gross = part(line.grossAmount);
  const net = part(line.netAmount);
  const discount = part(line.discountAmount);
  const { prepaid, credit } = splitPayments(line, gross, part);
  const tax = gross.minus(net);

  const rest = (original: string, taken: Money): string =>
    Money.of(original).minus(taken).toString();
  return {
    returned: {
      quantity: returnedQuantity,
      grossAmount: gross.toString(),
      netAmount: net.toString(),
      taxAmount: tax.toString(),
      discountAmount: discount.toString(),
      prepaidAmount: prepaid.toString(),
      creditAppliedAmount: credit.toString(),
    },
    delivered: {
      quantity: line.quantity - returnedQuantity,
      grossAmount: rest(line.grossAmount, gross),
      netAmount: rest(line.netAmount, net),
      taxAmount: rest(line.taxAmount, tax),
      discountAmount: rest(line.discountAmount, discount),
      prepaidAmount: rest(line.prepaidAmount, prepaid),
      creditAppliedAmount: rest(line.creditAppliedAmount, credit),
    },
  };
}
