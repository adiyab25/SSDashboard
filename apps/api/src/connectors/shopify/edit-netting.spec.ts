import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareGids, nettingInstantsOf, planNetting } from './edit-netting.js';
import {
  mapShopifyOrderSnapshot,
  parseShopifyOrder,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';

// Spec 0015 task 10 (AC-11, Inbound processing item 5): edit netting and Shopify refunds over the
// synthetic fixtures (to be replaced by recordings, task 1). Pure: the operating days are given
// as the inbox job reads them from `ssd_operating_day`.

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(file: string): ShopifyOrder {
  const json = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as {
    response: { body: { data: { order: unknown } } };
  };
  return parseShopifyOrder(json.response.body.data.order);
}

const CONTEXT: ShopifyOrderContext = {
  storeId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e01',
  channelId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e02',
  connectionId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e03',
  variants: new Map(),
  altPhoneAttribute: 'alt_phone',
  gatewayMethods: {},
  giftTags: {},
  goLiveAt: null,
  defaultTaxRate: '14.00',
};

const line = (n: string) => `gid://shopify/LineItem/${n}`;
const sale = (n: string) => `gid://shopify/ProductSale/${n}`;

/** Every netting instant of the order on one operating day (a day with no cutoff surprise). */
function oneDay(order: ShopifyOrder, day: string): Map<string, string> {
  return new Map(nettingInstantsOf(order).map((instant) => [instant, day]));
}

/** An order with its sales history replaced (the agreements as `ORDER_READ` reads them). */
function withHistory(
  order: ShopifyOrder,
  agreements: ShopifyOrder['agreements']['nodes'],
  hasNextPage = false,
): ShopifyOrder {
  return {
    ...structuredClone(order),
    agreements: { nodes: agreements, pageInfo: { hasNextPage } },
  };
}

/** A product sale of the history. */
function productSale(
  id: string,
  actionType: string,
  lineItemId: string,
  amount: string,
): ShopifyOrder['agreements']['nodes'][number]['sales']['nodes'][number] {
  return {
    id: sale(id),
    actionType,
    lineType: 'PRODUCT',
    quantity: amount.startsWith('-') ? -1 : 1,
    totalAmount: { shopMoney: { amount } },
    lineItem: { id: line(lineItemId) },
  };
}

describe('planNetting: edit pairs (AC-11)', () => {
  it('nets the M placed and removed the same day of a size change, never the new L, and changes no line', () => {
    const order = fixture('order-edited-size-swap/02-order-read.json');
    const plan = planNetting(order, oneDay(order, '2026-11-02'), {});
    expect(plan.pairs).toEqual([
      {
        removalSaleId: sale('5000000002003'),
        additionSaleId: sale('5000000002001'),
        channelLineIds: [line('6660000002001')],
        operatingDay: '2026-11-02',
      },
    ]);
    expect(plan.refunds).toEqual([]);
    expect(plan.truncated).toBe(false);
    // Netting never decides which lines exist: the snapshot is the same without it.
    const lines = mapShopifyOrderSnapshot(order, CONTEXT).snapshot.lines.map(
      (l) => l.channelLineId,
    );
    expect(lines).toEqual([line('6660000002002'), line('6660000002003')]);
  });

  it('nets a pair once: a repeat read with the netted sale ids plans nothing new', () => {
    const order = fixture('order-edited-size-swap/02-order-read.json');
    const first = planNetting(order, oneDay(order, '2026-11-02'), {});
    const again = planNetting(order, oneDay(order, '2026-11-02'), {
      nettedSaleIds: first.nettedSaleIds,
    });
    expect(first.pairs).toHaveLength(1);
    expect(again.pairs).toEqual([]);
    expect(again.nettedSaleIds).toEqual(first.nettedSaleIds);
  });

  it('pairs the n-th removal with the n-th addition by sale id for two line items of one variant, keeping the live lines', () => {
    const order = fixture('order-same-variant-lines/02-order-read.json');
    const plan = planNetting(order, oneDay(order, '2026-11-02'), {});
    // C (25003) was added and removed the same day; the first addition of that variant by sale id
    // is A's (25001), so the pair names C and A, and the snapshot still holds A and B.
    expect(plan.pairs).toEqual([
      {
        removalSaleId: sale('5000000028004'),
        additionSaleId: sale('5000000028001'),
        channelLineIds: [line('6660000028003'), line('6660000028001')],
        operatingDay: '2026-11-02',
      },
    ]);
    const lines = mapShopifyOrderSnapshot(order, CONTEXT).snapshot.lines.map(
      (l) => l.channelLineId,
    );
    expect(lines).toEqual([line('6660000028001'), line('6660000028002')]);
  });

  it('does not net a pair across midnight in Cairo with the cutoff at 0, and nets it when the operating day says one day', () => {
    const order = fixture('order-edit-pair-across-midnight/02-order-read.json');
    expect(nettingInstantsOf(order)).toEqual(['2026-11-02T21:50:00Z', '2026-11-02T22:10:00Z']);
    // `ssd_operating_day` with cutoff 0: 23:50 and 00:10 in Cairo fall on two days.
    const cutoffZero = new Map([
      ['2026-11-02T21:50:00Z', '2026-11-02'],
      ['2026-11-02T22:10:00Z', '2026-11-03'],
    ]);
    expect(planNetting(order, cutoffZero, {}).pairs).toEqual([]);
    // With a cutoff of 1 the database puts both on 2 November: the day is the database's.
    const cutoffOne = new Map([
      ['2026-11-02T21:50:00Z', '2026-11-02'],
      ['2026-11-02T22:10:00Z', '2026-11-02'],
    ]);
    expect(planNetting(order, cutoffOne, {}).pairs).toHaveLength(1);
  });

  it('pairs only the same variant and the same absolute amount, never a line without a variant or another line type', () => {
    const base = fixture('order-same-variant-lines/02-order-read.json');
    const noVariant = structuredClone(base);
    const c = noVariant.lineItems.nodes[2];
    if (c) c.variant = null;
    expect(planNetting(noVariant, oneDay(noVariant, '2026-11-02'), {}).pairs).toEqual([]);

    const history = (removal: string, lineType = 'PRODUCT') =>
      withHistory(base, [
        {
          id: 'gid://shopify/OrderAgreement/1',
          happenedAt: '2026-11-02T09:15:00Z',
          sales: {
            nodes: [productSale('10', 'ORDER', '6660000028001', '450.00')],
            pageInfo: { hasNextPage: false },
          },
        },
        {
          id: 'gid://shopify/OrderEditAgreement/2',
          happenedAt: '2026-11-02T11:00:00Z',
          sales: {
            nodes: [{ ...productSale('11', 'UPDATE', '6660000028003', removal), lineType }],
            pageInfo: { hasNextPage: false },
          },
        },
      ]);
    expect(planNetting(history('-400.00'), oneDay(base, '2026-11-02'), {}).pairs).toEqual([]);
    expect(
      planNetting(history('-450.00', 'SHIPPING'), oneDay(base, '2026-11-02'), {}).pairs,
    ).toEqual([]);
    const ordered = history('-450.00');
    expect(planNetting(ordered, oneDay(ordered, '2026-11-02'), {}).pairs).toHaveLength(1);
  });

  it('orders by the numeric sale id, not the text, and leaves extra removals unpaired', () => {
    const base = fixture('order-same-variant-lines/02-order-read.json');
    const order = withHistory(base, [
      {
        id: 'gid://shopify/OrderEditAgreement/2',
        happenedAt: '2026-11-02T10:00:00Z',
        sales: {
          nodes: [
            productSale('10', 'ORDER', '6660000028002', '450.00'),
            productSale('9', 'ORDER', '6660000028001', '450.00'),
            productSale('12', 'UPDATE', '6660000028003', '-450.00'),
            productSale('11', 'UPDATE', '6660000028002', '-450.00'),
            productSale('13', 'UPDATE', '6660000028001', '-450.00'),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    ]);
    const plan = planNetting(order, oneDay(order, '2026-11-02'), {});
    expect(plan.pairs.map((p) => [p.removalSaleId, p.additionSaleId])).toEqual([
      [sale('11'), sale('9')],
      [sale('12'), sale('10')],
    ]);
    expect(compareGids(sale('9'), sale('10'))).toBeLessThan(0);
  });

  it('leaves a sale out when the database gave no day for its instant', () => {
    const order = fixture('order-edited-size-swap/02-order-read.json');
    expect(planNetting(order, new Map(), {}).pairs).toEqual([]);
  });
});

describe('planNetting: Shopify refunds (AC-11, AC-12)', () => {
  it('records the RETURN sales of a refund agreement once per refund id', () => {
    const order = fixture('order-exchange-added-lines/02-order-read.json');
    const plan = planNetting(order, oneDay(order, '2026-11-07'), {});
    expect(plan.refunds).toEqual([
      {
        externalRefundId: 'gid://shopify/Refund/1110000008001',
        amount: '450.00',
        occurredAt: '2026-11-07T15:02:00.000Z',
      },
    ]);
    expect(plan.pairs).toEqual([]);
    expect(plan.recordedRefundIds).toEqual(['gid://shopify/Refund/1110000008001']);
    const again = planNetting(order, oneDay(order, '2026-11-07'), {
      recordedRefundIds: plan.recordedRefundIds,
    });
    expect(again.refunds).toEqual([]);
  });

  it('waits with a refund whose sales were not all read, and reports the history as truncated', () => {
    const order = structuredClone(fixture('order-refunded-after-fulfillment/02-order-read.json'));
    const refund = order.agreements.nodes.find((node) => node.refund !== undefined);
    if (refund) refund.sales.pageInfo.hasNextPage = true;
    const plan = planNetting(order, oneDay(order, '2026-11-05'), {});
    expect(plan.refunds).toEqual([]);
    expect(plan.truncated).toBe(true);

    const more = structuredClone(fixture('order-refunded-after-fulfillment/02-order-read.json'));
    more.agreements.pageInfo.hasNextPage = true;
    const read = planNetting(more, oneDay(more, '2026-11-05'), {});
    expect(read.truncated).toBe(true);
    expect(read.refunds).toHaveLength(1);
  });

  it('records nothing for an order with no refund agreement', () => {
    const order = fixture('order-imported-refunded/02-order-read.json');
    expect(planNetting(order, oneDay(order, '2026-11-05'), {}).refunds).toEqual([]);
  });
});
