import { InvalidAmountError, Money } from '../money.js';
import type { CreditFunding, PayoutMethod, PaymentTender } from './credit-enums.js';

/**
 * The customer credit arithmetic of spec 0002 "Customer credit ledger": the return credit and its
 * split by funding, the consumption of kept credit, payout matching, debt payments, and balances.
 * Pure functions on `numeric` text amounts; nothing here reads a database, a lock, or a clock.
 * The credit service (feature 28) calls them under the customer lock and writes the entries.
 */

/** Thrown when a return credit would credit more units than the line holds. */
export class CreditExceedsLine extends Error {
  readonly code = 'CreditExceedsLine';

  /** Takes the plain words of how many units were asked for and how many remain. */
  constructor(message: string) {
    super(message);
    this.name = 'CreditExceedsLine';
  }
}

/** Thrown when a consumption or a payout is larger than the balance (or the matching funding's balance) allows. */
export class InsufficientCredit extends Error {
  readonly code = 'InsufficientCredit';

  /** Takes the plain words of what was asked and what is available. */
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCredit';
  }
}

/** Thrown when a debt payment is larger than what the customer owes; it would create cashable credit. */
export class DebtPaymentExceedsDebt extends Error {
  readonly code = 'DebtPaymentExceedsDebt';

  /** Takes the plain words of what was paid and what is owed. */
  constructor(message: string) {
    super(message);
    this.name = 'DebtPaymentExceedsDebt';
  }
}

/** The order in which consumption spends fundings: money that can go back to its source stays refundable longest. */
const CONSUMPTION_ORDER: readonly CreditFunding[] = [
  'credit_only',
  'cod_cash',
  'instapay_or_transfer',
  'gateway',
];

/** The order in which a payout draws from the fundings it may use. `credit_only` is in neither list. */
const PAYOUT_FUNDINGS: Record<PayoutMethod, readonly CreditFunding[]> = {
  gateway_refund: ['gateway'],
  carrier_cash_refund: ['cod_cash', 'instapay_or_transfer'],
  instapay_or_transfer: ['cod_cash', 'instapay_or_transfer'],
};

/** One amount against one funding; the amount is positive `numeric` text (the caller applies the entry's sign). */
export interface FundingAmount {
  funding: CreditFunding;
  amount: string;
}

/** Balances per funding as `numeric` text; a missing funding is 0. */
export type BalanceByFunding = Partial<Record<CreditFunding, string>>;

const balanceOf = (balances: BalanceByFunding, funding: CreditFunding): Money =>
  Money.of(balances[funding] ?? '0');

const minOf = (a: Money, b: Money): Money => (a.cents <= b.cents ? a : b);
const maxOf = (a: Money, b: Money): Money => (a.cents >= b.cents ? a : b);

/** The funding an order's tender puts money into: `cod` to `cod_cash`, `gateway` to `gateway`, `instapay`, `bank_transfer`, and `wallet` to `instapay_or_transfer`. */
export function fundingOfTender(tender: PaymentTender): CreditFunding {
  switch (tender) {
    case 'cod':
      return 'cod_cash';
    case 'gateway':
      return 'gateway';
    case 'instapay':
    case 'bank_transfer':
    case 'wallet':
      return 'instapay_or_transfer';
    default: {
      const unreachable: never = tender;
      return unreachable;
    }
  }
}

/** What `returnCreditTotal` reads. */
export interface ReturnCreditInput {
  /** The line's quantity `n`. */
  quantity: number;
  /** The line's `gross_amount` `g`: the price actually paid after every discount, VAT inclusive. */
  grossAmount: string;
  /** Units this posting credits, `k`. */
  units: number;
  /** Units already credited, net of reversals: a safe integer in `[0, n]`. */
  alreadyCredited: number;
}

/** The largest line quantity the cumulative rule accepts; far above any real order line. */
const MAX_LINE_QUANTITY = 100_000;

/** Checks the unit counts of a posting and returns them as bigints. Throws `InvalidAmountError` for a malformed count and `CreditExceedsLine` when the line cannot take the units. */
function checkedUnits(input: ReturnCreditInput): { n: number; d: number; k: number } {
  const { quantity: n, units: k, alreadyCredited: d } = input;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_LINE_QUANTITY) {
    throw new InvalidAmountError(
      `The line quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}`,
    );
  }
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new InvalidAmountError('The credited units must be a whole number of at least 1');
  }
  if (!Number.isSafeInteger(d) || d < 0) {
    throw new InvalidAmountError('The units already credited must be a whole number of at least 0');
  }
  if (d > n || d + k > n) {
    throw new CreditExceedsLine(
      `The line holds ${n} units, ${d} already credited, ${k} more asked for`,
    );
  }
  return { n, d, k };
}

