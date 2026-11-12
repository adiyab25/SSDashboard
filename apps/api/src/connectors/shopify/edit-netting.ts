// Edit netting and Shopify refunds (spec 0015 task 10: AC-11, Inbound processing item 5, Value
// sourcing "netting"). Pure: no database, no clock, no log, no Shopify call. The inbox job reads
// the operating day of every instant this module asks for in one SQL call to `ssd_operating_day`
// (never in TypeScript, so the operating day cutoff applies), then asks `planNetting` which pairs
// and refunds are new, publishes `ChannelEditNetted` and `ChannelRefundRecorded` in its unit of
// work, and keeps the returned ids on the order mapping. Netting never changes the snapshot: an
// order's lines always come from its line items (`order-mapper.ts`).
import { Money } from '@ssdashboard/contracts';
import type { ShopifyOrder } from './order-mapper.js';

/** One sale of the order's sales history, as `ORDER_READ` selects it. */
type ShopifySale = ShopifyOrder['agreements']['nodes'][number]['sales']['nodes'][number];

/** The sales action types netting reads (`enums/SaleActionType`, `2026-10`). */
const ADDITION = 'ORDER';
const REMOVAL = 'UPDATE';
const RETURN = 'RETURN';

/** The only sale line type that nets (`enums/SaleLineType`, `2026-10`). */
const PRODUCT = 'PRODUCT';

/** A new netted pair: one removal and one addition of the same variant, day, and amount. */
export interface NettedPair {
  /** The `UPDATE` sale (the removal). */
  readonly removalSaleId: string;
  /** The `ORDER` sale (the addition). */
  readonly additionSaleId: string;
  /**
   * The Shopify line item ids of the removal and the addition, in that order, each once (a line
   * added and removed again is one id).
   */
  readonly channelLineIds: readonly string[];
  /** The operating day both sales fall on, `YYYY-MM-DD`. */
  readonly operatingDay: string;
}

/** A new Shopify refund, from the `RETURN` sales of a refund agreement. */
export interface RecordedRefund {
  /** The refund gid (`RefundAgreement.refund.id`). */
  readonly externalRefundId: string;
  /** The sum of its `RETURN` sales as a positive amount with two decimals, every line type. */
  readonly amount: string;
  /** When the refund happened (`happenedAt`), an ISO instant. */
  readonly occurredAt: string;
}

/** What the mapping remembers of earlier netting (`connection_external_ids.state`). */
export interface NettingMemory {
  /** The sale ids already netted: never paired again. */
  readonly nettedSaleIds?: readonly string[];
  /** The refund ids already recorded: never recorded again. */
  readonly recordedRefundIds?: readonly string[];
}

/**
 * Which refunds are recorded without being published (security review M2, lead decision D14):
 * those that happened before `before` (the connection's `go_live_at`), imported order or not. A
 * refund after go live publishes like any other. Their ids still go into `recordedRefundIds`, so
 * a later read never publishes them either.
 */
export interface QuietRefunds {
  readonly before: string | null;
}

/** What one read back's sales history asks for. */
export interface NettingPlan {
  /** Pairs not netted before: one `ChannelEditNetted` each. */
  readonly pairs: readonly NettedPair[];
  /** Refunds not recorded before and not quiet: one `ChannelRefundRecorded` each. */
  readonly refunds: readonly RecordedRefund[];
  /** Every netted sale id, the earlier ones first (the mapping's next `nettedSaleIds`). */
  readonly nettedSaleIds: readonly string[];
  /** Every recorded refund id, the earlier ones first (the next `recordedRefundIds`). */
  readonly recordedRefundIds: readonly string[];
  /**
   * The read did not hold the whole history (a next page of agreements, or of an agreement's
   * sales): what was read is netted, a refund with unread sales waits for a later read.
   */
  readonly truncated: boolean;
}

