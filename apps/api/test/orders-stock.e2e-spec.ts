import { randomUUID } from 'node:crypto';
import {
  CreateManualOrderBody,
  CreatedOrder,
  HoldOpenOrdersResult,
  OnlineGateView,
  OrderDetail,
  OrderListResponse,
  SkuDetail,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { OrderIntake } from '../src/orders/intake/order-intake.service.js';
import { OrderTransactions } from '../src/orders/order-transactions.js';
import { OrderAttentionRaised } from '../src/orders/orders.events.js';
import { OPEN_ORDERS_HELD_CHECK } from '../src/orders/stock/order-stock.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { makeOnline, plantWarehouse, putOnShelf } from './order-stock.js';

// Spec 0013 milestone 4, task 13 (AC-4, AC-5, AC-7, AC-13, AC-22, AC-26): reservations at
// creation, short lines and their flag, LINE_SHORT, the ledger's fill and shorten events, edits and
// cancels releasing stock, confirm topping up, the online gate check with hold-open-orders, and the
// forced deadlock rerun, through the real routes and services as the application role.
describe('orders, milestone 4: stock holds and short lines', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let manager = '';
  let support = '';
  let warehouse = '';
  let supportId = '';
  let mainStore = '';
  let manualChannel = '';
  let online = '';
  let n = 0;
  const attentions: OrderAttentionRaised[] = [];

  const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => api.owner.pool.query<T>(text, params);

  const phone = () => {
    n += 1;
    return `0102${String(1_000_000 + n)}`;
  };

  const sku = async () => {
    const code = `ST-${randomUUID().slice(0, 8)}`;
    const reply = await api.call(manager, 'POST', '/api/products', {
      name: { en: `Tee ${code}` },
      variants: [{ sku: code, price: '500.00' }],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return SkuDetail.parse(reply.body).id;
  };

  const body = (lines: { variantId: string; quantity: number }[]) => ({
    clientRef: randomUUID(),
    storeId: mainStore,
    channelId: manualChannel,
    shipTo: { name: 'Stock Tester', phone: phone(), address: '1 Shelf Street' },
    lines: lines.map((line) => ({ ...line, unitPrice: '500.00' })),
    shippingChargedAmount: '50.00',
    paymentMethod: 'cod',
  });

  const create = async (lines: { variantId: string; quantity: number }[]) => {
    const reply = await api.call(support, 'POST', '/api/orders', body(lines));
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return CreatedOrder.parse(reply.body).id;
  };

  const detail = async (id: string) => {
    const reply = await api.call(support, 'GET', `/api/orders/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OrderDetail.parse(reply.body);
  };

  const shorts = async (id: string) =>
    (await detail(id)).lines.filter((l) => l.lineState === 'open').map((l) => l.shortQuantity);

  const move = async (
    id: string,
    what: 'edits' | 'confirm' | 'cancel' | 'pack',
    extra: Record<string, unknown> = {},
    cookie = support,
  ) => {
    const { updatedAt } = await detail(id);
    return api.call(cookie, 'POST', `/api/orders/${id}/${what}`, {
      expectedUpdatedAt: updatedAt,
      ...extra,
    });
  };

  /** Each line's reservation as the ledger reads it. */
  const reservations = (orderId: string) =>
    api.app.get(LedgerService).reservationsFor({ sourceType: 'order', sourceId: orderId });

  const held = async (orderId: string) =>
    Object.fromEntries(
      (await reservations(orderId))
        .filter((row) => row.status === 'active')
        .map((row) => [row.sourceLineId, row.openQuantity]),
    );

  const gateCheck = async (locationId: string) => {
    const reply = await api.call(manager, 'GET', `/api/locations/${locationId}/online-gate`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OnlineGateView.parse(reply.body).checks.find((c) => c.key === OPEN_ORDERS_HELD_CHECK);
  };

  const holdOpenOrders = (locationId: string, cookie = manager) =>
    api.call(cookie, 'POST', '/api/orders/hold-open-orders', { locationId });

  const noOnlineLocation = () =>
    owner('UPDATE locations SET sellable_online = false WHERE sellable_online');

  beforeAll(async () => {
    api = await startInProcessApi();
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    const supportPerson = await api.addPerson(['support']);
    supportId = supportPerson.id;
    support = await api.signIn(supportPerson.email);
    warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    api.app
      .get(DomainEvents)
      .on(OrderAttentionRaised, (_tx, event) => void attentions.push(event), 'orders-stock-e2e');
    await noOnlineLocation();
    online = await plantWarehouse(api);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('going online with open orders held (AC-26)', () => {
    it('fails the gate with the unheld line count, holds them, passes, and holds nothing twice', async () => {
      const [a, b] = [await sku(), await sku()];
      await putOnShelf(api, online, [a, b], 10);
      // Two open orders taken before any location fed online stock: nothing held, all short.
      const first = await create([
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 2 },
      ]);
      const second = await create([{ variantId: a, quantity: 1 }]);
      expect(await held(first)).toEqual({});
      expect(await shorts(first)).toEqual([1, 2]);

      expect(await gateCheck(online)).toMatchObject({
        passed: false,
        count: 3,
        label: 'orders.onlineGate.openOrdersHeld',
        action: { method: 'POST', path: '/api/orders/hold-open-orders' },
      });
      expect((await holdOpenOrders(online, support)).status).toBe(403);

      const reply = await holdOpenOrders(online);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(HoldOpenOrdersResult.parse(reply.body)).toEqual({
        linesHeld: 3,
        linesShort: 0,
        linesLeft: 0,
      });
      expect(await gateCheck(online)).toMatchObject({ passed: true, count: 0 });
      expect(Object.values(await held(first)).sort()).toEqual([1, 2]);
      expect(Object.values(await held(second))).toEqual([1]);
      expect(await shorts(first)).toEqual([0, 0]);

      const again = await holdOpenOrders(online);
      expect(HoldOpenOrdersResult.parse(again.body)).toEqual({
        linesHeld: 0,
        linesShort: 0,
        linesLeft: 0,
      });
      expect((await reservations(first)).length).toBe(2);
    });

    it('answers 404 LOCATION_NOT_FOUND for an unknown location and 422 for a bad body', async () => {
      const unknown = await holdOpenOrders(randomUUID());
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'LOCATION_NOT_FOUND' });
      const bad = await api.call(manager, 'POST', '/api/orders/hold-open-orders', {});
      expect(bad.status).toBe(422);
      expect(bad.body).toMatchObject({ code: 'INVALID_BODY' });
    });

    it('becomes the online location for the rest of the suite', async () => {
      await makeOnline(api, online);
      expect(await gateCheck(online)).toMatchObject({ passed: true });
    });
  });

  describe('reservations and short lines (AC-13, AC-7, AC-5, AC-4)', () => {
    it('reserves every line at the online location when the order is created', async () => {
      const x = await sku();
      await putOnShelf(api, online, [x], 5);
      const id = await create([{ variantId: x, quantity: 2 }]);

      const [line] = (await detail(id)).lines;
      expect(await held(id)).toEqual({ [line?.id as string]: 2 });
      expect(line?.shortQuantity).toBe(0);
      expect((await reservations(id))[0]).toMatchObject({
        locationId: online,
        unfilledQuantity: 0,
      });
    });

    it('marks the second order for the last M short, flags and filters it, refuses its pack, and clears it on a restock', async () => {
      const m = await sku();
      await putOnShelf(api, online, [m], 1);
      const holder = await create([{ variantId: m, quantity: 1 }]);
      const waiting = await create([{ variantId: m, quantity: 1 }]);

      expect(await shorts(holder)).toEqual([0]);
      expect(await shorts(waiting)).toEqual([1]);
      const page = OrderListResponse.parse(
        (await api.call(support, 'GET', '/api/orders?short=true&limit=100')).body,
      );
      expect(page.items.map((i) => i.id)).toContain(waiting);
      expect(page.items.map((i) => i.id)).not.toContain(holder);
      expect(page.items.find((i) => i.id === waiting)?.short).toBe(true);

      expect((await move(waiting, 'confirm')).status).toBe(200);
      const refused = await move(waiting, 'pack', {}, warehouse);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'LINE_SHORT' });
      expect((await detail(waiting)).fulfillmentState).toBe('confirmed');

      // A restock fills the waiting demand in its own transaction (ReservationFilled).
      await putOnShelf(api, online, [m], 1);
      expect(await shorts(waiting)).toEqual([0]);
      expect(Object.values(await held(waiting))).toEqual([1]);
      const packed = await move(waiting, 'pack', {}, warehouse);
      expect(packed.status, JSON.stringify(packed.body)).toBe(200);
      expect(OrderDetail.parse(packed.body).fulfillmentState).toBe('packed');
    });

    it('raises short_quantity and reservation_shortened when a carrier shipment takes a held piece', async () => {
      const s = await sku();
      await putOnShelf(api, online, [s], 1);
      const id = await create([{ variantId: s, quantity: 1 }]);
      expect(await shorts(id)).toEqual([0]);

      await api.app.get(LedgerService).postCarrierShipment({
        orderId: randomUUID(),
        lines: [{ sourceLineId: randomUUID(), variantId: s, locationId: online, quantity: 1 }],
      });

      expect(await shorts(id)).toEqual([1]);
      const raised = attentions.filter((a) => a.orderId === id);
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({
        kind: 'reservation_shortened',
        sourceType: 'carrier_shipment',
      });
      expect(raised[0]?.sourceId).toBe((await reservations(id))[0]?.reservationId);
    });

    it('releases the old line and reserves the new one when an edit replaces a size', async () => {
      const [m, l] = [await sku(), await sku()];
      await putOnShelf(api, online, [m, l], 5);
      const id = await create([{ variantId: m, quantity: 1 }]);
      const lineM = (await detail(id)).lines[0]?.id as string;

      const reply = await move(id, 'edits', {
        reasonCode: 'size_change',
        operations: [
          { kind: 'replace_line', lineId: lineM, variantId: l, quantity: 1, unitPrice: '500.00' },
        ],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const lineL = OrderDetail.parse(reply.body).lines.find((x) => x.variantId === l)?.id;

      expect(await held(id)).toEqual({ [lineL as string]: 1 });
      expect((await reservations(id)).find((r) => r.sourceLineId === lineM)?.status).toBe(
        'released',
      );
    });

    it('releases every reservation on a cancel and brings every short quantity to 0', async () => {
      const [a, empty] = [await sku(), await sku()];
      await putOnShelf(api, online, [a], 5);
      const id = await create([
        { variantId: a, quantity: 2 },
        { variantId: empty, quantity: 1 },
      ]);
      expect(await shorts(id)).toEqual([0, 1]);

      const reply = await move(id, 'cancel', { reasonCode: 'customer_cancelled' });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);

      expect(await held(id)).toEqual({});
      expect(OrderDetail.parse(reply.body).lines.map((x) => x.shortQuantity)).toEqual([0, 0]);
    });

    it('tops a line up on confirm when it holds nothing yet', async () => {
      const t = await sku();
      await putOnShelf(api, online, [t], 3);
      await noOnlineLocation();
      const id = await create([{ variantId: t, quantity: 1 }]);
      expect(await shorts(id)).toEqual([1]);
      expect(await reservations(id)).toEqual([]);
      await makeOnline(api, online);

      const reply = await move(id, 'confirm');
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);

      expect(OrderDetail.parse(reply.body).lines.map((x) => x.shortQuantity)).toEqual([0]);
      expect(Object.values(await held(id))).toEqual([1]);
    });
  });

  describe('one way to open the transaction (AC-22)', () => {
    it('reruns the whole unit once after a forced deadlock: one order, one event set, one audit entry, one reservation set', async () => {
      const d = await sku();
      await putOnShelf(api, online, [d], 5);
      const input = CreateManualOrderBody.parse(body([{ variantId: d, quantity: 2 }]));
      const attempts = { count: 0 };

      const made = await api.app.get(OrderTransactions).run(async (tx) => {
        attempts.count += 1;
        const created = await api.app
          .get(OrderIntake)
          .createManual(
            tx,
            input,
            { type: 'person', userId: supportId, hat: 'support' },
            { mayGift: false },
          );
        if (attempts.count === 1) {
          await tx.execute(
            sql.raw(`DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '40P01'; END $$`),
          );
        }
        return created;
      });

      expect(attempts.count).toBe(2);
      const count = async (text: string) =>
        Number((await owner<{ n: string }>(text, [made.id])).rows[0]?.n);
      expect(
        Number(
          (
            await owner<{ n: string }>(
              `SELECT count(*)::text AS n FROM orders WHERE channel_order_ref = $1`,
              [input.clientRef],
            )
          ).rows[0]?.n,
        ),
      ).toBe(1);
      expect(
        await count(`SELECT count(*)::text AS n FROM order_events WHERE order_id = $1::uuid`),
      ).toBe(2);
      expect(
        await count(
          `SELECT count(*)::text AS n FROM audit_entries
           WHERE action = 'order.created_manually' AND record_id = $1::uuid`,
        ),
      ).toBe(1);
      expect(
        await count(`SELECT count(*)::text AS n FROM reservations WHERE source_id = $1::uuid`),
      ).toBe(1);
      expect(Object.values(await held(made.id))).toEqual([2]);
    });
  });
});