/**
 * The gross credited after `d` units: `round(g × d / n)` half away from zero, exactly `g` at
 * `d = n`. Non decreasing in `d`, so a posting (the difference of two of these) is never negative.
 */
function grossAfter(gross: Money, d: number, n: number): Money {
  return gross.share(BigInt(d), BigInt(n));
}

/**
 * The return credit total for `k` units after `d` already credited: `G(d + k) − G(d)` where
 * `G(d) = round(g × d / n, 2)`. The posting that brings the credited units to `n` therefore takes
 * exactly `g` minus what the line already received, a line is never credited more than it was
 * paid, and no posting is negative. The result depends only on the units, never on amounts
 * posted earlier, so the credit service can rebuild it from the stored `quantity` of each
 * posting. Throws `CreditExceedsLine` when the credited units would pass `n` and
 * `InvalidAmountError` for a malformed count or a negative gross. Returns the 2 decimal text.
 */
export function returnCreditTotal(input: ReturnCreditInput): string {
  const { n, d, k } = checkedUnits(input);
  const gross = Money.of(input.grossAmount);
  if (gross.sign() < 0) throw new InvalidAmountError('The line gross cannot be negative');
  return grossAfter(gross, d + k, n)
    .minus(grossAfter(gross, d, n))
    .toString();
}

/** What `splitReturnCredit` reads: the credit total's inputs plus the line's shares and the order's tenders. */
export interface SplitReturnCreditInput extends ReturnCreditInput {
  /** The line's `credit_applied_amount`. */
  creditAppliedAmount: string;
  /** The line's `prepaid_amount`. */
  prepaidAmount: string;
  /** The order's `payment_method`: the funding of the remainder. */
  paymentMethod: PaymentTender;
  /** The order's `prepaid_method`: the funding of the prepaid share; null when nothing was prepaid. */
  prepaidMethod: PaymentTender | null;
  /** What the order's own `order_consumption` entries drew, as positive amounts in the order they were drawn. */
  consumptionDraws: readonly FundingAmount[];
}

/** The three shares a return credit total divides into; they always add up to the total. */
export interface ReturnShares {
  total: Money;
  credit: Money;
  prepaid: Money;
  remainder: Money;
}

/**
 * The cumulative split of a line after `d` units, as cents: the credit share, the prepaid share,
 * and the remainder, adding up to `G(d) = round(g × d / n)`.
 *
 * Built step by step from 0 to `d` (so it depends on the units alone): at each step every part
 * moves to its own `round(part × step / n)` but never down and never above its row total, then
 * single cents are taken from the parts furthest above their exact share, or given to the parts
 * furthest below it, until the three add up to `G(step)`. Each part is therefore non decreasing
 * in `d` (so every posting part is at least 0), never above its total, and exact at `d = n`
 * (where `G = g` and the three totals add up to `g`, so every part is pinned to its total).
 * Adjustments are always possible: the parts sum to `G(step − 1) ≤ G(step) ≤ g`, the sum of the
 * totals. Ties go to the credit share, then the prepaid share, then the remainder.
 */
function cumulativeParts(
  gross: Money,
  credit: Money,
  prepaid: Money,
  n: number,
  d: number,
): [bigint, bigint, bigint] {
  const caps: [bigint, bigint, bigint] = [
    credit.cents,
    prepaid.cents,
    gross.cents - credit.cents - prepaid.cents,
  ];
  const bigN = BigInt(n);
  let parts: [bigint, bigint, bigint] = [0n, 0n, 0n];
  for (let step = 1; step <= d; step += 1) {
    const bigStep = BigInt(step);
    const target = grossAfter(gross, step, n).cents;
    const ideal = caps.map((cap) => cap * bigStep);
    const next = parts.map((part, i) => {
      const rounded = grossAfter(Money.fromCents(caps[i] as bigint), step, n).cents;
      const held = rounded < (caps[i] as bigint) ? rounded : (caps[i] as bigint);
      return part > held ? part : held;
    }) as [bigint, bigint, bigint];
    let sum = next[0] + next[1] + next[2];
    while (sum !== target) {
      let pick = -1;
      let best = 0n;
      for (let i = 0; i < 3; i += 1) {
        const have = next[i] as bigint;
        // How far the part sits above (positive) its exact share, in 1/n cent units.
        const above = have * bigN - (ideal[i] as bigint);
        if (sum > target) {
          if (have > (parts[i] as bigint) && (pick === -1 || above > best)) {
            pick = i;
            best = above;
          }
        } else if (have < (caps[i] as bigint) && (pick === -1 || -above > best)) {
          pick = i;
          best = -above;
        }
      }
      if (pick === -1) throw new InvalidAmountError('The return credit shares cannot be balanced');
      next[pick] = (next[pick] as bigint) + (sum > target ? -1n : 1n);
      sum += sum > target ? -1n : 1n;
    }
    parts = next;
  }
  return parts;
}

