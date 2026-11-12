import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  HoldOpenOrdersResult,
  OnlineGateView,
  OrderDetail,
  SkuDetail,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { ONLINE_FLAG_LOCK } from '../src/inventory/online-stock/online-stock.service.js';
import { OPEN_ORDERS_HELD_CHECK } from '../src/orders/stock/order-stock.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { makeOnline, plantWarehouse, putOnShelf } from './order-stock.js';

// Spec 0013 milestone 4 fix batch (lead ruling of 2026-11-12, spec 0011 AC-19: reservations at
// the old location stay there): the gate check counts a line held at the candidate or at the
// current online location as held; hold-open-orders never takes a hold off the online location
// and moves only holds at a location that is not online; a move A to B passes with orders held at
// A, which keep shipping from A; an order over 200 lines holds across batches; an order racing a
// flag move waits for it (the online flag lock, review M2); and the gate and hold cost with 200
// open orders. Its own scratch database, so the install wide counts are the suite's alone.
describe(
  'orders stock and the online flag (spec 0013 AC-13, AC-26; spec 0011 AC-19)',
  { timeout: 300_000 },
  () => {
    let api: InProcessApi;
    let manager = '';
    let support = '';
    let warehouse = '';
    let mainStore = '';
    let manualChannel = '';
    let a = '';
    let b = '';
    let shelfSku = '';
    let n = 0;
    const timings: Record<string, number> = {};

    const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) => api.owner.pool.query<T>(text, params);

    const phone = () => {
      n += 1;
      return `0104${String(1_000_000 + n)}`;
    };

    const sku = async () => {
      const code = `OF-${randomUUID().slice(0, 8)}`;
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '500.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };

    const createBody = (variantId: string) => ({
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Flag Tester', phone: phone(), address: '3 Shelf Street' },
      lines: [{ variantId, quantity: 1, unitPrice: '500.00' }],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });

    const create = async (variantId: string) => {
      const reply = await api.call(support, 'POST', '/api/orders', createBody(variantId));
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return CreatedOrder.parse(reply.body).id;
    };

    const detail = async (id: string) => {
      const reply = await api.call(support, 'GET', `/api/orders/${id}`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return OrderDetail.parse(reply.body);
    };

    const move = async (id: string, what: 'confirm' | 'pack', cookie = support) => {
      const { updatedAt } = await detail(id);
      return api.call(cookie, 'POST', `/api/orders/${id}/${what}`, {
        expectedUpdatedAt: updatedAt,
      });
    };

    /** Where each active reservation of an order sits: line id to [location, open, unfilled]. */
    const active = async (orderId: string) =>
      Object.fromEntries(
        (
          await api.app
            .get(LedgerService)
            .reservationsFor({ sourceType: 'order', sourceId: orderId })
        )
          .filter((row) => row.status === 'active')
          .map((row) => [
            row.sourceLineId,
            [row.locationId, row.openQuantity, row.unfilledQuantity],
          ]),
      );

    const gate = async (locationId: string) => {
      const reply = await api.call(manager, 'GET', `/api/locations/${locationId}/online-gate`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return OnlineGateView.parse(reply.body);
    };

    const ordersCheck = async (locationId: string) =>
      (await gate(locationId)).checks.find((c) => c.key === OPEN_ORDERS_HELD_CHECK);

    const hold = async (locationId: string) => {
      const reply = await api.call(manager, 'POST', '/api/orders/hold-open-orders', { locationId });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return HoldOpenOrdersResult.parse(reply.body);
    };

    const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await work();
      timings[label] = Math.round(performance.now() - started);
      return result;
    };

    beforeAll(async () => {
      api = await startInProcessApi();
      manager = await api.signIn((await api.addPerson(['manager'])).email);
      support = await api.signIn((await api.addPerson(['support'])).email);
      warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
      const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
      mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
      manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
      await owner('UPDATE locations SET sellable_online = false WHERE sellable_online');
      a = await plantWarehouse(api);
      b = await plantWarehouse(api);
      shelfSku = await sku();
      await putOnShelf(api, a, [shelfSku], 10_000);
    });

    afterAll(async () => {
      // The measured cost of the gate check and the hold (reported to the lead; not a budget).
      console.info(`orders stock timings (ms): ${JSON.stringify(timings)}`);
      await api?.close();
    });

    it('holds 200 open one line orders at a candidate in one call, and measures the gate and the hold', async () => {
      for (let i = 0; i < 200; i += 1) await create(shelfSku);

      expect(await timed('gate, 200 unheld', () => ordersCheck(a))).toMatchObject({
        passed: false,
        count: 200,
      });
      expect(await timed('hold, 200 lines', () => hold(a))).toEqual({
        linesHeld: 200,
        linesShort: 0,
        linesLeft: 0,
      });
      expect(await timed('gate, 200 held', () => ordersCheck(a))).toMatchObject({
        passed: true,
        count: 0,
      });
      expect(await timed('repeat hold, 200 held', () => hold(a))).toEqual({
        linesHeld: 0,
        linesShort: 0,
        linesLeft: 0,
      });
    });

    it('holds an order of 201 lines across two batches', async () => {
      const id = await create(shelfSku);
      // As the owner: 200 more open lines of the same SKU (the form takes fewer), positions 2 to 201.
      await owner(
        `INSERT INTO order_lines (order_id, position, variant_id, title, quantity, unit_price,
         discount_amount, net_amount, tax_rate, tax_amount, gross_amount, prepaid_amount,
         credit_applied_amount, line_state)
       SELECT l.order_id, g, l.variant_id, l.title, l.quantity, l.unit_price, l.discount_amount,
         l.net_amount, l.tax_rate, l.tax_amount, l.gross_amount, 0, 0, 'open'
       FROM order_lines l, generate_series(2, 201) g WHERE l.order_id = $1::uuid`,
        [id],
      );
      expect(await ordersCheck(a)).toMatchObject({ passed: false, count: 201 });

      expect(await hold(a)).toEqual({ linesHeld: 201, linesShort: 0, linesLeft: 0 });
      const held = Object.values(await active(id));
      expect(held).toHaveLength(201);
      expect(held.every(([at, open]) => at === a && open === 1)).toBe(true);
    });

    it('passes the gate on B with every order held at the online A, and never takes a hold off A', async () => {
      await makeOnline(api, a);
      const id = await create(shelfSku);
      expect(Object.values(await active(id))).toEqual([[a, 1, 0]]);

      // Held at the online location counts as held for candidate B (spec 0011 AC-19).
      expect(await ordersCheck(b)).toMatchObject({ passed: true, count: 0 });
      expect(await hold(b)).toEqual({ linesHeld: 0, linesShort: 0, linesLeft: 0 });
      expect(Object.values(await active(id))).toEqual([[a, 1, 0]]);
    });

    it('moves the flag A to B through the gate; holds at A stay there and the order still packs from A', async () => {
      const id = await create(shelfSku);
      const confirmed = await api.call(manager, 'POST', `/api/locations/${b}/confirm-stock`, {
        reason: 'Counted on the shelf',
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      const view = await gate(b);
      expect(view.canGoOnline, JSON.stringify(view.checks)).toBe(true);
      const moved = await api.call(manager, 'POST', `/api/locations/${b}/make-online`, {
        confirmedVariantCount: view.variantsWithStock,
        reason: 'Move online stock to B',
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);

      // The top up keeps the line at A: it ships from where its pieces are.
      expect((await move(id, 'confirm')).status).toBe(200);
      expect(Object.values(await active(id))).toEqual([[a, 1, 0]]);
      expect((await detail(id)).lines.map((l) => l.shortQuantity)).toEqual([0]);
      const packed = await move(id, 'pack', warehouse);
      expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    });

    it('moves a line held at a location that is no longer online to the candidate', async () => {
      // B is online now; a fresh candidate C. Orders still held at A count as unheld for C.
      const c = await plantWarehouse(api);
      const id = await create(shelfSku);
      expect(Object.values(await active(id))).toEqual([[b, 0, 1]]);
      const atA = (
        await owner<{ n: number }>(
          `SELECT count(*)::int AS n FROM reservations WHERE status = 'active' AND location_id = $1::uuid`,
          [a],
        )
      ).rows[0]?.n as number;
      expect(atA).toBeGreaterThan(0);
      expect(await ordersCheck(c)).toMatchObject({ passed: false, count: atA });

      const result = await hold(c);
      // A's holds moved to C (C has no stock, so they wait there); B's online hold stayed.
      expect(result).toEqual({ linesHeld: 0, linesShort: atA, linesLeft: 0 });
      expect(Object.values(await active(id))).toEqual([[b, 0, 1]]);
      const left = await owner<{ n: number }>(
        `SELECT count(*)::int AS n FROM reservations WHERE status = 'active' AND location_id = $1::uuid`,
        [a],
      );
      expect(left.rows[0]?.n).toBe(0);
    });

    it('makes an order that races a flag move wait, then reserve at the new online location (review M2)', async () => {
      const s = await sku();
      await putOnShelf(api, a, [s], 5);
      const client = await api.owner.pool.connect();
      let created: Promise<string> | null = null;
      try {
        await client.query('BEGIN');
        // A flag move in flight: it holds the online flag lock exclusive and moves the flag to A.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ONLINE_FLAG_LOCK]);
        await client.query('UPDATE locations SET sellable_online = false WHERE sellable_online');
        await client.query('UPDATE locations SET sellable_online = true WHERE id = $1', [a]);
        created = create(s);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const { rows } = await owner<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        expect(rows[0]?.n).toBeGreaterThan(0);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const id = await created;
      expect(Object.values(await active(id))).toEqual([[a, 1, 0]]);
    });
  },
);
