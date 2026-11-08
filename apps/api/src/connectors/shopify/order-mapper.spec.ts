import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cancelReasonCodeOf,
  firstActiveFulfillmentOf,
  foundStatesOf,
  mapShopifyOrder,
  mapShopifyOrderSnapshot,
  parseShopifyOrder,
  replacementInput,
  ShopifyOrderMappingError,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import { ORDER_READ, ORDER_READ_OPERATION } from './shopify-queries.js';

// Spec 0015 Inbound processing item 4 and Value sourcing, over the synthetic fixtures (to be
// replaced by recordings). Every case reads a fixture's `data.order` through the production
// schema; a case that needs a shape no fixture holds (a gift tag, a test order, control
// characters) changes a copy of one in memory.

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** A fixture's order, parsed by `parseShopifyOrder` as the inbox job will parse a read back. */
function fixture(file: string): ShopifyOrder {
  const json = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as {
    response: { body: { data: { order: unknown } } };
  };
  return parseShopifyOrder(json.response.body.data.order);
}

/** A deep copy of a fixture order with a change applied. */
function changed(file: string, change: (order: ShopifyOrder) => void): ShopifyOrder {
  const order = structuredClone(fixture(file));
  change(order);
  return order;
}

const STORE = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e01';
const CHANNEL = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e02';
const CONNECTION = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e03';
const SKU_M = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e0a';
const SKU_L = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e0b';
const ORIGINAL = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2eff';

const CONTEXT: ShopifyOrderContext = {
  storeId: STORE,
  channelId: CHANNEL,
  connectionId: CONNECTION,
  variants: new Map([
    ['gid://shopify/ProductVariant/7770000000101', SKU_M],
    ['gid://shopify/ProductVariant/7770000000102', SKU_L],
  ]),
  altPhoneAttribute: 'alt_phone',
  gatewayMethods: {
    'Cash on Delivery (COD)': 'cod',
    manual: 'cod',
    'Fixture Card Gateway': 'gateway',
  },
  giftTags: { influencer: 'influencer', 'pr-box': 'pr_seeding' },
  goLiveAt: null,
};

const COD = 'order-created-cod/01-order-read.json';
const ZERO = { shopMoney: { amount: '0.00' } };

/** The error a call throws, or null. */
function thrown(call: () => unknown): unknown {
  try {
    call();
    return null;
  } catch (error: unknown) {
    return error;
  }
}