/** A line's amounts must be non negative and credit plus prepaid within gross. */
function checkedLineAmounts(input: SplitReturnCreditInput): {
  gross: Money;
  credit: Money;
  prepaid: Money;
} {
  const gross = Money.of(input.grossAmount);
  const credit = Money.of(input.creditAppliedAmount);
  const prepaid = Money.of(input.prepaidAmount);
  if (gross.sign() < 0 || credit.sign() < 0 || prepaid.sign() < 0) {
    throw new InvalidAmountError(
      'A line gross, credit share, and prepaid share cannot be negative',
    );
  }
  if (credit.plus(prepaid).cents > gross.cents) {
    throw new InvalidAmountError('A line credit share plus prepaid share cannot exceed its gross');
  }
  return { gross, credit, prepaid };
}

/**
 * Divides a return credit posting into the credit share, the prepaid share, and the remainder
 * (the gross part minus the two shares). Each share is a function of the units credited so far
 * (`cumulativeParts`), a posting of `k` units after `d` is the difference of two such values, so
 * every part is at least 0, credit plus prepaid never exceed the total, and over all postings
 * the parts add up to exactly the line's gross, credit, and prepaid amounts. Throws
 * `CreditExceedsLine` for too many units and `InvalidAmountError` for malformed counts or
 * amounts (negative, or credit plus prepaid above gross).
 */
export function splitReturnShares(input: SplitReturnCreditInput): ReturnShares {
  const { n, d, k } = checkedUnits(input);
  const { gross, credit, prepaid } = checkedLineAmounts(input);
  const before = cumulativeParts(gross, credit, prepaid, n, d);
  const after = cumulativeParts(gross, credit, prepaid, n, d + k);
  const part = (i: 0 | 1 | 2): Money => Money.fromCents(after[i] - before[i]);
  return {
    total: Money.fromCents(after[0] + after[1] + after[2] - before[0] - before[1] - before[2]),
    credit: part(0),
    prepaid: part(1),
    remainder: part(2),
  };
}

/**
 * Splits the credit share across the fundings the order's consumption drew, in the same
 * proportion; the last funding in the consumption order takes the rest.
 */
function spreadCredit(share: Money, draws: readonly FundingAmount[]): FundingAmount[] {
  if (share.isZero()) return [];
  const drawn = draws.map((d) => ({ funding: d.funding, amount: Money.of(d.amount) }));
  const sum = drawn.reduce((acc, d) => acc.plus(d.amount), Money.zero);
  if (sum.sign() <= 0) {
    throw new InvalidAmountError(
      'The order has a credit share but no consumption entries to return it to',
    );
  }
  let rest = share;
  return drawn.map((d, index) => {
    const isLast = index === drawn.length - 1;
    const amount = isLast ? rest : minOf(share.share(d.amount.cents, sum.cents), rest);
    rest = rest.minus(amount);
    return { funding: d.funding, amount: amount.toString() };
  });
}

/**
 * The entries of one return credit posting: one per funding that is not zero, summing exactly to
 * `returnCreditTotal`. The credit share goes back to the fundings the order's own consumption
 * drew, the prepaid share to the funding of `prepaidMethod`, the remainder to the funding of
 * `paymentMethod`; shares that land on one funding merge into one entry (the ledger holds one
 * entry per funding per posting). Throws `CreditExceedsLine` for too many units and
 * `InvalidAmountError` for a prepaid share without a prepaid method or a credit share with no
 * consumption to return it to.
 */