/** A Shopify `Decimal` in whole cents, as `order-mapper.ts` reads money; null when unreadable. */
function centsOf(amount: string): bigint | null {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  let cents = BigInt(whole + fraction.padEnd(2, '0').slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1n;
  return sign ? -cents : cents;
}

const absolute = (cents: bigint): bigint => (cents < 0n ? -cents : cents);

/**
 * Orders two gids by their numeric tail (`gid://shopify/ProductSale/5000000008001`), then as text,
 * so "by sale id" means Shopify's id order, never the order of the read.
 */
export function compareGids(a: string, b: string): number {
  const tail = (gid: string) => /(\d+)$/.exec(gid)?.[1];
  const ta = tail(a);
  const tb = tail(b);
  if (ta !== undefined && tb !== undefined && ta !== tb) {
    const na = BigInt(ta);
    const nb = BigInt(tb);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The distinct `happenedAt` instants of the agreements that hold a product `ORDER` or `UPDATE`
 * sale, or a `RETURN` sale of a refund: the instants whose operating day the inbox job reads in
 * one SQL call before `planNetting`. Sorted, so the query is the same for the same history.
 */
export function nettingInstantsOf(order: ShopifyOrder): string[] {
  const instants = new Set<string>();
  for (const agreement of order.agreements.nodes) {
    const counts = agreement.sales.nodes.some(
      (sale) =>
        (sale.lineType === PRODUCT &&
          (sale.actionType === ADDITION || sale.actionType === REMOVAL)) ||
        (agreement.refund !== undefined && sale.actionType === RETURN),
    );
    if (counts) instants.add(agreement.happenedAt);
  }
  return [...instants].sort();
}

/** A product sale ready to pair: its id, line item, variant, operating day, and absolute cents. */
interface Candidate {
  readonly saleId: string;
  readonly lineItemId: string;
  readonly key: string;
  readonly operatingDay: string;
}

/**
 * Plans the netting and refunds of one read back (Inbound processing item 5). Only product sales
 * net: a removal is a sale with action type `UPDATE`, an addition one with `ORDER`, from any
 * agreement. A removal and an addition pair when they share the variant (of their line item, from
 * `order.lineItems`), the operating day of `happenedAt` (`days`, from `ssd_operating_day`), and
 * the absolute amount; within each such group the n-th removal pairs with the n-th addition, both
 * ordered by sale id. Sales in `memory.nettedSaleIds` are left out before pairing, so a pair is
 * netted once and a sale is never netted twice; a sale whose line item has no variant (a deleted
 * one), whose instant has no day in `days`, or whose amount does not read is never paired.
 *
 * Each refund agreement (it carries `refund`) with at least one `RETURN` sale, whose sales were
 * all read, and whose refund id is not in `memory.recordedRefundIds`, is a new refund: the sum of
 * its `RETURN` sales of every line type, as a positive amount, at its `happenedAt`. A new refund
 * that `quiet` names (before go live) is only recorded, never planned for
 * publishing.
 */
export function planNetting(
  order: ShopifyOrder,
  days: ReadonlyMap<string, string>,
  memory: NettingMemory,
  quiet: QuietRefunds = { before: null },
): NettingPlan {
  const quietBefore = quiet.before === null ? null : Date.parse(quiet.before);
  const variantOf = new Map(
    order.lineItems.nodes.map((line) => [line.id, line.variant?.id ?? null] as const),
  );
  const netted = new Set(memory.nettedSaleIds ?? []);
  const recorded = new Set(memory.recordedRefundIds ?? []);
  let truncated = order.agreements.pageInfo.hasNextPage;

  const removals = new Map<string, Candidate[]>();
  const additions = new Map<string, Candidate[]>();
  const refunds: RecordedRefund[] = [];
  const seenSales = new Set<string>();

  for (const agreement of order.agreements.nodes) {
    if (agreement.sales.pageInfo.hasNextPage) truncated = true;
    const day = days.get(agreement.happenedAt);
    for (const sale of agreement.sales.nodes) {
      // A sale read twice (it cannot be, but a page boundary must never double count).
      if (seenSales.has(sale.id)) continue;
      seenSales.add(sale.id);
      const candidate = candidateOf(sale, variantOf, day);
      if (candidate === null || netted.has(sale.id)) continue;
      const pool = sale.actionType === REMOVAL ? removals : additions;
      const group = pool.get(candidate.key) ?? [];
      group.push(candidate);
      pool.set(candidate.key, group);
    }
    const refund = refundOf(agreement);
    if (refund !== null && !recorded.has(refund.externalRefundId)) {
      const silent = quietBefore !== null && Date.parse(refund.occurredAt) < quietBefore;
      if (!silent) refunds.push(refund);
      recorded.add(refund.externalRefundId);
    }
  }

  const pairs: NettedPair[] = [];
  for (const [key, group] of removals) {
    const matches = (additions.get(key) ?? []).sort((a, b) => compareGids(a.saleId, b.saleId));
    group.sort((a, b) => compareGids(a.saleId, b.saleId));
    group.forEach((removal, index) => {
      const addition = matches[index];
      if (addition === undefined) return;
      pairs.push({
        removalSaleId: removal.saleId,
        additionSaleId: addition.saleId,
        channelLineIds: [...new Set([removal.lineItemId, addition.lineItemId])],
        operatingDay: removal.operatingDay,
      });
    });
  }
  pairs.sort((a, b) => compareGids(a.removalSaleId, b.removalSaleId));
  const nettedSaleIds = [
    ...(memory.nettedSaleIds ?? []),
    ...pairs.flatMap((pair) => [pair.removalSaleId, pair.additionSaleId]),
  ];
  return {
    pairs,
    refunds: refunds.sort((a, b) => compareGids(a.externalRefundId, b.externalRefundId)),
    nettedSaleIds,
    recordedRefundIds: [...recorded],
    truncated,
  };
}

/**
 * A product `ORDER` or `UPDATE` sale as a pairing candidate keyed by variant, operating day, and
 * absolute cents; null for any other sale or one that cannot be keyed.
 */
function candidateOf(
  sale: ShopifySale,
  variantOf: ReadonlyMap<string, string | null>,
  day: string | undefined,
): Candidate | null {
  if (sale.lineType !== PRODUCT) return null;
  if (sale.actionType !== ADDITION && sale.actionType !== REMOVAL) return null;
  const lineItemId = sale.lineItem?.id;
  const variant = lineItemId === undefined ? null : (variantOf.get(lineItemId) ?? null);
  const cents = centsOf(sale.totalAmount.shopMoney.amount);
  if (lineItemId === undefined || variant === null || day === undefined || cents === null) {
    return null;
  }
  return {
    saleId: sale.id,
    lineItemId,
    key: JSON.stringify([variant, day, absolute(cents).toString()]),
    operatingDay: day,
  };
}

/**
 * The refund of a refund agreement whose sales were all read and hold a `RETURN` sale, with the
 * sum of those sales as a positive amount; null otherwise (an amount that does not read, too).
 */
function refundOf(agreement: ShopifyOrder['agreements']['nodes'][number]): RecordedRefund | null {
  if (agreement.refund === undefined || agreement.sales.pageInfo.hasNextPage) return null;
  const returns = agreement.sales.nodes.filter((sale) => sale.actionType === RETURN);
  if (returns.length === 0) return null;
  let total = 0n;
  for (const sale of returns) {
    const cents = centsOf(sale.totalAmount.shopMoney.amount);
    if (cents === null) return null;
    total += cents;
  }
  return {
    externalRefundId: agreement.refund.id,
    amount: Money.fromCents(absolute(total)).toString(),
    occurredAt: new Date(agreement.happenedAt).toISOString(),
  };
}
