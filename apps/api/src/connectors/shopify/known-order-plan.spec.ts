import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nextKnownOrderState, planKnownOrder } from './known-order-plan.js';
import {
  gatewayMappingOf,
  parseShopifyOrder,
  shopifyPaymentOf,
  ShopifyOrderMappingError,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import {
  createdOrderState,
  parseOrderMappingState,
  type OrderMappingState,
} from './order-mapping-state.js';

// Spec 0015 task 9 (AC-9, AC-11, AC-13, AC-14, Inbound processing item 4, Value sourcing): what a
// newer read back of a known order asks of orders, over the synthetic fixtures (to be replaced by
// recordings). Pure: no database.

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(file: string): ShopifyOrder {
  const json = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as {
    response: { body: { data: { order: unknown } } };
  };
  return parseShopifyOrder(json.response.body.data.order);
}

const SKU_M = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e0a';

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

/** The state a mapping holds after the order of `file` was created on `context`. */
function createdState(file: string, context: ShopifyOrderContext = CONTEXT): OrderMappingState {
  const order = fixture(file);
  const lines = order.lineItems.nodes
    .filter((node) => node.currentQuantity > 0)
    .map((node) => ({ channelLineId: node.id, quantity: node.currentQuantity }));
  return createdOrderState(order, context, lines, {
    unmappedLines: [],
    unmappedGateways: Object.entries(gatewayMappingOf(order, context))
      .filter(([, method]) => method === null)
      .map(([name]) => name),
    discountCodes: order.discountCodes,
    flags: [],
  });
}

describe('planKnownOrder: no fulfillment active (AC-11)', () => {
  it('sends every open line of a size swap to applyChannelEdit: the M gone, the new L added, never a return', () => {
    const state = createdState('order-edited-size-swap/01-order-read.json');
    const plan = planKnownOrder(
      fixture('order-edited-size-swap/02-order-read.json'),
      CONTEXT,
      state,
    );
    expect(plan.cancelReasonCode).toBeNull();
    expect(plan.carrierDelivery).toBeNull();
    expect(plan.rederive).toBeNull();
    expect(plan.snapshot?.lines.map((l) => [l.channelLineId, l.quantity])).toEqual([
      [line('6660000002002'), 1],
      [line('6660000002003'), 1],
    ]);
    expect(plan.snapshot?.shipTo.address).toContain('30 شارع التعديل');
  });

  it('plans a late link for an unmapped line whose variant now maps, before the edit', () => {
    const state: OrderMappingState = {
      ...createdState('order-created-cod/01-order-read.json'),
      unmappedLines: [
        {
          channelLineId: line('6660000001001'),
          variantGid: 'gid://shopify/ProductVariant/7770000000101',
        },
        {
          channelLineId: line('6660000001002'),
          variantGid: 'gid://shopify/ProductVariant/7770000000999',
        },
        { channelLineId: line('6660000001003'), variantGid: null },
      ],
    };
    const variants = new Map([['gid://shopify/ProductVariant/7770000000101', SKU_M]]);
    const plan = planKnownOrder(
      fixture('order-created-cod/01-order-read.json'),
      { ...CONTEXT, variants },
      state,
    );
    expect(plan.links).toEqual([
      {
        channelLineId: line('6660000001001'),
        variantGid: 'gid://shopify/ProductVariant/7770000000101',
        variantId: SKU_M,
      },
    ]);
  });
});

describe('planKnownOrder: cancel and fulfillment (AC-13)', () => {
  it('plans only the cancel, with channel.customer, for a Shopify cancel', () => {
    const state = createdState('order-cancelled-later/01-order-read.json');
    const plan = planKnownOrder(
      fixture('order-cancelled-later/02-order-read.json'),
      CONTEXT,
      state,
    );
    expect(plan).toMatchObject({
      cancelReasonCode: 'channel.customer',
      carrierDelivery: null,
      links: [],
      snapshot: null,
      rederive: null,
    });
  });

  it('plans the carrier delivery at the first active fulfillment, holding the applied lines', () => {
    const state = createdState('order-fulfilled-later/01-order-read.json');
    const plan = planKnownOrder(
      fixture('order-fulfilled-later/03-order-read.json'),
      CONTEXT,
      state,
    );
    expect(plan.carrierDelivery).toEqual({
      id: 'gid://shopify/Fulfillment/9990000017001',
      at: '2026-11-03T08:30:00Z',
    });
    expect(plan.snapshot?.lines.map((l) => [l.channelLineId, l.quantity])).toEqual([
      [line('55500000170011'), 1],
      [line('55500000170012'), 1],
    ]);
    expect(plan.snapshot?.shipTo.address).toContain('30 شارع التعديل');
  });

  it('keeps added lines and refunded quantities out of the snapshot while a fulfillment is active (task 10 seam)', () => {
    const state = createdState('order-exchange-added-lines/01-order-read.json');
    expect(state.appliedLines).toEqual({ [line('6660000008001')]: 1 });
    const plan = planKnownOrder(
      fixture('order-exchange-added-lines/02-order-read.json'),
      CONTEXT,
      state,
    );
    // The M was refunded (current quantity 0) and an L added: the snapshot still holds the M at 1.
    expect(plan.snapshot?.lines.map((l) => [l.channelLineId, l.quantity])).toEqual([
      [line('6660000008001'), 1],
    ]);
  });
});

describe('planKnownOrder: the payment rederive (spec 0013 AC-25 c)', () => {
  it('never rederives a COD order after "mark as paid": a new manual sale is no mapping change', () => {
    const state = createdState('order-prepaid-gateway/02-order-read.json');
    const plan = planKnownOrder(
      fixture('order-prepaid-gateway/03-order-read.json'),
      CONTEXT,
      state,
    );
    expect(plan.rederive).toBeNull();
  });

  it('rederives when a gateway the order was derived with now maps to another method', () => {
    const state = createdState('order-prepaid-gateway/01-order-read.json');
    expect(state.gatewayMethods).toEqual({ 'Fixture Card Gateway': null });
    const mapped = { ...CONTEXT, gatewayMethods: { 'Fixture Card Gateway': 'instapay' as const } };
    const plan = planKnownOrder(fixture('order-prepaid-gateway/01-order-read.json'), mapped, state);
    expect(plan.rederive).toEqual({
      paymentMethod: 'instapay',
      prepaidAmount: '860.00',
      prepaidMethod: 'instapay',
    });
    expect(plan.gatewayMethods).toEqual({ 'Fixture Card Gateway': 'instapay' });
  });

  it('reads a milestone 1 mapping (only unmapped gateway names) and leaves a locked one alone', () => {
    const order = fixture('order-created-cod/01-order-read.json');
    const mapped = { ...CONTEXT, gatewayMethods: { 'Cash on Delivery (COD)': 'cod' as const } };
    const milestone1: OrderMappingState = {
      appliedLineIds: [line('6660000001001'), line('6660000001002')],
      unmappedGateways: ['Cash on Delivery (COD)'],
    };
    expect(planKnownOrder(order, mapped, milestone1).rederive).toEqual({
      paymentMethod: 'cod',
      prepaidAmount: '0.00',
      prepaidMethod: null,
    });
    expect(
      planKnownOrder(order, mapped, { ...milestone1, paymentMethodLocked: true }).rederive,
    ).toBeNull();
  });

  it('derives the payment as a new order would (shopifyPaymentOf)', () => {
    expect(shopifyPaymentOf(fixture('order-prepaid-gateway/01-order-read.json'), CONTEXT)).toEqual({
      paymentMethod: 'gateway',
      prepaidAmount: '860.00',
      prepaidMethod: 'gateway',
    });
  });
});

describe('nextKnownOrderState', () => {
  const state: OrderMappingState = {
    ...createdState('order-edited-size-swap/01-order-read.json'),
    unmappedLines: [{ channelLineId: line('6660000002002'), variantGid: null }],
    stockOuts: { kept: ['for task 9a'] },
  };
  const plan = planKnownOrder(fixture('order-edited-size-swap/02-order-read.json'), CONTEXT, state);

  it('takes an applied snapshot as the held lines and keeps keys of later tasks', () => {
    const next = nextKnownOrderState(state, plan, {
      editApplied: true,
      linked: new Set(),
      rederiveTried: false,
      paymentLocked: false,
    });
    expect(next.appliedLines).toEqual({ [line('6660000002002')]: 1, [line('6660000002003')]: 1 });
    expect(next.appliedLineIds).toEqual([line('6660000002002'), line('6660000002003')]);
    expect(next['stockOuts']).toEqual({ kept: ['for task 9a'] });
    expect(next.gatewayMethods).toEqual(state.gatewayMethods);
  });

  it('keeps the held lines of a refused edit, drops linked lines, and records a locked payment', () => {
    const next = nextKnownOrderState(state, plan, {
      editApplied: false,
      linked: new Set([line('6660000002002')]),
      rederiveTried: true,
      paymentLocked: true,
    });
    expect(next.appliedLines).toEqual(state.appliedLines);
    expect(next.unmappedLines).toBeUndefined();
    expect(next.paymentMethodLocked).toBe(true);
    expect(next.gatewayMethods).toEqual(plan.gatewayMethods);
  });
});

describe('parseOrderMappingState', () => {
  it('reads an empty state and refuses a damaged one with paths only', () => {
    expect(parseOrderMappingState({})).toEqual({});
    expect(parseOrderMappingState(null)).toEqual({});
    let error: unknown = null;
    try {
      parseOrderMappingState({ appliedLines: { x: 'مها تجريبية' } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ShopifyOrderMappingError);
    expect((error as ShopifyOrderMappingError).code).toBe('MAPPING_STATE_UNREADABLE');
    expect((error as Error).message).not.toContain('مها');
  });
});