export function splitReturnCredit(input: SplitReturnCreditInput): FundingAmount[] {
  for (const draw of input.consumptionDraws) {
    if (Money.of(draw.amount).sign() <= 0) {
      throw new InvalidAmountError('A consumption draw must be above 0');
    }
  }
  const shares = splitReturnShares(input);
  if (!shares.prepaid.isZero() && input.prepaidMethod === null) {
    throw new InvalidAmountError(
      'The line has a prepaid share but the order has no prepaid method',
    );
  }
  const parts: { funding: CreditFunding; amount: Money }[] = [
    ...spreadCredit(shares.credit, input.consumptionDraws).map((d) => ({
      funding: d.funding,
      amount: Money.of(d.amount),
    })),
    ...(input.prepaidMethod === null
      ? []
      : [{ funding: fundingOfTender(input.prepaidMethod), amount: shares.prepaid }]),
    { funding: fundingOfTender(input.paymentMethod), amount: shares.remainder },
  ];
  const merged = new Map<CreditFunding, Money>();
  for (const part of parts) {
    merged.set(part.funding, (merged.get(part.funding) ?? Money.zero).plus(part.amount));
  }
  return [...merged]
    .filter(([, amount]) => !amount.isZero())
    .map(([funding, amount]) => ({ funding, amount: amount.toString() }));
}

/** What `planConsumption` reads. */
export interface ConsumptionInput {
  balanceByFunding: BalanceByFunding;
  /** The order's `total_amount`. */
  orderTotal: string;
  /** The order's `prepaid_amount`. */
  prepaid: string;
  /** The amount the agent chooses to apply; at most the computed consumption. */
  apply?: string;
}

/** The answer of `planConsumption`. */
export interface ConsumptionPlan {
  /** The order's `credit_applied_amount`. */
  amount: string;
  /** One `order_consumption` entry per funding drawn, as positive amounts. */
  draws: FundingAmount[];
  /** What the courier collects: the order total minus prepaid minus the consumption, never below 0. */
  balanceDue: string;
  /** The balance after consumption when positive: refunded the original way or kept as store credit. */
  leftover: string;
}

/**
 * The consumption of kept credit: `max(0, min(balance, total − prepaid))`, or the smaller amount
 * the agent applies. It draws `credit_only`, then `cod_cash`, then `instapay_or_transfer`, then
 * `gateway`, and never takes a funding below zero (a funding in debt gives nothing). A customer who
 * owes gets no consumption. Throws `InsufficientCredit` when `apply` is more than that.
 */
export function planConsumption(input: ConsumptionInput): ConsumptionPlan {
  const balance = CONSUMPTION_ORDER.reduce(
    (acc, funding) => acc.plus(balanceOf(input.balanceByFunding, funding)),
    Money.zero,
  );
  const orderTotal = Money.of(input.orderTotal);
  const prepaid = Money.of(input.prepaid);
  if (orderTotal.sign() < 0 || prepaid.sign() < 0) {
    throw new InvalidAmountError('The order total and prepaid amount cannot be negative');
  }
  const payable = orderTotal.minus(prepaid);
  const allowed = maxOf(Money.zero, minOf(balance, payable));
  let amount = allowed;
  if (input.apply !== undefined) {
    amount = Money.of(input.apply);
    if (amount.sign() < 0) throw new InvalidAmountError('The applied credit cannot be negative');
    if (amount.cents > allowed.cents) {
      throw new InsufficientCredit(
        `Applied credit ${amount.toString()} is more than the ${allowed.toString()} allowed`,
      );
    }
  }
  const draws: FundingAmount[] = [];
  let rest = amount;
  for (const funding of CONSUMPTION_ORDER) {
    if (rest.isZero()) break;
    const drawn = minOf(rest, maxOf(balanceOf(input.balanceByFunding, funding), Money.zero));
    if (drawn.isZero()) continue;
    draws.push({ funding, amount: drawn.toString() });
    rest = rest.minus(drawn);
  }
  if (!rest.isZero()) {
    throw new InsufficientCredit('The fundings in credit cannot cover the consumption');
  }
  return {
    amount: amount.toString(),
    draws,
    balanceDue: maxOf(Money.zero, payable.minus(amount)).toString(),
    leftover: maxOf(Money.zero, balance.minus(amount)).toString(),
  };
}

/** What `planPayout` reads. */
export interface PayoutInput {
  payoutMethod: PayoutMethod;
  /** The payout amount, above 0. */
  amount: string;
  balanceByFunding: BalanceByFunding;
}

