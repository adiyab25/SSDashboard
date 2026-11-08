import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  OrderDetail,
  OrderFilterOptions,
  OrderListResponse,
  OrderOptions,
  SkuDetail,
  replayStates,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { OrderIntake } from '../src/orders/intake/order-intake.service.js';
import { OrderTransactions } from '../src/orders/order-transactions.js';
import { OrderAttentionRaised, OrderStateChanged } from '../src/orders/orders.events.js';
import { OrderNumberTaken } from '../src/orders/orders.errors.js';
import { OrderQueries } from '../src/orders/reading/order-query.service.js';
import { OrderWriter } from '../src/orders/writer/order-writer.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0013 milestone 1 (AC-1 to AC-6, AC-14, AC-18, AC-19, AC-21, AC-22, AC-23, AC-25): the
// orders module against PostgreSQL as the application role, through the real routes.
describe('orders, milestone 1', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let manager = '';
  let managerCost = '';
  let support = '';
  let warehouse = '';
  let mainStore = '';
  let manualChannel = '';
  let whatsappChannel = '';
  let shopifyStore = '';
  let shopifyChannel = '';
  let otherStore = '';
  let skuM = '';
  let skuL = '';
  let skuBilingual = '';
  let n = 0;
  const attentions: OrderAttentionRaised[] = [];
  const stateEvents: OrderStateChanged[] = [];
  let failStateEvents = false;

  const phone = () => {
    n += 1;
    return `0100${String(1_000_000 + n)}`;
  };

  const body = (over: Record<string, unknown> = {}) => ({
    clientRef: randomUUID(),
    storeId: mainStore,
    channelId: manualChannel,
    shipTo: { name: 'Sentinel Name', phone: phone(), address: '12 Sentinel Street' },
    lines: [
      { variantId: skuM, quantity: 2, unitPrice: '570.00' },
      { variantId: skuL, quantity: 1, unitPrice: '400.00' },
    ],
    shippingChargedAmount: '50.00',
    paymentMethod: 'cod',
    ...over,
  });

  const create = async (over: Record<string, unknown> = {}, cookie = support) => {
    const reply = await api.call(cookie, 'POST', '/api/orders', body(over));
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return CreatedOrder.parse(reply.body);
  };

  const detail = async (id: string, cookie = support) => {
    const reply = await api.call(cookie, 'GET', `/api/orders/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OrderDetail.parse(reply.body);
  };

  const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => api.owner.pool.query<T>(text, params);

  const setState = (id: string, state: 'cancelled' | 'refused' | 'delivered') =>
    owner(
      `UPDATE orders SET fulfillment_state = $2::order_fulfillment_state,
              cancel_reason_code = CASE WHEN $2 = 'cancelled' THEN 'fake' END,
              refused_reason_code = CASE WHEN $2 = 'refused' THEN 'size' END,
              outcome = CASE $2 WHEN 'cancelled' THEN 'cancelled_before_shipping'
                                WHEN 'refused' THEN 'failed_delivery' ELSE 'kept' END::order_outcome
       WHERE id = $1::uuid`,
      [id, state],
    );

  beforeAll(async () => {
    api = await startInProcessApi();
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    managerCost = await api.signIn((await api.addPerson(['manager'], { costView: true })).email);
    support = await api.signIn((await api.addPerson(['support'])).email);
    warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    whatsappChannel = await one(
      `INSERT INTO channels (code, name, kind) VALUES ('wa', '{"en":"WhatsApp"}', 'whatsapp') RETURNING id`,
    );
    shopifyStore = await one(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ('ESS', '{"en":"Essentials"}', '{"en":"Essentials"}', 'shopify') RETURNING id`,
    );
    shopifyChannel = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('ESS', '{"en":"Essentials"}', 'shopify', '${shopifyStore}') RETURNING id`,
    );
    otherStore = await one(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ('OTH', '{"en":"Other"}', '{"en":"Other"}', 'internal') RETURNING id`,
    );
    const sku = async (code: string) => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '570.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };
    skuM = await sku('TEE-M');
    skuL = await sku('TEE-L');
    const bilingual = await api.call(manager, 'POST', '/api/products', {
      name: { en: 'Linen shirt', ar: 'قميص كتان' },
      variants: [{ sku: 'SHIRT-AR', price: '300.00' }],
    });
    skuBilingual = SkuDetail.parse(bilingual.body).id;
    const events = api.app.get(DomainEvents);
    events.on(OrderAttentionRaised, (_tx, event) => void attentions.push(event), 'orders-e2e');
    events.on(
      OrderStateChanged,
      (_tx, event) => {
        if (failStateEvents) throw new Error('a projection failed');
        stateEvents.push(event);
      },
      'orders-e2e',
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('a manual order (AC-1, AC-3, AC-5, AC-6)', () => {
    it('numbers it, prices it, and writes its two first events', async () => {
      const made = await create();
      const order = await detail(made.id);

      expect(made.storeCode).toBe('MAIN');
      expect(made.orderNumber).toMatch(/^SO-\d{4}-\d{6}$/);
      expect(order).toMatchObject({
        storeCode: 'MAIN',
        type: 'sale',
        fulfillmentState: 'new',
        cashState: 'unpaid',
        outcome: 'open',
      });
      expect(order.money).toMatchObject({
        linesGrossAmount: '1540.00',
        shippingChargedAmount: '50.00',
        totalAmount: '1590.00',
        codExpectedAmount: '1590.00',
        codDueAmount: '1590.00',
        prepaidAmount: '0.00',
      });
      expect(order.lines.map((line) => [line.position, line.skuCode, line.grossAmount])).toEqual([
        [1, 'TEE-M', '1140.00'],
        [2, 'TEE-L', '400.00'],
      ]);
      expect(order.events.map((e) => [e.machine, e.fromState, e.toState])).toEqual([
        ['fulfillment', null, 'new'],
        ['cash', null, 'unpaid'],
      ]);
      expect(order.customer).not.toBeNull();
      expect(order.shipTo.name).toBe('Sentinel Name');
      expect(order.shipTo.phone).toMatch(/^\+2010/);
    });

    it('returns the first order for a repeated clientRef and writes nothing', async () => {
      const first = body();
      const one = await api.call(support, 'POST', '/api/orders', first);
      const two = await api.call(support, 'POST', '/api/orders', first);
      const rows = await owner(
        `SELECT (SELECT count(*) FROM orders WHERE channel_order_ref = $1) AS orders,
                (SELECT count(*) FROM order_events e JOIN orders o ON o.id = e.order_id
                  WHERE o.channel_order_ref = $1) AS events`,
        [first.clientRef],
      );

      expect([one.status, two.status]).toEqual([201, 200]);
      expect(CreatedOrder.parse(two.body)).toEqual(CreatedOrder.parse(one.body));
      expect(rows.rows[0]).toEqual({ orders: '1', events: '2' });
    });

    it('runs 10 parallel creates of one clientRef to one order and one number', async () => {
      const same = body();
      const replies = await Promise.all(
        Array.from({ length: 10 }, () => api.call(support, 'POST', '/api/orders', same)),
      );
      const ids = new Set(replies.map((r) => CreatedOrder.parse(r.body).id));
      const created = replies.filter((r) => r.status === 201).length;

      expect(ids.size).toBe(1);
      expect(created).toBe(1);
    });

    it('replays its events to the stored states, two events of one transaction included', async () => {
      const made = await create();
      const { rows: events } = await owner<{
        machine: 'fulfillment' | 'cash';
        fromState: string | null;
        toState: string;
      }>(
        `SELECT machine, from_state AS "fromState", to_state AS "toState"
         FROM order_events WHERE order_id = $1::uuid ORDER BY recorded_at, id`,
        [made.id],
      );
      const stored = await owner<{ fulfillment_state: string; cash_state: string }>(
        `SELECT fulfillment_state, cash_state FROM orders WHERE id = $1::uuid`,
        [made.id],
      );

      expect(replayStates(events)).toEqual({
        fulfillment: stored.rows[0]?.fulfillment_state,
        cash: stored.rows[0]?.cash_state,
      });
    });

    it('takes a full prepayment as the first cash state prepaid', async () => {
      const made = await create({ paymentMethod: 'instapay', prepaidAmount: '1590.00' });
      const order = await detail(made.id);

      expect(order.cashState).toBe('prepaid');
      expect(order.money).toMatchObject({
        prepaidAmount: '1590.00',
        prepaidMethod: 'instapay',
        codExpectedAmount: '0.00',
        codDueAmount: '0.00',
      });
    });

    it('refuses a partial prepayment, a Shopify store, an unknown SKU, and a non manual channel', async () => {
      const partial = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ paymentMethod: 'wallet', prepaidAmount: '300.00' }),
      );
      const shopify = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ storeId: shopifyStore }),
      );
      const unknown = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ lines: [{ variantId: randomUUID(), quantity: 1, unitPrice: '10.00' }] }),
      );
      const channel = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ channelId: shopifyChannel }),
      );

      expect(partial.status).toBe(422);
      expect(partial.body).toMatchObject({ code: 'PARTIAL_PREPAYMENT_NOT_SUPPORTED' });
      expect(shopify.body).toMatchObject({ code: 'STORE_NOT_INTERNAL' });
      expect(unknown.body).toMatchObject({ code: 'VARIANT_UNKNOWN' });
      expect(channel.body).toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    });

    it('refuses a bad body with 422 INVALID_BODY and never echoes the address', async () => {
      const reply = await api.call(support, 'POST', '/api/orders', body({ lines: [] }));

      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ code: 'INVALID_BODY' });
      expect(JSON.stringify(reply.body)).not.toContain('Sentinel');
    });

    it('keeps an unparseable phone as typed, links no customer, and raises phone_unparseable', async () => {
      attentions.length = 0;
      const made = await create({
        shipTo: { name: 'Sentinel Name', phone: '01x 2345', address: '12 Sentinel Street' },
      });
      const order = await detail(made.id);

      expect(order.customer).toBeNull();
      expect(order.shipTo).toMatchObject({ phone: null, contactPhoneRaw: '01x 2345' });
      expect(attentions).toEqual([
        expect.objectContaining({ orderId: made.id, kind: 'phone_unparseable' }),
      ]);
    });

    it('stores a second phone and finds the order by it', async () => {
      const second = '01227654321';
      const made = await create({
        shipTo: { name: 'Sentinel Name', phone: phone(), phoneAlt: second, address: 'x' },
      });
      const reply = await api.call(support, 'POST', '/api/orders/search', { q: second });

      expect(OrderListResponse.parse(reply.body).items.map((i) => i.id)).toContain(made.id);
    });
  });

  describe('a gifted order (AC-2)', () => {
    const gift = (over: Record<string, unknown> = {}) => ({
      ...body(),
      giftReasonCode: 'influencer',
      lines: [{ variantId: skuM, quantity: 1, unitPrice: '500.00', discountAmount: '500.00' }],
      shippingChargedAmount: '0.00',
      ...over,
    });
    const withoutPayment = (b: Record<string, unknown>) => {
      const { paymentMethod: _p, ...rest } = b;
      return rest;
    };

    it('is refused to support and made by a manager with nothing to collect', async () => {
      const refused = await api.call(support, 'POST', '/api/orders/gifted', withoutPayment(gift()));
      const made = await api.call(manager, 'POST', '/api/orders/gifted', withoutPayment(gift()));
      const order = await detail(CreatedOrder.parse(made.body).id);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'FORBIDDEN' });
      expect(made.status).toBe(201);
      expect(order).toMatchObject({
        type: 'gifted',
        giftReasonCode: 'influencer',
        cashState: 'nothing_to_collect',
      });
      expect(order.money).toMatchObject({ totalAmount: '0.00', paymentMethod: 'none' });
      expect(order.lines[0]).toMatchObject({
        unitPrice: '500.00',
        discountAmount: '500.00',
        grossAmount: '0.00',
      });
    });

    it('refuses a gifted line that is priced, or has no retail price, with INVALID_BODY, and shipping with GIFT_MUST_STAY_FREE', async () => {
      const priced = gift({
        lines: [{ variantId: skuM, quantity: 1, unitPrice: '500.00', discountAmount: '100.00' }],
      });
      const overDiscounted = gift({
        lines: [{ variantId: skuM, quantity: 2, unitPrice: '500.00', discountAmount: '500.00' }],
      });
      const noRetail = gift({
        lines: [{ variantId: skuM, quantity: 1, unitPrice: '0.00', discountAmount: '0.00' }],
      });
      const shipping = gift({ shippingChargedAmount: '50.00' });
      const send = (b: Record<string, unknown>) =>
        api.call(manager, 'POST', '/api/orders/gifted', withoutPayment(b));
      const [one, two, three, four] = [
        await send(priced),
        await send(overDiscounted),
        await send(noRetail),
        await send(shipping),
      ];

      for (const reply of [one, two, three]) {
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ code: 'INVALID_BODY' });
      }
      expect(four.body).toMatchObject({ code: 'GIFT_MUST_STAY_FREE' });
    });

    it('needs a goodwill link for replacement_goodwill, and only it takes one', async () => {
      const original = await create();
      const lonely = await api.call(
        manager,
        'POST',
        '/api/orders/gifted',
        withoutPayment(gift({ giftReasonCode: 'replacement_goodwill' })),
      );
      const linked = await api.call(
        manager,
        'POST',
        '/api/orders/gifted',
        withoutPayment(
          gift({
            giftReasonCode: 'replacement_goodwill',
            relatedOrder: { orderId: original.id, relation: 'goodwill_for' },
          }),
        ),
      );
      const wrong = await api.call(
        manager,
        'POST',
        '/api/orders/gifted',
        withoutPayment(gift({ relatedOrder: { orderId: original.id, relation: 'goodwill_for' } })),
      );
      const made = await detail(CreatedOrder.parse(linked.body).id);

      expect(lonely.status).toBe(422);
      expect(wrong.status).toBe(422);
      expect(made.relatedOrder).toMatchObject({ id: original.id, relation: 'goodwill_for' });
      expect((await detail(original.id)).linkedFrom.map((l) => [l.id, l.relation])).toEqual([
        [made.id, 'goodwill_for'],
      ]);
    });
  });

  describe('linked orders (AC-23)', () => {
    it('reopens a cancelled order keeping its campaign and discount code, and shows the link on both pages', async () => {
      const mine = phone();
      const shipTo = { name: 'Sentinel Name', phone: mine, address: 'x' };
      const original = await create({ shipTo });
      await owner(
        `UPDATE orders SET discount_code = 'INFLU10', source_utm_campaign = 'summer',
                source_captured_from = 'landing_page' WHERE id = $1::uuid`,
        [original.id],
      );
      await setState(original.id, 'cancelled');
      const reply = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ shipTo, relatedOrder: { orderId: original.id, relation: 'reopened_from' } }),
      );
      const order = await detail(CreatedOrder.parse(reply.body).id);
      const first = await detail(original.id);

      expect(reply.status).toBe(201);
      expect(order.relatedOrder).toMatchObject({ id: original.id, relation: 'reopened_from' });
      expect(order.linkedFrom).toEqual([]);
      expect(first.linkedFrom).toEqual([
        {
          id: order.id,
          storeCode: 'MAIN',
          orderNumber: order.orderNumber,
          relation: 'reopened_from',
        },
      ]);
      const audited = await owner<{ after: { copiedFromRelated: { discountCode: string } } }>(
        `SELECT after FROM audit_entries WHERE record_id = $1::uuid`,
        [order.id],
      );
      expect(audited.rows[0]?.after.copiedFromRelated.discountCode).toBe('INFLU10');
      expect(order.source).toMatchObject({
        discountCode: 'INFLU10',
        utmCampaign: 'summer',
        capturedFrom: 'landing_page',
      });
    });

    it('makes a replacement of a refused order an exchange_replacement with its original', async () => {
      const original = await create();
      await setState(original.id, 'refused');
      const reply = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ relatedOrder: { orderId: original.id, relation: 'replacement_for' } }),
      );
      const order = await detail(CreatedOrder.parse(reply.body).id);
      const stored = await owner(
        `SELECT original_order_id, exchange_id FROM orders WHERE id = $1::uuid`,
        [order.id],
      );

      expect(order.type).toBe('exchange_replacement');
      expect(order.relatedOrder).toMatchObject({ id: original.id, relation: 'replacement_for' });
      expect((await detail(original.id)).linkedFrom).toEqual([
        {
          id: order.id,
          storeCode: 'MAIN',
          orderNumber: order.orderNumber,
          relation: 'replacement_for',
        },
      ]);
      expect(stored.rows[0]).toEqual({ original_order_id: original.id, exchange_id: null });
    });

    it('refuses a reopened delivered order and an unknown original', async () => {
      const delivered = await create();
      await setState(delivered.id, 'delivered');
      const state = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ relatedOrder: { orderId: delivered.id, relation: 'reopened_from' } }),
      );
      const unknown = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ relatedOrder: { orderId: randomUUID(), relation: 'reopened_from' } }),
      );
      const open = await create();
      const openState = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ relatedOrder: { orderId: open.id, relation: 'replacement_for' } }),
      );

      expect(state.body).toMatchObject({ code: 'RELATED_ORDER_STATE' });
      expect(unknown.body).toMatchObject({ code: 'RELATED_ORDER_UNKNOWN' });
      expect(openState.body).toMatchObject({ code: 'RELATED_ORDER_STATE' });
    });
  });

  describe('rules against abuse (security S1 to S3)', () => {
    const fullyDiscounted = () => ({
      lines: [
        { variantId: skuM, quantity: 1, unitPrice: '570.00', discountAmount: '570.00' },
        { variantId: skuL, quantity: 1, unitPrice: '400.00' },
      ],
    });

    it('refuses a sale line with nothing to pay unless the person may gift, and audits the lines', async () => {
      const zeroPrice = {
        lines: [
          { variantId: skuM, quantity: 1, unitPrice: '0.00' },
          { variantId: skuL, quantity: 1, unitPrice: '400.00' },
        ],
      };
      const refused = await api.call(support, 'POST', '/api/orders', body(fullyDiscounted()));
      const refusedZero = await api.call(support, 'POST', '/api/orders', body(zeroPrice));
      const allowed = await api.call(manager, 'POST', '/api/orders', body(fullyDiscounted()));
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
      const made = CreatedOrder.parse(allowed.body);
      const audited = await owner<{ after: { lines: Record<string, unknown>[] } }>(
        `SELECT after FROM audit_entries WHERE record_id = $1::uuid`,
        [made.id],
      );

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'LINE_FULLY_DISCOUNTED' });
      expect(refusedZero.body).toMatchObject({ code: 'LINE_FULLY_DISCOUNTED' });
      expect(allowed.status).toBe(201);
      expect(audited.rows[0]?.after.lines[0]).toEqual({
        variantId: skuM,
        quantity: 1,
        unitPrice: '570.00',
        discountAmount: '570.00',
      });
    });

    it('lets only the customer of an order reopen it, and only once while the reopened order is open', async () => {
      const shipTo = { name: 'Sentinel Name', phone: phone(), address: 'x' };
      const original = await create({ shipTo });
      await setState(original.id, 'cancelled');
      const link = { orderId: original.id, relation: 'reopened_from' };
      const stranger = await api.call(support, 'POST', '/api/orders', body({ relatedOrder: link }));
      const unlinked = await api.call(
        support,
        'POST',
        '/api/orders',
        body({
          shipTo: { name: 'Sentinel Name', phone: '01x 2345', address: 'x' },
          relatedOrder: link,
        }),
      );
      const first = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ shipTo, relatedOrder: link }),
      );
      const second = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ shipTo, relatedOrder: link }),
      );
      await setState(CreatedOrder.parse(first.body).id, 'cancelled');
      const third = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ shipTo, relatedOrder: link }),
      );

      expect(stranger.status).toBe(422);
      expect(stranger.body).toMatchObject({ code: 'RELATED_ORDER_OTHER_CUSTOMER' });
      expect(unlinked.body).toMatchObject({ code: 'RELATED_ORDER_OTHER_CUSTOMER' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'ALREADY_REOPENED' });
      expect(third.status).toBe(201);
    });

    it('lets two parallel reopens of one order make exactly one', async () => {
      const shipTo = { name: 'Sentinel Name', phone: phone(), address: 'x' };
      const original = await create({ shipTo });
      await setState(original.id, 'cancelled');
      const link = { orderId: original.id, relation: 'reopened_from' };
      const replies = await Promise.all(
        Array.from({ length: 4 }, () =>
          api.call(support, 'POST', '/api/orders', body({ shipTo, relatedOrder: link })),
        ),
      );

      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 409)).toHaveLength(3);
    });

    it('refuses an amount that cannot fit the money columns with 422 INVALID_BODY', async () => {
      const huge = await api.call(
        support,
        'POST',
        '/api/orders',
        body({ lines: [{ variantId: skuM, quantity: 10000, unitPrice: '999999999.00' }] }),
      );
      const sum = await api.call(
        support,
        'POST',
        '/api/orders',
        body({
          lines: [
            { variantId: skuM, quantity: 1, unitPrice: '999999999999.00' },
            { variantId: skuL, quantity: 1, unitPrice: '999999999999.00' },
          ],
        }),
      );

      expect(huge.status).toBe(422);
      expect(huge.body).toMatchObject({ code: 'INVALID_BODY' });
      expect(sum.status).toBe(422);
      expect(sum.body).toMatchObject({ code: 'INVALID_BODY' });
    });

    it('prices a manual order at the sales_tax_rate setting', async () => {
      await owner(`INSERT INTO settings (key, value) VALUES ('sales_tax_rate', '"10.00"')`);
      try {
        const made = await create();
        const rates = await owner<{ tax_rate: string }>(
          `SELECT tax_rate FROM order_lines WHERE order_id = $1::uuid`,
          [made.id],
        );
        expect(rates.rows.map((r) => r.tax_rate)).toEqual(['10.00', '10.00']);
      } finally {
        await owner(`DELETE FROM settings WHERE key = 'sales_tax_rate'`);
      }
    });
  });

  describe('the store beside every number (AC-3)', () => {
    it('lets two stores hold #1001, finds both by 1001, and refuses a second in one store', async () => {
      const a = await create();
      const b = await create({ storeId: otherStore });
      await owner(`UPDATE orders SET order_number = '#1001' WHERE id = ANY($1::uuid[])`, [
        [a.id, b.id],
      ]);
      const found = OrderListResponse.parse(
        (await api.call(support, 'GET', '/api/orders?q=1001')).body,
      );

      expect(found.items.map((i) => `${i.storeCode}/${i.orderNumber}`).sort()).toEqual([
        'MAIN/#1001',
        'OTH/#1001',
      ]);

      const writer = api.app.get(OrderWriter);
      const transactions = api.app.get(OrderTransactions);
      const queries = api.app.get(OrderQueries);
      const row = await queries.detail(a.id);
      const attempt = transactions.run(async (tx) => {
        return writer.insertOrder(
          tx,
          {
            storeId: row.storeId,
            channelId: row.channelId,
            orderNumber: '#1001',
            channelOrderRef: randomUUID(),
            type: 'sale',
            originalOrderId: null,
            relatedOrderId: null,
            relatedOrderRelation: null,
            customerId: null,
            placedAt: new Date(),
            fulfillmentState: 'new',
            cashState: 'unpaid',
            outcome: 'open',
            linesGrossAmount: '0.00',
            shippingChargedAmount: '0.00',
            shippingTaxAmount: '0.00',
            totalAmount: '0.00',
            prepaidAmount: '0.00',
            creditAppliedAmount: '0.00',
            shippingPrepaidAmount: '0.00',
            shippingCreditAppliedAmount: '0.00',
            codExpectedAmount: '0.00',
            codDueAmount: '0.00',
            deliveredAmount: '0.00',
            paymentMethod: 'cod',
            prepaidMethod: null,
            source: {
              capturedFrom: 'manual',
              campaignId: null,
              adsetId: null,
              adId: null,
              utmSource: null,
              utmMedium: null,
              utmCampaign: null,
              utmContent: null,
              landingPage: null,
              referrer: null,
              mediaBuyerId: null,
              influencerCode: null,
            },
            discountCode: null,
            giftReasonCode: null,
            customerNote: null,
            shipToName: null,
            shipToPhone: null,
            shipToPhoneAlt: null,
            contactPhoneRaw: null,
            shipToAddress: null,
            shipToAreaList: null,
            shipToGovernorateCode: null,
            shipToCityCode: null,
            shipToZoneCode: null,
            courierNote: null,
          },
          [],
        );
      });

      await expect(attempt).rejects.toBeInstanceOf(OrderNumberTaken);
    });
  });

  describe('the order list and search (AC-4, AC-19)', () => {
    it('pages newest first with no gap or repeat while a new order arrives', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push((await create({ storeId: otherStore })).id);
      const first = OrderListResponse.parse(
        (await api.call(support, 'GET', `/api/orders?storeId=${otherStore}&limit=2`)).body,
      );
      await create({ storeId: otherStore });
      const second = OrderListResponse.parse(
        (
          await api.call(
            support,
            'GET',
            `/api/orders?storeId=${otherStore}&limit=2&cursor=${first.nextCursor}`,
          )
        ).body,
      );
      const third = OrderListResponse.parse(
        (
          await api.call(
            support,
            'GET',
            `/api/orders?storeId=${otherStore}&limit=50&cursor=${second.nextCursor}`,
          )
        ).body,
      );
      const seen = [...first.items, ...second.items, ...third.items].map((i) => i.id);

      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of ids) expect(seen).toContain(id);
      expect(third.nextCursor).toBeNull();
    });

    it('filters by state, outcome, type, hold, short, and operating day', async () => {
      const held = await create({ storeId: otherStore });
      const short = await create({ storeId: otherStore });
      const cancelled = await create({ storeId: otherStore });
      await owner(`UPDATE orders SET write_back_state = 'waiting' WHERE id = $1::uuid`, [held.id]);
      await owner(
        `UPDATE order_lines SET short_quantity = 1 WHERE order_id = $1::uuid AND position = 1`,
        [short.id],
      );
      await setState(cancelled.id, 'cancelled');
      const list = async (query: string) =>
        OrderListResponse.parse(
          (await api.call(support, 'GET', `/api/orders?storeId=${otherStore}&limit=100&${query}`))
            .body,
        ).items;

      expect((await list('hold=true')).map((i) => i.id)).toEqual([held.id]);
      expect((await list('hold=true'))[0]?.hold).toBe(true);
      expect((await list('short=true')).map((i) => i.id)).toEqual([short.id]);
      expect((await list('fulfillment=cancelled')).map((i) => i.id)).toEqual([cancelled.id]);
      expect(
        (await list('fulfillment=cancelled&fulfillment=refused&cash=unpaid')).map((i) => i.id),
      ).toEqual([cancelled.id]);
      expect(await list('type=gifted')).toHaveLength(0);
      expect((await list('outcome=cancelled_before_shipping')).map((i) => i.id)).toEqual([
        cancelled.id,
      ]);
      expect(await list('dayFrom=2999-01-01')).toHaveLength(0);
      expect((await list('dayTo=2999-01-01')).length).toBeGreaterThan(0);
    });

    it('refuses a phone in the URL without echoing it, and finds it by POST', async () => {
      const number = phone();
      const made = await create({ shipTo: { name: 'Sentinel Name', phone: number, address: 'x' } });
      const get = await api.call(support, 'GET', `/api/orders?q=${number}`);
      const post = await api.call(support, 'POST', '/api/orders/search', { q: number });

      expect(get.status).toBe(400);
      expect(get.body).toMatchObject({ code: 'PHONE_IN_URL' });
      expect(JSON.stringify(get.body)).not.toContain(number);
      expect(OrderListResponse.parse(post.body).items.map((i) => i.id)).toEqual([made.id]);
    });

    it('finds an order by any other phone of its customer', async () => {
      const made = await create();
      const customer = (
        await owner<{ customer_id: string }>(`SELECT customer_id FROM orders WHERE id = $1::uuid`, [
          made.id,
        ])
      ).rows[0]?.customer_id;
      await owner(
        `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary) VALUES ($1::uuid, '+201229998877', 'mobile', false)`,
        [customer],
      );
      const post = await api.call(support, 'POST', '/api/orders/search', { q: '01229998877' });
      const byCustomer = await api.call(support, 'GET', `/api/orders?customerId=${customer}`);

      expect(OrderListResponse.parse(post.body).items.map((i) => i.id)).toContain(made.id);
      expect(OrderListResponse.parse(byCustomer.body).items.map((i) => i.id)).toContain(made.id);
    });

    it('shows the small flags and the store, channel, and ship to name of a row', async () => {
      const shipTo = { name: 'Sentinel Name', phone: phone(), address: 'x' };
      const original = await create({ shipTo });
      await setState(original.id, 'cancelled');
      const reopened = await create({
        shipTo,
        relatedOrder: { orderId: original.id, relation: 'reopened_from' },
        channelId: whatsappChannel,
      });
      const bad = await create({ shipTo: { name: 'Sentinel Name', phone: '12 34', address: 'x' } });
      const rows = OrderListResponse.parse(
        (await api.call(support, 'GET', '/api/orders?limit=100')).body,
      ).items;
      const rowOf = (id: string) => rows.find((r) => r.id === id);

      expect(rowOf(reopened.id)).toMatchObject({
        reopened: true,
        storeCode: 'MAIN',
        shipToName: 'Sentinel Name',
      });
      expect(rowOf(reopened.id)?.channelName).toEqual({ en: 'WhatsApp' });
      expect(rowOf(bad.id)?.phoneNeedsFix).toBe(true);
      expect(rowOf(original.id)?.reopened).toBe(false);
    });

    it('refuses a forged cursor with 400 INVALID_CURSOR and a bad filter with 400 INVALID_QUERY', async () => {
      const cursor = await api.call(
        support,
        'GET',
        `/api/orders?cursor=${Buffer.from('["x","y"]').toString('base64url')}`,
      );
      const query = await api.call(support, 'GET', '/api/orders?fulfillment=nope');

      expect(cursor.status).toBe(400);
      expect(cursor.body).toMatchObject({ code: 'INVALID_CURSOR' });
      expect(query.status).toBe(400);
      expect(query.body).toMatchObject({ code: 'INVALID_QUERY' });
    });
  });

  describe('the order page and the options (AC-5, AC-19)', () => {
    it('answers 404 ORDER_NOT_FOUND for an unknown or malformed id', async () => {
      const unknown = await api.call(support, 'GET', `/api/orders/${randomUUID()}`);
      const malformed = await api.call(support, 'GET', '/api/orders/not-an-id');

      expect([unknown.status, malformed.status]).toEqual([404, 404]);
      expect(malformed.body).toMatchObject({ code: 'ORDER_NOT_FOUND' });
    });

    it('shows unitCost only to a viewer holding cost.view', async () => {
      const made = await create();
      await owner(`UPDATE order_lines SET unit_cost = 123.4567 WHERE order_id = $1::uuid`, [
        made.id,
      ]);
      const plain = await api.call(manager, 'GET', `/api/orders/${made.id}`);
      const costed = await api.call(managerCost, 'GET', `/api/orders/${made.id}`);

      expect(JSON.stringify(plain.body)).not.toContain('unitCost');
      expect(OrderDetail.parse(costed.body).lines[0]?.unitCost).toBe('123.4567');
    });

    it('gives each line its stored title and the catalog name in both languages', async () => {
      const made = await create({
        lines: [
          { variantId: skuBilingual, quantity: 1, unitPrice: '300.00' },
          { variantId: skuM, quantity: 1, unitPrice: '570.00' },
        ],
      });
      const order = await detail(made.id);

      expect(order.lines[0]?.name).toEqual({ en: 'Linen shirt', ar: 'قميص كتان' });
      expect(order.lines[0]?.title).toBe('Linen shirt');
      expect(order.lines[1]?.name).toEqual({ en: 'Tee TEE-M' });
    });

    it('names the actor of each event', async () => {
      const made = await create();
      const order = await detail(made.id);

      expect(
        order.events.every(
          (e) => e.actorType === 'person' && e.actorName?.startsWith('Planted Person'),
        ),
      ).toBe(true);
    });

    it('offers internal stores, manual channels, gift reasons, and the tax settings to orders.confirm', async () => {
      const reply = await api.call(support, 'GET', '/api/orders/options');
      const options = OrderOptions.parse(reply.body);

      expect(options.stores.map((s) => s.code)).toEqual(expect.arrayContaining(['MAIN', 'OTH']));
      expect(options.stores.map((s) => s.code)).not.toContain('ESS');
      expect(options.channels.map((c) => c.kind).sort()).toEqual(['manual', 'whatsapp']);
      expect(options.salesTaxRate).toBe('14.00');
      expect(options.pricesIncludeVat).toBe(true);
      expect(options.giftReasonCodes).toContain('replacement_goodwill');
    });

    it('offers every store and channel, Shopify ones included, to any orders.view holder', async () => {
      const reply = await api.call(warehouse, 'GET', '/api/orders/filter-options');
      const options = OrderFilterOptions.parse(reply.body);

      expect(reply.status).toBe(200);
      expect(options.stores.map((s) => s.code)).toEqual(
        expect.arrayContaining(['MAIN', 'OTH', 'ESS']),
      );
      expect(options.channels.map((c) => c.kind)).toEqual(
        expect.arrayContaining(['manual', 'whatsapp', 'shopify']),
      );
      expect((await api.call(undefined, 'GET', '/api/orders/filter-options')).status).toBe(401);
    });

    it('answers 403 FORBIDDEN where the permission is missing', async () => {
      const made = await create();
      const calls = [
        api.call(warehouse, 'POST', '/api/orders', body()),
        api.call(warehouse, 'GET', '/api/orders/options'),
        api.call(undefined, 'GET', '/api/orders'),
      ];
      const [create_, options, anonymous] = await Promise.all(calls);

      expect(create_?.status).toBe(403);
      expect(options?.status).toBe(403);
      expect(anonymous?.status).toBe(401);
      expect((await api.call(warehouse, 'GET', `/api/orders/${made.id}`)).status).toBe(200);
    });
  });

  describe('reads for other modules (AC-21)', () => {
    it('summarizes orders without a ship to field', async () => {
      const made = await create();
      const summaries = await api.app.get(OrderQueries).summaryOf([made.id, randomUUID()]);

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        id: made.id,
        storeCode: 'MAIN',
        fulfillmentState: 'new',
        cashState: 'unpaid',
        totalAmount: '1590.00',
      });
      expect(JSON.stringify(summaries)).not.toContain('Sentinel');
    });

    it('pages the orders of two customer ids with no gap or repeat, and counts them', async () => {
      const a = await create();
      const b = await create();
      const c = await create();
      const ids = (
        await owner<{ id: string; customer_id: string }>(
          `SELECT id, customer_id FROM orders WHERE id = ANY($1::uuid[])`,
          [[a.id, b.id, c.id]],
        )
      ).rows;
      const customerOf = (id: string): string => ids.find((r) => r.id === id)?.customer_id ?? '';
      await owner(`UPDATE orders SET customer_id = $1::uuid WHERE id = $2::uuid`, [
        customerOf(a.id),
        c.id,
      ]);
      await setState(b.id, 'refused');
      const queries = api.app.get(OrderQueries);
      const customerIds = [customerOf(a.id), customerOf(b.id)];
      const page1 = await queries.forCustomers(customerIds, { limit: 2 });
      const page2 = await queries.forCustomers(customerIds, { limit: 2, cursor: page1.nextCursor });
      const seen = [...page1.items, ...page2.items].map((i) => i.id);
      const counts = await queries.countsForCustomers(customerIds, { sinceDay: null });
      const none = await queries.countsForCustomers([], { sinceDay: null });

      expect(seen.sort()).toEqual([a.id, b.id, c.id].sort());
      expect(page2.nextCursor).toBeNull();
      expect(counts.orders).toBe(3);
      expect(none).toEqual({ orders: 0, refused: 0, returned: 0 });
    });

    it('counts refusals by their event day and returns by the placed day, leaving gifts out', async () => {
      const mine = phone();
      const shipTo = { name: 'Sentinel Name', phone: mine, address: 'x' };
      const refuse = async (id: string, occurredAt: string) => {
        await setState(id, 'refused');
        await owner(
          `INSERT INTO order_events (order_id, machine, from_state, to_state, actor_type, occurred_at)
           VALUES ($1::uuid, 'fulfillment', 'new', 'refused', 'system_job', $2::timestamptz)`,
          [id, occurredAt],
        );
      };
      const plain = await create({ shipTo });
      const refused = await create({ shipTo });
      const returned = await create({ shipTo });
      const old = await create({ shipTo });
      const { paymentMethod: _method, ...giftBase } = body({ shipTo });
      const giftReply = await api.call(manager, 'POST', '/api/orders/gifted', {
        ...giftBase,
        giftReasonCode: 'influencer',
        lines: [{ variantId: skuM, quantity: 1, unitPrice: '500.00', discountAmount: '500.00' }],
        shippingChargedAmount: '0.00',
      });
      const gifted = CreatedOrder.parse(giftReply.body);
      const today = new Date().toISOString();
      await refuse(refused.id, today);
      await refuse(gifted.id, today);
      await owner(
        `UPDATE order_lines SET line_state = 'returned' WHERE order_id = $1::uuid AND position = 1`,
        [returned.id],
      );
      await owner(`UPDATE orders SET placed_at = '2025-01-01T10:00:00Z' WHERE id = $1::uuid`, [
        old.id,
      ]);
      await refuse(old.id, '2025-01-01T12:00:00Z');
      const customer = (
        await owner<{ customer_id: string }>(`SELECT customer_id FROM orders WHERE id = $1::uuid`, [
          plain.id,
        ])
      ).rows[0]?.customer_id as string;
      const day = (
        await owner<{ day: string }>(
          `SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM orders WHERE id = $1::uuid`,
          [refused.id],
        )
      ).rows[0]?.day as string;
      const queries = api.app.get(OrderQueries);

      expect(await queries.countsForCustomers([customer], { sinceDay: null })).toEqual({
        orders: 5,
        refused: 2,
        returned: 1,
      });
      expect(await queries.countsForCustomers([customer], { sinceDay: day })).toEqual({
        orders: 5,
        refused: 1,
        returned: 1,
      });
      expect(await queries.countsForCustomers([customer], { sinceDay: '2999-01-01' })).toEqual({
        orders: 5,
        refused: 0,
        returned: 0,
      });
    });

    it('answers what the write back executor needs', async () => {
      const made = await create();
      const db = api.app.get<DatabaseConnection>(DATABASE);
      const view = await api.app.get(OrderQueries).writeBackViewOf(db.db, made.id);

      expect(view).toMatchObject({
        orderId: made.id,
        storeCode: 'MAIN',
      });
      expect(typeof view.channelOrderRef).toBe('string');
      expect(view.lines).toHaveLength(2);
      expect(view.shippingChargedAmount).toBe('50.00');
      expect(view.shipTo.name).toBe('Sentinel Name');
    });
  });

  describe('transactions and events (AC-18, AC-22)', () => {
    it('reruns the whole unit once after a deadlock and not after another error', async () => {
      const transactions = api.app.get(OrderTransactions);
      let runs = 0;
      const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });

      const value = await transactions.run(() => {
        runs += 1;
        return runs === 1 ? Promise.reject(deadlock) : Promise.resolve('done');
      });
      let other = 0;
      await expect(
        transactions.run(() => {
          other += 1;
          return Promise.reject(new Error('plain failure'));
        }),
      ).rejects.toThrow('plain failure');

      expect([value, runs, other]).toEqual(['done', 2, 1]);
    });

    it('rolls the order, events, number, and audit entry back when an OrderStateChanged handler throws', async () => {
      const count = async () =>
        (
          await owner<Record<string, string>>(
            `SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_events) AS events,
                    (SELECT count(*) FROM audit_entries WHERE action = 'order.created_manually') AS audit,
                    (SELECT coalesce(max(last_value), 0) FROM document_counters WHERE doc_type = 'SO') AS counter`,
          )
        ).rows[0];
      const before = await count();
      failStateEvents = true;
      const reply = await api.call(support, 'POST', '/api/orders', body());
      failStateEvents = false;

      expect(reply.status).toBe(500);
      expect(await count()).toEqual(before);
    });

    it('publishes one OrderStateChanged per event row, with ids and codes only', async () => {
      stateEvents.length = 0;
      const made = await create();
      const mine = stateEvents.filter((e) => e.orderId === made.id);

      expect(mine.map((e) => [e.machine, e.from, e.to])).toEqual([
        ['fulfillment', null, 'new'],
        ['cash', null, 'unpaid'],
      ]);
      expect(JSON.stringify(mine)).not.toContain('Sentinel');
    });
  });

  it('reads the intake service from the module so other features can call it', () => {
    expect(api.app.get(OrderIntake)).toBeInstanceOf(OrderIntake);
  });
});
