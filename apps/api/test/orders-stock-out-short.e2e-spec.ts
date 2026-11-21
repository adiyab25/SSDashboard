import { randomUUID } from 'node:crypto';
import { ChannelOrderInput, OrderDetail, SkuDetail } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderIntake, type ChannelActor } from '../src/orders/intake/order-intake.service.js';
import type { OrderActor } from '../src/orders/order-actor.js';
import { OrderTransactions, type OrderTransaction } from '../src/orders/order-transactions.js';
import { ShipmentPosting } from '../src/orders/shipment/shipment-posting.js';
import {
  OrderTransitions,
  type ShipmentFact,
} from '../src/orders/transitions/order-transitions.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { plantWarehouse, makeOnline, putOnShelf } from './order-stock.js';

/** The stock facts of one line as the assertions read them. */
interface LineFacts extends Record<string, unknown> {
  quantity: number;
  line_state: string;
  short_quantity: number;
  stock_out_quantity: number | null;
}

// QA gap tests for spec 0013 milestone 5 (verify of 2026-11-21), AC-13 and AC-27: a REAL stock out
// (through `recordChannelStockOut`, the post job, and a carrier `shipped`), never a database seed,
// on an order whose line was short. AC-13: "no path reserves its lines again" and `short_quantity`
// is the orders module's copy of the line's unfilled demand, so once the pieces left the shelf the
// page must not keep saying "Short by N" for a line that already shipped.
describe('orders, QA gaps: a stock out of a short line', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let manager = '';
  let managerId = '';
  let mainStore = '';
  let lpChannel = '';
  let n = 0;

  const carrier: OrderActor = { type: 'carrier', connectionId: randomUUID() };
  const job = (): ChannelActor => ({
    type: 'system_job',
    job: 'shopify.inbox',
    jobId: randomUUID(),
  });
  const run = <T>(work: (tx: OrderTransaction) => Promise<T>) =>
    api.app.get(OrderTransactions).run(work);
  const owner = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    api.owner.pool.query<T>(text, params);

  /** A variant with `onShelf` pieces at the online warehouse. */
  const variantWith = async (onShelf: number) => {
    n += 1;
    const reply = await api.call(manager, 'POST', '/api/products', {
      name: { en: `Short tee ${String(n)}` },
      variants: [{ sku: `SHORT-${randomUUID().slice(0, 8).toUpperCase()}`, price: '500.00' }],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const id = SkuDetail.parse(reply.body).id;
    if (onShelf > 0) await putOnShelf(api, warehouse, [id], onShelf);
    return id;
  };
  let warehouse = '';

  /** A COD Shopify channel order of 3 pieces of a variant that holds only 1 (short by 2). */
  const shortOrder = async () => {
    const variant = await variantWith(1);
    n += 1;
    const input = ChannelOrderInput.parse({
      storeId: mainStore,
      channelId: lpChannel,
      channelOrderRef: `sh-${randomUUID()}`,
      orderNumber: `#SH${String(n)}${randomUUID().slice(0, 4)}`,
      placedAt: new Date().toISOString(),
      type: 'sale',
      paymentMethod: 'cod',
      shippingChargedAmount: '50.00',
      channelCustomer: null,
      shipTo: {
        name: 'Short Name',
        phone: `0106${String(1_000_000 + n)}`,
        address: '1 Short Street',
      },
      lines: [
        {
          channelLineId: 'gid-s',
          variantId: variant,
          quantity: 3,
          title: 'Short tee',
          unitPrice: '500.00',
          taxRate: '14.00',
        },
      ],
    });
    const { orderId } = await run((tx) =>
      api.app.get(OrderIntake).createFromChannel(tx, input, job()),
    );
    return orderId;
  };

  const linesOf = async (id: string) =>
    (
      await owner<LineFacts>(
        `SELECT quantity, line_state, short_quantity, stock_out_quantity
         FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [id],
      )
    ).rows;
  const runPostJobs = async (id: string) => {
    const queued = await owner<{ id: string; data: never }>(
      `SELECT id, data FROM pgboss.job
       WHERE name = 'orders.post_shipment' AND data->>'orderId' = $1 ORDER BY created_on, id`,
      [id],
    );
    for (const row of queued.rows) {
      await api.app.get(ShipmentPosting).run({ id: row.id, data: row.data, retryCount: 0 });
    }
  };
  const detail = async (id: string) => {
    const reply = await api.call(manager, 'GET', `/api/orders/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OrderDetail.parse(reply.body);
  };
  const fact = (to: ShipmentFact['to']): ShipmentFact => ({
    to,
    occurredAt: new Date(),
    reasonCode: null,
    source: { type: 'carrier_delivery_event', id: randomUUID() },
  });

  beforeAll(async () => {
    api = await startInProcessApi();
    const managerPerson = await api.addPerson(['manager']);
    managerId = managerPerson.id;
    manager = await api.signIn(managerPerson.email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    lpChannel = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('SHLP', '{"en":"Short landing page"}', 'landing_page', '${mainStore}') RETURNING id`,
    );
    warehouse = await plantWarehouse(api);
    await makeOnline(api, warehouse);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('control: the order is short by 2 before any stock out', async () => {
    const id = await shortOrder();
    expect((await linesOf(id)).map((l) => l.short_quantity)).toEqual([2]);
  });

  it('a real Shopify stock out, then its post job: the line is no longer short and the page says so', async () => {
    const id = await shortOrder();
    await run((tx) =>
      api.app
        .get(OrderTransitions)
        .recordCarrierDelivery(
          tx,
          id,
          { at: new Date(), source: { type: 'shopify_fulfillment', id: randomUUID() } },
          job(),
        ),
    );
    expect(
      await run((tx) =>
        api.app.get(OrderTransitions).recordChannelStockOut(
          tx,
          id,
          {
            at: new Date(),
            source: { type: 'shopify_fulfillment', id: randomUUID() },
            fulfilledLines: [{ channelLineId: 'gid-s', quantity: 3 }],
          },
          job(),
        ),
      ),
    ).toEqual({ requested: true });
    await runPostJobs(id);
    const groups = await owner<{ n: string }>(
      `SELECT count(*) AS n FROM movement_groups WHERE source_type = 'order_shipment' AND source_id = $1::uuid`,
      [id],
    );
    expect(groups.rows[0]?.n).toBe('1');
    const holds = await owner<{ status: string; unfilled_quantity: number }>(
      `SELECT status, unfilled_quantity FROM reservations WHERE source_id = $1::uuid`,
      [id],
    );
    expect(holds.rows).toEqual([{ status: 'fulfilled', unfilled_quantity: 0 }]);
    // QA B1: AC-13 "no path reserves again" and the page's "Short by N" mark.
    const lines = await linesOf(id);
    expect(lines.map((l) => l.stock_out_quantity)).toEqual([3]);
    expect(lines.map((l) => l.short_quantity)).toEqual([0]);
    const page = await detail(id);
    expect(page.lines.map((l) => l.shortQuantity)).toEqual([0]);
  });

  it('a carrier shipped on a short line, then its post job: the line is no longer short', async () => {
    const id = await shortOrder();
    await run((tx) =>
      api.app
        .get(OrderTransitions)
        .confirm(tx, id, { type: 'person', userId: managerId, hat: 'manager' }),
    );
    await run((tx) =>
      api.app.get(OrderTransitions).recordShipmentFact(tx, id, fact('shipped'), carrier),
    );
    await runPostJobs(id);
    const lines = await linesOf(id);
    expect(lines.map((l) => l.short_quantity)).toEqual([0]);
  });

  it('after a real Shopify stock out the order cannot be edited, and Confirm still answers (observed)', async () => {
    const id = await shortOrder();
    await run((tx) =>
      api.app
        .get(OrderTransitions)
        .recordCarrierDelivery(
          tx,
          id,
          { at: new Date(), source: { type: 'shopify_fulfillment', id: randomUUID() } },
          job(),
        ),
    );
    await run((tx) =>
      api.app.get(OrderTransitions).recordChannelStockOut(
        tx,
        id,
        {
          at: new Date(),
          source: { type: 'shopify_fulfillment', id: randomUUID() },
          fulfilledLines: [{ channelLineId: 'gid-s', quantity: 3 }],
        },
        job(),
      ),
    );
    await runPostJobs(id);
    const before = await detail(id);
    const edit = await api.call(manager, 'POST', `/api/orders/${id}/edits`, {
      expectedUpdatedAt: before.updatedAt,
      operations: [{ kind: 'ship_to', address: 'Somewhere else' }],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(409);
    expect((edit.body as { code: string }).code).toBe('ORDER_LOCKED');
    // The stock out never reserves again, whatever Confirm does.
    const confirm = await api.call(manager, 'POST', `/api/orders/${id}/confirm`, {
      expectedUpdatedAt: before.updatedAt,
    });
    // Observed: Confirm is still accepted (the state machine is unchanged by a Shopify stock out, AC-27 a).
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    const holds = await owner<{ status: string }>(
      `SELECT status FROM reservations WHERE source_id = $1::uuid AND status = 'active'`,
      [id],
    );
    expect(holds.rows).toEqual([]);
  });
});
