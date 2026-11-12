import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  HoldOpenOrdersResult,
  OnlineGateView,
  OrderDetail,
  OrderListResponse,
  SkuDetail,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { OPEN_ORDERS_HELD_CHECK } from '../src/orders/stock/order-stock.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { makeOnline, plantWarehouse, putOnShelf } from './order-stock.js';

// QA gaps of spec 0013 milestone 4, task 13 (AC-7, AC-13, AC-22, AC-26 and the 2026-11-12
// amendment), beside `orders-stock.e2e-spec.ts`: the gate check counts only open lines of holding
// orders with a stock SKU, hold-open-orders holds oldest first and refuses an archived or never
// online location, a release fills another order's waiting demand, a partial shortage, a pack with
// no online location, a refused pack rolls its top up back, a line held at a candidate is not
// marked short by a confirm, a held line moves to the new location, and a lock wait answers 503
// BUSY. Its own scratch database, so the gate's install wide count is the suite's alone.
describe(
  'orders stock, QA gaps (spec 0013 AC-7, AC-13, AC-22, AC-26)',
  { timeout: 240_000 },
  () => {
    let api: InProcessApi;
    let manager = '';
    let support = '';
    let warehouse = '';
    let mainStore = '';
    let manualChannel = '';
    let n = 0;

    const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) => api.owner.pool.query<T>(text, params);

    const phone = () => {
      n += 1;
      return `0103${String(1_000_000 + n)}`;
    };

    const sku = async () => {
      const code = `QG-${randomUUID().slice(0, 8)}`;
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '500.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };

    const create = async (lines: { variantId: string; quantity: number }[]) => {
      const reply = await api.call(support, 'POST', '/api/orders', {
        clientRef: randomUUID(),
        storeId: mainStore,
        channelId: manualChannel,
        shipTo: { name: 'Gap Tester', phone: phone(), address: '2 Shelf Street' },
        lines: lines.map((line) => ({ ...line, unitPrice: '500.00' })),
        shippingChargedAmount: '50.00',
        paymentMethod: 'cod',
      });
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

    const reservations = (orderId: string) =>
      api.app.get(LedgerService).reservationsFor({ sourceType: 'order', sourceId: orderId });

    /** Each active reservation: line id to [location, open, unfilled]. */
    const active = async (orderId: string) =>
      Object.fromEntries(
        (await reservations(orderId))
          .filter((row) => row.status === 'active')
          .map((row) => [
            row.sourceLineId,
            [row.locationId, row.openQuantity, row.unfilledQuantity],
          ]),
      );

    const gateCheck = async (locationId: string) => {
      const reply = await api.call(manager, 'GET', `/api/locations/${locationId}/online-gate`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return OnlineGateView.parse(reply.body).checks.find((c) => c.key === OPEN_ORDERS_HELD_CHECK);
    };

    const hold = (locationId: string) =>
      api.call(manager, 'POST', '/api/orders/hold-open-orders', { locationId });

    const noOnlineLocation = () =>
      owner('UPDATE locations SET sellable_online = false WHERE sellable_online');

    beforeAll(async () => {
      api = await startInProcessApi();
      manager = await api.signIn((await api.addPerson(['manager'])).email);
      support = await api.signIn((await api.addPerson(['support'])).email);
      warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
      const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
      mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
      manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
      await noOnlineLocation();
    });

    afterAll(async () => {
      await api?.close();
    });

    describe('before any location is online', () => {
      let candidate = '';
      let older = '';
      let newer = '';

      it('counts only open lines of holding orders with a stock SKU, then holds oldest order first', async () => {
        candidate = await plantWarehouse(api);
        const [last, empty, gone, service] = [await sku(), await sku(), await sku(), await sku()];
        await owner(`UPDATE product_variants SET kind = 'service' WHERE id = $1::uuid`, [service]);
        await putOnShelf(api, candidate, [last], 1);

        older = await create([
          { variantId: last, quantity: 1 },
          { variantId: service, quantity: 1 },
        ]);
        newer = await create([{ variantId: last, quantity: 1 }]);
        const cancelled = await create([{ variantId: gone, quantity: 1 }]);
        expect((await move(cancelled, 'cancel', { reasonCode: 'customer_cancelled' })).status).toBe(
          200,
        );
        const edited = await create([
          { variantId: empty, quantity: 1 },
          { variantId: gone, quantity: 2 },
        ]);
        const goneLine = (await detail(edited)).lines.find((l) => l.variantId === gone)?.id;
        const removed = await move(edited, 'edits', {
          reasonCode: 'customer_request',
          operations: [
            { kind: 'remove_line', lineId: goneLine, cancelReasonCode: 'customer_cancelled' },
          ],
        });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);

        // A service line is neither reserved nor short (amendment 2); the reservable lines read
        // short with no online location (Short lines scenario).
        expect(await shorts(older)).toEqual([1, 0]);
        expect(await shorts(edited)).toEqual([1]);

        // older's stock line, newer's line, and edited's remaining line: 3. Not the service line,
        // not the cancelled order, not the removed line.
        expect(await gateCheck(candidate)).toMatchObject({ passed: false, count: 3 });

        const reply = await hold(candidate);
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        // One piece: the older order takes it; the newer one and the empty SKU wait (AC-26).
        expect(HoldOpenOrdersResult.parse(reply.body)).toEqual({
          linesHeld: 1,
          linesShort: 2,
          linesLeft: 0,
        });
        expect(Object.values(await active(older))).toEqual([[candidate, 1, 0]]);
        expect(Object.values(await active(newer))).toEqual([[candidate, 0, 1]]);
        expect(await shorts(older)).toEqual([0, 0]);
        expect(await shorts(newer)).toEqual([1]);
        // A line held but short still holds an active reservation there: the check passes.
        expect(await gateCheck(candidate)).toMatchObject({ passed: true, count: 0 });
      });

      it('keeps a line held in full at the candidate unmarked when the order is confirmed (short_quantity copies unfilled_quantity, AC-13)', async () => {
        const reply = await move(older, 'confirm');
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        expect(Object.values(await active(older))).toEqual([[candidate, 1, 0]]);
        expect(await shorts(older)).toEqual([0, 0]);
      });

      it('refuses a pack with LINE_SHORT while no location is online, and the order stays confirmed', async () => {
        const refused = await move(older, 'pack', {}, warehouse);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'LINE_SHORT' });
        expect((await detail(older)).fulfillmentState).toBe('confirmed');
      });

      it('answers 404 LOCATION_NOT_FOUND for an archived warehouse and for a shop', async () => {
        const archived = await plantWarehouse(api);
        await owner(`UPDATE locations SET archived_at = now() WHERE id = $1::uuid`, [archived]);
        const { rows } = await owner<{ id: string }>(
          `INSERT INTO locations (code, name, kind, allow_negative, is_sellable)
         VALUES ($1, '{"en": "QA shop"}', 'shop', false, true) RETURNING id`,
          [`QSH-${randomUUID().slice(0, 8)}`],
        );
        for (const id of [archived, rows[0]?.id as string]) {
          const reply = await hold(id);
          expect(reply.status, JSON.stringify(reply.body)).toBe(404);
          expect(reply.body).toMatchObject({ code: 'LOCATION_NOT_FOUND' });
        }
      });

      it('moves a line held at one location to another candidate: released there, held here (amendment 2)', async () => {
        const other = await plantWarehouse(api);
        const reply = await hold(other);
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        // `other` has no stock: the line now waits there.
        expect(Object.values(await active(older))).toEqual([[other, 0, 1]]);
        const { rows } = await owner<{ location_id: string; status: string }>(
          `SELECT location_id, status FROM reservations
         WHERE source_type = 'order' AND source_id = $1::uuid ORDER BY created_at, id`,
          [older],
        );
        expect(rows).toEqual([
          { location_id: candidate, status: 'released' },
          { location_id: other, status: 'active' },
        ]);
        expect(await shorts(older)).toEqual([1, 0]);
        expect(await gateCheck(other)).toMatchObject({ passed: true, count: 0 });
        // Every open line not held at `other` moved, the newer order's waiting line too.
        expect(Object.values(await active(newer))).toEqual([[other, 0, 1]]);
        // Back to the first candidate for the rest of the suite: oldest order first again.
        expect((await hold(candidate)).status).toBe(200);
        expect(Object.values(await active(older))).toEqual([[candidate, 1, 0]]);
        expect(Object.values(await active(newer))).toEqual([[candidate, 0, 1]]);
        expect(await shorts(older)).toEqual([0, 0]);
        expect(await shorts(newer)).toEqual([1]);
      });

      it('rolls a refused pack top up back: nothing is held and the shorts stay as they were', async () => {
        const [a, b] = [await sku(), await sku()];
        const id = await create([
          { variantId: a, quantity: 1 },
          { variantId: b, quantity: 1 },
        ]);
        expect((await move(id, 'confirm')).status).toBe(200);
        expect(await reservations(id)).toEqual([]);

        await makeOnline(api, candidate);
        await putOnShelf(api, candidate, [a], 1);
        const refused = await move(id, 'pack', {}, warehouse);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'LINE_SHORT' });
        expect(await reservations(id)).toEqual([]);
        expect(await shorts(id)).toEqual([1, 1]);
      });
    });

    describe('with the candidate online', () => {
      let online = '';

      beforeAll(async () => {
        const { rows } = await owner<{ id: string }>(
          `SELECT id FROM locations WHERE sellable_online`,
        );
        online = rows[0]?.id as string;
        expect(online).toBeTruthy();
      });

      it('fills a waiting order when the holder is cancelled (ReservationFilled on a release, spec 0011 AC-21)', async () => {
        const m = await sku();
        await putOnShelf(api, online, [m], 1);
        const holder = await create([{ variantId: m, quantity: 1 }]);
        const waiting = await create([{ variantId: m, quantity: 1 }]);
        expect(await shorts(waiting)).toEqual([1]);

        expect((await move(holder, 'cancel', { reasonCode: 'customer_cancelled' })).status).toBe(
          200,
        );
        expect(await shorts(waiting)).toEqual([0]);
        expect(Object.values(await active(waiting))).toEqual([[online, 1, 0]]);
      });

      it('fills a waiting order when an edit removes the holder line', async () => {
        const [m, other] = [await sku(), await sku()];
        await putOnShelf(api, online, [m, other], 1);
        const holder = await create([
          { variantId: m, quantity: 1 },
          { variantId: other, quantity: 1 },
        ]);
        const waiting = await create([{ variantId: m, quantity: 1 }]);
        expect(await shorts(waiting)).toEqual([1]);

        const lineM = (await detail(holder)).lines.find((l) => l.variantId === m)?.id;
        const reply = await move(holder, 'edits', {
          reasonCode: 'customer_request',
          operations: [
            { kind: 'remove_line', lineId: lineM, cancelReasonCode: 'customer_cancelled' },
          ],
        });
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        expect(OrderDetail.parse(reply.body).lines.find((l) => l.id === lineM)?.shortQuantity).toBe(
          0,
        );
        expect(await shorts(waiting)).toEqual([0]);
      });

      it('holds what is free and marks the rest short: 3 asked, 1 on the shelf, short by 2', async () => {
        const p = await sku();
        await putOnShelf(api, online, [p], 1);
        const id = await create([{ variantId: p, quantity: 3 }]);
        expect(await shorts(id)).toEqual([2]);
        expect(Object.values(await active(id))).toEqual([[online, 1, 2]]);
        const page = OrderListResponse.parse(
          (await api.call(support, 'GET', '/api/orders?short=true&limit=100')).body,
        );
        expect(page.items.find((i) => i.id === id)?.short).toBe(true);
      });

      it('packs an order whose only line is a service SKU: never reserved, never short', async () => {
        const s = await sku();
        await owner(`UPDATE product_variants SET kind = 'service' WHERE id = $1::uuid`, [s]);
        const id = await create([{ variantId: s, quantity: 1 }]);
        expect(await reservations(id)).toEqual([]);
        expect(await shorts(id)).toEqual([0]);
        expect((await move(id, 'confirm')).status).toBe(200);
        const packed = await move(id, 'pack', {}, warehouse);
        expect(packed.status, JSON.stringify(packed.body)).toBe(200);
      });

      it('answers 503 BUSY with Retry-After when the order row lock waits past the cap (AC-22)', async () => {
        const x = await sku();
        await putOnShelf(api, online, [x], 1);
        const id = await create([{ variantId: x, quantity: 1 }]);
        const { updatedAt } = await detail(id);
        const client = await api.owner.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM orders WHERE id = $1::uuid FOR UPDATE', [id]);
          const reply = await api.call(support, 'POST', `/api/orders/${id}/confirm`, {
            expectedUpdatedAt: updatedAt,
          });
          expect(reply.status, JSON.stringify(reply.body)).toBe(503);
          expect(reply.body).toMatchObject({ code: 'BUSY' });
          expect(reply.headers.get('retry-after')).toBe('2');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
        expect((await detail(id)).fulfillmentState).toBe('new');
      });
    });
  },
);