/**
 * The fundings a `refund_payout` draws from: `gateway_refund` only from `gateway`;
 * `carrier_cash_refund` and `instapay_or_transfer` from `cod_cash`, then `instapay_or_transfer`.
 * `credit_only` is never drawn. Throws `InsufficientCredit` when the matching fundings in credit
 * cannot cover the amount, or when the payout would take the whole balance below zero.
 */
export function planPayout(input: PayoutInput): FundingAmount[] {
  const amount = Money.of(input.amount);
  if (amount.sign() <= 0) throw new InvalidAmountError('A payout must be above 0');
  const total = CONSUMPTION_ORDER.reduce(
    (acc, funding) => acc.plus(balanceOf(input.balanceByFunding, funding)),
    Money.zero,
  );
  if (amount.cents > total.cents) {
    throw new InsufficientCredit(
      `Payout ${amount.toString()} is more than the balance ${total.toString()}`,
    );
  }
  const draws: FundingAmount[] = [];
  let rest = amount;
  for (const funding of PAYOUT_FUNDINGS[input.payoutMethod]) {
    if (rest.isZero()) break;
    const drawn = minOf(rest, maxOf(balanceOf(input.balanceByFunding, funding), Money.zero));
    if (drawn.isZero()) continue;
    draws.push({ funding, amount: drawn.toString() });
    rest = rest.minus(drawn);
  }
  if (!rest.isZero()) {
    throw new InsufficientCredit(
      `Payout ${amount.toString()} by ${input.payoutMethod} is more than the matching fundings hold`,
    );
  }
  return draws;
}

/** One funding's balance and the time its debt began. */
export interface DebtInput {
  funding: CreditFunding;
  /** The funding's balance; only negative ones are debts. */
  balance: string;
  /** When the funding last went below zero (ISO 8601), so the oldest debt is settled first. */
  since: string;
}

/** What `planDebtPayment` reads. */
export interface DebtPaymentInput {
  /** What the customer paid by InstaPay or transfer, above 0. */
  amount: string;
  debts: readonly DebtInput[];
}

/**
 * The `debt_payment` entries for a payment: it only brings negative fundings back toward zero,
 * oldest debt first, never above zero, so it never creates cashable credit. Fundings at or above
 * zero are ignored. Throws `DebtPaymentExceedsDebt` when the payment is more than the total owed.
 */
export function planDebtPayment(input: DebtPaymentInput): FundingAmount[] {
  const amount = Money.of(input.amount);
  if (amount.sign() <= 0) throw new InvalidAmountError('A payment must be above 0');
  const owed = input.debts
    .map((debt, index) => {
      const time = Date.parse(debt.since);
      if (Number.isNaN(time)) throw new InvalidAmountError('A debt start time is not a date');
      return { funding: debt.funding, debt: Money.of(debt.balance).negate(), time, index };
    })
    .filter((d) => d.debt.sign() > 0)
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const totalOwed = owed.reduce((acc, d) => acc.plus(d.debt), Money.zero);
  if (amount.cents > totalOwed.cents) {
    throw new DebtPaymentExceedsDebt(
      `Payment ${amount.toString()} is more than the ${totalOwed.toString()} owed`,
    );
  }
  const entries: FundingAmount[] = [];
  let rest = amount;
  for (const d of owed) {
    if (rest.isZero()) break;
    const paid = minOf(rest, d.debt);
    entries.push({ funding: d.funding, amount: paid.toString() });
    rest = rest.minus(paid);
  }
  return entries;
}

/** The balance over a list of entries (signed amounts as `numeric` text): the sum, 2 decimals. */
export function creditBalance(entries: readonly { amount: string }[]): string {
  return entries.reduce((acc, e) => acc.plus(Money.of(e.amount)), Money.zero).toString();
}

/** The balance per funding over a list of entries; every funding is present, 0 when it has no entries. */
export function creditBalanceByFunding(
  entries: readonly { funding: CreditFunding; amount: string }[],
): Record<CreditFunding, string> {
  const sums: Record<CreditFunding, Money> = {
    cod_cash: Money.zero,
    gateway: Money.zero,
    instapay_or_transfer: Money.zero,
    credit_only: Money.zero,
  };
  for (const entry of entries)
    sums[entry.funding] = sums[entry.funding].plus(Money.of(entry.amount));
  return {
    cod_cash: sums.cod_cash.toString(),
    gateway: sums.gateway.toString(),
    instapay_or_transfer: sums.instapay_or_transfer.toString(),
    credit_only: sums.credit_only.toString(),
  };
}