describe('the ORDER_READ query', () => {
  it('names its operation and its id variable, and never selects the deprecated fulfillable quantity (D5)', () => {
    expect(ORDER_READ_OPERATION).toBe('OrderRead');
    expect(ORDER_READ).toMatch(/^query OrderRead\(\$id: ID!\) \{/);
    expect(ORDER_READ).toContain('unfulfilledQuantity');
    expect(ORDER_READ).not.toContain('fulfillableQuantity');
    expect(ORDER_READ).toContain('defaultPhoneNumber');
    expect(ORDER_READ).toContain('... on DiscountCodeApplication');
  });
});

describe('mapShopifyOrder', () => {
  it('maps a COD order field by field', () => {
    const mapping = mapShopifyOrder(fixture(COD), CONTEXT);

    expect(mapping.actor).toBe('system_job');
    expect(mapping.flags).toEqual([]);
    expect(mapping.unmappedLines).toEqual([]);
    expect(mapping.unmappedGateways).toEqual([]);
    expect(mapping.discountCodes).toEqual(['WELCOME10']);
    expect(mapping.input).toMatchObject({
      storeId: STORE,
      channelId: CHANNEL,
      channelOrderRef: 'gid://shopify/Order/5550000001001',
      orderNumber: '#1001',
      placedAt: '2026-11-02T09:15:00Z',
      type: 'sale',
      giftReasonCode: null,
      paymentMethod: 'cod',
      prepaidAmount: '0.00',
      prepaidMethod: null,
      firstStates: null,
      relatedOrder: null,
      shippingChargedAmount: '50.00',
      discountCode: 'WELCOME10',
      customerNote: 'اتصلوا قبل التوصيل (fixture note)',
      channelCustomer: {
        kind: 'shopify_customer',
        connectionId: CONNECTION,
        externalId: 'gid://shopify/Customer/8880000001001',
      },
      shipTo: {
        name: 'مها تجريبية',
        phone: '+201000000101',
        phoneAlt: '+201000000102',
        address: '12 شارع الاختبار، عمارة 3, شقة 4, مدينة نصر, Cairo',
      },
    });
    expect(mapping.input.lines).toEqual([
      {
        channelLineId: 'gid://shopify/LineItem/6660000001001',
        variantId: SKU_M,
        title: 'Fixture Basic Tee M',
        quantity: 1,
        unitPrice: '450.00',
        discountAmount: '45.00',
        taxRate: '14.00',
      },
      {
        channelLineId: 'gid://shopify/LineItem/6660000001002',
        variantId: SKU_L,
        title: 'Fixture Basic Tee L',
        quantity: 1,
        unitPrice: '450.00',
        discountAmount: '45.00',
        taxRate: '14.00',
      },
    ]);
  });

  it('gives a line without tax lines the defaultTaxRate (sales_tax_rate, D8), else 0.00', () => {
    const untaxed = changed(COD, (order) => {
      const [line] = order.lineItems.nodes;
      if (line) line.taxLines = [];
    });

    const withSetting = mapShopifyOrder(untaxed, { ...CONTEXT, defaultTaxRate: '12.50' });
    const without = mapShopifyOrder(untaxed, CONTEXT);

    // The untaxed line takes the setting; the taxed line keeps Shopify's rate.
    expect(withSetting.input.lines.map((line) => line.taxRate)).toEqual(['12.50', '14.00']);
    expect(without.input.lines.map((line) => line.taxRate)).toEqual(['0.00', '14.00']);
  });

  it('keeps only allow listed UTM keys in the landing page and the referrer (spec 0002 m5)', () => {
    const { source } = mapShopifyOrder(fixture(COD), CONTEXT).input;
    const withReferrer = changed(COD, (order) => {
      const visit = order.customerJourneySummary?.lastVisit;
      if (visit) visit.referrerUrl = 'https://ref.example/a?utm_term=t&gclid=secret#frag';
    });

    expect(source).toMatchObject({
      capturedFrom: 'shopify_journey',
      utmSource: 'fixture_social',
      utmMedium: 'paid',
      utmCampaign: 'fixture_launch',
      utmContent: 'fixture_video_a',
      referrer: 'https://fixture-social.example/',
    });
    expect(source.landingPage).toBe(
      'https://fixture-store.example/products/basic-tee?utm_source=fixture_social&utm_medium=paid&utm_campaign=fixture_launch',
    );
    expect(source.landingPage).not.toContain('email_token');
    expect(mapShopifyOrder(withReferrer, CONTEXT).input.source.referrer).toBe(
      'https://ref.example/a?utm_term=t',
    );
  });

  it('captures nothing without a visit, and drops a link that is not http', () => {
    const none = changed(COD, (order) => {
      order.customerJourneySummary = null;
    });
    const script = changed(COD, (order) => {
      const visit = order.customerJourneySummary?.lastVisit;
      if (visit) visit.landingPage = 'javascript:alert(1)';
    });

    expect(mapShopifyOrder(none, CONTEXT).input.source.capturedFrom).toBe('none');
    expect(mapShopifyOrder(script, CONTEXT).input.source.landingPage).toBeNull();
  });

  it('maps a prepaid card order to gateway with the sale prepaid', () => {
    const { input } = mapShopifyOrder(fixture('order-prepaid-gateway/01-order-read.json'), CONTEXT);

    expect([input.paymentMethod, input.prepaidAmount, input.prepaidMethod]).toEqual([
      'gateway',
      '860.00',
      'gateway',
    ]);
  });

  it('keeps a cod order cod with nothing prepaid after "mark as paid" (a manual sale)', () => {
    const unpaid = mapShopifyOrder(fixture('order-prepaid-gateway/02-order-read.json'), CONTEXT);
    const marked = mapShopifyOrder(fixture('order-prepaid-gateway/03-order-read.json'), CONTEXT);

    expect([unpaid.input.paymentMethod, unpaid.input.prepaidAmount]).toEqual(['cod', '0.00']);
    expect([
      marked.input.paymentMethod,
      marked.input.prepaidAmount,
      marked.input.prepaidMethod,
    ]).toEqual(['cod', '0.00', null]);
  });

  it('lists an unmapped gateway: cod without a successful sale, gateway with one', () => {
    const unmapped = changed(COD, (order) => {
      order.paymentGatewayNames = ['Fixture New Wallet', 'constructor'];
    });
    const paid = changed('order-prepaid-gateway/01-order-read.json', (order) => {
      order.paymentGatewayNames = ['Fixture New Wallet'];
      for (const transaction of order.transactions) transaction.gateway = 'Fixture New Wallet';
    });
    const refunded = changed('order-prepaid-gateway/01-order-read.json', (order) => {
      order.transactions.push({
        kind: 'REFUND',
        status: 'SUCCESS',
        gateway: 'Fixture Card Gateway',
        amountSet: { shopMoney: { amount: '860.00' } },
      });
    });

    const cod = mapShopifyOrder(unmapped, CONTEXT);
    const gateway = mapShopifyOrder(paid, CONTEXT);

    expect(cod.input.paymentMethod).toBe('cod');
    expect(cod.unmappedGateways).toEqual(['Fixture New Wallet', 'constructor']);
    expect([gateway.input.paymentMethod, gateway.input.prepaidAmount]).toEqual([
      'gateway',
      '860.00',
    ]);
    expect(gateway.input.prepaidMethod).toBe('gateway');
    expect(gateway.unmappedGateways).toEqual(['Fixture New Wallet']);
    expect([
      mapShopifyOrder(refunded, CONTEXT).input.prepaidAmount,
      mapShopifyOrder(refunded, CONTEXT).input.prepaidMethod,
    ]).toEqual(['0.00', null]);
  });

  it('passes phones that do not parse as text, for orders to keep raw and flag', () => {
    const { input } = mapShopifyOrder(fixture('order-bad-phone/01-order-read.json'), CONTEXT);

    expect(input.shipTo).toMatchObject({ phone: '+201300000101', phoneAlt: '0100000' });
  });

  it('keeps an unmapped line and a deleted variant line with a null variant, and lists both', () => {
    const mapping = mapShopifyOrder(fixture('order-unmapped-line/01-order-read.json'), CONTEXT);

    expect(mapping.input.lines.map((line) => [line.title, line.variantId])).toEqual([
      ['Fixture Basic Tee M', SKU_M],
      ['Fixture Basic Tee XL', null],
      ['Fixture Deleted Product', null],
    ]);
    expect(mapping.unmappedLines).toEqual([
      {
        channelLineId: 'gid://shopify/LineItem/6660000003002',
        variantGid: 'gid://shopify/ProductVariant/7770000000999',
      },
      { channelLineId: 'gid://shopify/LineItem/6660000003003', variantGid: null },
    ]);
  });

  it('keeps an Arabic name and strips control and direction characters, phone text at most 64', () => {
    const typed = changed(COD, (order) => {
      if (order.shippingAddress) {
        order.shippingAddress.name = '‮مها\u0000 تجريبية‏';
        order.shippingAddress.phone = `⁦+201000000101⁩${'9'.repeat(80)}`;
      }
      order.note = 'line one\nline two‮\u0007';
    });

    const { shipTo, customerNote } = mapShopifyOrder(typed, CONTEXT).input;

    expect(shipTo.name).toBe('مها تجريبية');
    expect(shipTo.phone?.startsWith('+20100000010199')).toBe(true);
    expect(shipTo.phone).toHaveLength(64);
    expect(customerNote).toBe('line one\nline two');
  });

  it('takes the ship to phone, else the order phone, else the customer default phone, else its deprecated phone (D4)', () => {
    const noAddressPhone = (order: ShopifyOrder) => {
      if (order.shippingAddress) order.shippingAddress.phone = null;
    };
    const orderPhone = changed(COD, (order) => {
      noAddressPhone(order);
      order.phone = '+201000000111';
    });
    const defaultPhone = changed(COD, (order) => {
      noAddressPhone(order);
      order.phone = null;
      if (order.customer) order.customer.defaultPhoneNumber = { phoneNumber: '+201000000122' };
    });
    const deprecatedPhone = changed(COD, (order) => {
      noAddressPhone(order);
      order.phone = null;
      if (order.customer) {
        order.customer.defaultPhoneNumber = null;
        order.customer.phone = '+201000000133';
      }
    });

    expect(mapShopifyOrder(orderPhone, CONTEXT).input.shipTo.phone).toBe('+201000000111');
    expect(mapShopifyOrder(defaultPhone, CONTEXT).input.shipTo.phone).toBe('+201000000122');
    expect(mapShopifyOrder(deprecatedPhone, CONTEXT).input.shipTo.phone).toBe('+201000000133');
  });

  it('takes the first discount code that is not a shipping discount, keeping every code (D6)', () => {
    const order = changed(COD, (o) => {
      o.discountCodes = ['FREESHIP', 'WELCOME10'];
      o.discountApplications.nodes = [
        { __typename: 'DiscountCodeApplication', targetType: 'SHIPPING_LINE', code: 'FREESHIP' },
        { __typename: 'DiscountCodeApplication', targetType: 'LINE_ITEM', code: 'WELCOME10' },
      ];
    });

    const mapping = mapShopifyOrder(order, CONTEXT);

    expect(mapping.input.discountCode).toBe('WELCOME10');
    expect(mapping.discountCodes).toEqual(['FREESHIP', 'WELCOME10']);
  });

  it('reads money as exact decimals, rounding a third decimal half away from zero', () => {
    const order = changed(COD, (o) => {
      const [line] = o.lineItems.nodes;
      if (line) {
        line.originalUnitPriceSet = { shopMoney: { amount: '450.005' } };
        line.discountAllocations = [
          { allocatedAmountSet: { shopMoney: { amount: '0.10' } } },
          { allocatedAmountSet: { shopMoney: { amount: '0.20' } } },
        ];
      }
    });

    const [line] = mapShopifyOrder(order, CONTEXT).input.lines;

    expect([line?.unitPrice, line?.discountAmount]).toEqual(['450.01', '0.30']);
  });

  it('maps a free order with a listed gift tag as gifted with its reason (AC-10)', () => {
    const free = changed(COD, (order) => {
      order.tags = ['Influencer'];
      order.totalPriceSet = ZERO;
    });
    const otherReason = changed(COD, (order) => {
      order.tags = ['pr-box'];
      order.totalPriceSet = ZERO;
    });

    const gifted = mapShopifyOrder(free, CONTEXT);
    const other = mapShopifyOrder(otherReason, CONTEXT);

    expect([gifted.input.type, gifted.input.giftReasonCode]).toEqual(['gifted', 'influencer']);
    expect(gifted.flags).toEqual([]);
    expect([other.input.type, other.input.giftReasonCode]).toEqual(['gifted', 'other']);
    expect(other.flags).toEqual(['gift_reason_not_a_gift_code']);
  });

  it('maps a paid order with a listed gift tag as a sale flagged gift_tag_not_free (AC-10)', () => {
    const paid = changed(COD, (order) => {
      order.tags = ['influencer'];
    });

    const mapping = mapShopifyOrder(paid, CONTEXT);

    expect([mapping.input.type, mapping.input.giftReasonCode]).toEqual(['sale', null]);
    expect(mapping.flags).toEqual(['gift_tag_not_free']);
  });

  it('flags a test order so the inbox job ignores it', () => {
    const test = changed(COD, (order) => {
      order.test = true;
    });

    expect(mapShopifyOrder(test, CONTEXT).flags).toEqual(['test_order']);
  });

  it('maps the same order name of two shops to each connection store (B1)', () => {
    const other: ShopifyOrderContext = {
      ...CONTEXT,
      storeId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e21',
      channelId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e22',
      connectionId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e23',
    };

    const one = mapShopifyOrder(fixture('order-number-collision/01-order-read.json'), CONTEXT);
    const two = mapShopifyOrder(fixture('order-number-collision/02-order-read.json'), other);

    expect([one.input.orderNumber, two.input.orderNumber]).toEqual(['#1001', '#1001']);
    expect([one.input.storeId, two.input.storeId]).toEqual([STORE, other.storeId]);
    expect(two.input.channelCustomer?.connectionId).toBe(other.connectionId);
  });

  it('gives the go live state to an open order placed before go live, found states to closed ones, and nothing after', () => {
    const goLive = { ...CONTEXT, goLiveAt: '2026-11-01T00:00:00Z' };

    const open = mapShopifyOrder(fixture('order-go-live-import/01-order-read.json'), goLive);
    const fulfilled = mapShopifyOrder(fixture('order-go-live-import/02-order-read.json'), goLive);
    const cancelled = mapShopifyOrder(fixture('order-go-live-import/03-order-read.json'), goLive);
    const live = mapShopifyOrder(fixture(COD), goLive);

    expect([open.actor, open.input.firstStates]).toEqual([
      'system_job',
      { fulfillment: 'confirmed', reasonCode: 'go_live_import' },
    ]);
    expect(fulfilled.actor).toBe('import');
    expect(fulfilled.input.firstStates).toMatchObject({
      fulfillment: 'shipped',
      cash: 'unpaid',
      carrierDeliveryCreatedAt: '2026-10-23T09:00:00Z',
    });
    expect(cancelled.actor).toBe('import');
    expect(cancelled.input.firstStates).toMatchObject({
      fulfillment: 'cancelled',
      cash: 'nothing_to_collect',
      cancelReasonCode: 'channel.staff',
    });
    expect([live.actor, live.input.firstStates]).toEqual(['system_job', null]);
  });

  it('refuses a truncated read rather than mapping a short order', () => {
    const lines = changed(COD, (order) => {
      order.lineItems.pageInfo.hasNextPage = true;
    });
    const none = changed(COD, (order) => {
      for (const line of order.lineItems.nodes) line.currentQuantity = 0;
    });

    expect(thrown(() => mapShopifyOrder(lines, CONTEXT))).toMatchObject({
      code: 'LINE_ITEMS_TRUNCATED',
    });
    expect(thrown(() => mapShopifyOrder(none, CONTEXT))).toMatchObject({ code: 'NO_OPEN_LINES' });
  });
});

describe('mapShopifyOrderSnapshot', () => {
  it('holds every line with a current quantity above 0 and no identity fields (size swap)', () => {
    const { snapshot } = mapShopifyOrderSnapshot(
      fixture('order-edited-size-swap/02-order-read.json'),
      CONTEXT,
    );

    expect(snapshot.lines.map((line) => [line.channelLineId, line.title])).toEqual([
      ['gid://shopify/LineItem/6660000002002', 'Fixture Basic Tee L'],
      ['gid://shopify/LineItem/6660000002003', 'Fixture Basic Tee L'],
    ]);
    expect(snapshot.shipTo.address).toContain('شارع التعديل');
    expect(snapshot).not.toHaveProperty('channelOrderRef');
    expect(snapshot).not.toHaveProperty('prepaidAmount');
  });
});

describe('cancelReasonCodeOf (AC-13)', () => {
  it('gives channel. plus the lower case reason, channel.other for one that does not fit, null when open', () => {
    const unknown = changed('order-cancelled-customer/01-order-read.json', (order) => {
      order.cancelReason = 'NEW REASON!';
    });
    const silent = changed('order-cancelled-customer/01-order-read.json', (order) => {
      order.cancelReason = null;
    });

    expect(cancelReasonCodeOf(fixture('order-cancelled-customer/01-order-read.json'))).toBe(
      'channel.customer',
    );
    expect(cancelReasonCodeOf(fixture('order-go-live-import/03-order-read.json'))).toBe(
      'channel.staff',
    );
    expect(cancelReasonCodeOf(unknown)).toBe('channel.other');
    expect(cancelReasonCodeOf(silent)).toBe('channel.other');
    expect(cancelReasonCodeOf(fixture(COD))).toBeNull();
  });
});

describe('foundStatesOf and firstActiveFulfillmentOf', () => {
  it('finds shipped at the first active fulfillment, cancelled with its reason, and null when open', () => {
    expect(foundStatesOf(fixture('order-go-live-import/02-order-read.json'), CONTEXT)).toEqual({
      fulfillment: 'shipped',
      cash: 'unpaid',
      carrierDeliveryCreatedAt: '2026-10-23T09:00:00Z',
    });
    expect(foundStatesOf(fixture('order-go-live-import/03-order-read.json'), CONTEXT)).toEqual({
      fulfillment: 'cancelled',
      cash: 'nothing_to_collect',
      carrierDeliveryCreatedAt: null,
      cancelReasonCode: 'channel.staff',
    });
    expect(foundStatesOf(fixture('order-go-live-import/01-order-read.json'), CONTEXT)).toBeNull();
  });

  it('finds a fully prepaid fulfilled order prepaid', () => {
    const order = changed('order-prepaid-gateway/01-order-read.json', (o) => {
      o.fulfillments = [
        { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', createdAt: '2026-11-03T08:00:00Z' },
      ];
    });

    expect(foundStatesOf(order, CONTEXT)).toMatchObject({
      fulfillment: 'shipped',
      cash: 'prepaid',
    });
  });

  it('skips cancelled fulfillments and takes the earliest active one', () => {
    const order = changed(COD, (o) => {
      o.fulfillments = [
        { id: 'gid://shopify/Fulfillment/3', status: 'SUCCESS', createdAt: '2026-11-05T08:00:00Z' },
        {
          id: 'gid://shopify/Fulfillment/1',
          status: 'CANCELLED',
          createdAt: '2026-11-03T08:00:00Z',
        },
        { id: 'gid://shopify/Fulfillment/2', status: 'SUCCESS', createdAt: '2026-11-04T08:00:00Z' },
      ];
    });
    const allCancelled = changed(COD, (o) => {
      o.fulfillments = [
        {
          id: 'gid://shopify/Fulfillment/1',
          status: 'CANCELLED',
          createdAt: '2026-11-03T08:00:00Z',
        },
      ];
    });

    expect(firstActiveFulfillmentOf(order)).toEqual({
      id: 'gid://shopify/Fulfillment/2',
      createdAt: '2026-11-04T08:00:00Z',
    });
    expect(firstActiveFulfillmentOf(allCancelled)).toBeNull();
    expect(
      firstActiveFulfillmentOf(fixture('order-cancelled-customer/02-order-read.json')),
    ).toEqual({ id: 'gid://shopify/Fulfillment/9990000006101', createdAt: '2026-11-03T08:30:00Z' });
  });
});

describe('replacementInput (AC-12)', () => {
  const before = () => fixture('order-exchange-added-lines/01-order-read.json');
  const after = () => fixture('order-exchange-added-lines/02-order-read.json');
  const known = () => new Set(before().lineItems.nodes.map((line) => line.id));

  it('holds only the added lines, numbered -R<n>, ref :R<n>, no shipping, linked replacement_for', () => {
    const mapping = replacementInput(
      after(),
      { originalOrderId: ORIGINAL, n: 1, knownLineIds: known() },
      CONTEXT,
    );

    expect(mapping?.input).toMatchObject({
      channelOrderRef: 'gid://shopify/Order/5550000008001:R1',
      orderNumber: '#1009-R1',
      relatedOrder: { orderId: ORIGINAL, relation: 'replacement_for' },
      shippingChargedAmount: '0.00',
      discountCode: null,
      customerNote: null,
      prepaidAmount: '0.00',
    });
    expect(mapping?.input.lines.map((line) => [line.title, line.variantId])).toEqual([
      ['Fixture Basic Tee L', SKU_L],
    ]);
  });

  it('answers null when no line was added and refuses a replacement number below 1', () => {
    const allKnown = new Set(after().lineItems.nodes.map((line) => line.id));

    expect(
      replacementInput(
        after(),
        { originalOrderId: ORIGINAL, n: 1, knownLineIds: allKnown },
        CONTEXT,
      ),
    ).toBeNull();
    expect(
      thrown(() =>
        replacementInput(
          after(),
          { originalOrderId: ORIGINAL, n: 0, knownLineIds: known() },
          CONTEXT,
        ),
      ),
    ).toMatchObject({ code: 'BAD_REPLACEMENT_NUMBER' });
  });
});

describe('no personal data in a thrown error (Law 151)', () => {
  const SENTINELS = [
    'Sentinel Person Name',
    '+201099988877',
    '77 Sentinel Street',
    'Sentinel private note',
  ];
  const personal = (order: ShopifyOrder) => {
    order.shippingAddress = {
      name: SENTINELS[0] ?? null,
      phone: SENTINELS[1] ?? null,
      address1: SENTINELS[2] ?? null,
      address2: null,
      city: null,
      province: null,
    };
    order.note = SENTINELS[3] ?? null;
  };
  const expectClean = (error: unknown) => {
    expect(error).toBeInstanceOf(ShopifyOrderMappingError);
    const text = `${String((error as Error).message)} ${JSON.stringify(error)}`;
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
  };

  it('keeps the read values out of an unreadable order error, naming only the paths', () => {
    const raw = structuredClone(fixture(COD)) as unknown as Record<string, unknown>;
    personal(raw as unknown as ShopifyOrder);
    raw['test'] = SENTINELS[0];
    (raw['shippingAddress'] as Record<string, unknown>)['phone'] = 12345;

    const error = thrown(() => parseShopifyOrder(raw));

    expectClean(error);
    expect(error).toMatchObject({ code: 'ORDER_UNREADABLE' });
    expect((error as ShopifyOrderMappingError).paths).toEqual(['test', 'shippingAddress.phone']);
  });

  it('keeps them out of a contract refusal, an empty order, and a bad amount', () => {
    const taxed = changed(COD, (order) => {
      personal(order);
      const [line] = order.lineItems.nodes;
      if (line) line.taxLines = [{ rate: null, ratePercentage: 150 }];
    });
    const empty = changed(COD, (order) => {
      personal(order);
      for (const line of order.lineItems.nodes) line.currentQuantity = 0;
    });
    const amount = changed(COD, (order) => {
      personal(order);
      order.totalShippingPriceSet = { shopMoney: { amount: SENTINELS[1] ?? '' } };
    });

    const refused = thrown(() => mapShopifyOrder(taxed, CONTEXT));
    expectClean(refused);
    expect(refused).toMatchObject({ code: 'CONTRACT_REFUSED', paths: ['lines.0.taxRate'] });
    expectClean(thrown(() => mapShopifyOrderSnapshot(empty, CONTEXT)));
    expectClean(thrown(() => mapShopifyOrder(amount, CONTEXT)));
  });
});
