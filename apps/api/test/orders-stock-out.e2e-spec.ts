import { randomUUID } from 'node:crypto';
import {
  ChannelOrderInput,
  CreatedOrder,
  OrderDetail,
  OrderListResponse,
  SkuDetail,
  carrierShipmentKey,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { OrderIntake, type ChannelActor } from '../src/orders/intake/order-intake.service.js';
import type { OrderActor } from '../src/orders/order-actor.js';
import { OrderTransactions, type OrderTransaction } from '../src/orders/order-transactions.js';
import {
  NoLinesDiffer,
  PiecesAwaitingRestock,
  StockAlreadyLeft,
  StockOutAlreadyRequested,
} from '../src/orders/orders.errors.js';
import { OrderAttentionRaised } from '../src/orders/orders.events.js';
import {
  cancelReversalKey,
  fulfillmentReversalKey,
  type PostShipmentJobData,
} from '../src/orders/shipment/post-shipment.queue.js';
import { ShipmentPosting } from '../src/orders/shipment/shipment-posting.js';
import { OrderStock } from '../src/orders/stock/order-stock.js';
import {
  OrderTransitions,
  attentionTaskKey,
  type ShipmentFact,
} from '../src/orders/transitions/order-transitions.service.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { makeOnline, plantWarehouse, stockedOnline } from './order-stock.js';

/** A line row as the assertions read it. */
interface LineRow extends Record<string, unknown> {
  id: string;
  variant_id: string | null;
  quantity: number;
  line_state: string;
  unit_cost: string | null;
  stock_out_quantity: number | null;
  awaiting_restock_quantity: number;
  awaiting_restock_since: Date | null;
  short_quantity: number;
  restocked_quantity: number;
  closed_quantity: number;
}

/** An order's stock out columns. */
interface StockOutRow extends Record<string, unknown> {
  fulfillment_state: string;
  stock_out_generation: number;
  stock_out_source: string | null;
  stock_out_requested_at: Date | null;
  carrier_delivery_created_at: Date | null;
  updated_at: string;
}

/** A queued `orders.post_shipment` job. */
interface JobRow extends Record<string, unknown> {
  id: string;
  data: PostShipmentJobData & { capability: string };
}

// Spec 0013 milestone 5 task 15, the Shopify half (AC-13, AC-15, AC-23, AC-24, AC-27): every case of
// the *One shipment posting per order* and *Stock out without a carrier* test scenarios, in process
// and through the routes, as the application role on a scratch database. Feature 13's calls
// (`recordChannelStockOut`, `recordChannelFulfillmentCancelled`, `recordChannelReturn`) are made in
// process the way spec 0015 task 9a will make them; the queued `orders.post_shipment` jobs run
// through `ShipmentPosting`, the work the worker's handler calls. Two cases of the scenarios wait on
// code that does not exist yet and are recorded as such below: the `found` adjustment refusal (spec
// 0011's adjustments and its `ReturnsAwaitingRestock` registry are not built; the provider read
// `OrderStock.pendingFor` is proven instead) and the Bosta source runnable (feature 19's capability
// is not in the registry, so it is never runnable).
describe('orders, task 15: stock out from Shopify fulfillment', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let supportId = '';
  let manager = '';
  let warehouse = '';
  let mainStore = '';
  let manualChannel = '';
  let lpChannel = '';
  let skuM = '';
  let skuL = '';
  let shelf = '';
  let n = 0;
  const attentions: OrderAttentionRaised[] = [];

  const carrier: OrderActor = { type: 'carrier', connectionId: randomUUID() };
  const job = (): ChannelActor => ({
    type: 'system_job',
    job: 'shopify.inbox',
    jobId: randomUUID(),
  });
  const person = () => ({ type: 'person' as const, userId: supportId, hat: 'support' });
  const run = <T>(work: (tx: OrderTransaction) => Promise<T>) =>
    api.app.get(OrderTransactions).run(work);
  const moves = () => api.app.get(OrderTransitions);
  const intake = () => api.app.get(OrderIntake);
  const stock = () => api.app.get(OrderStock);
  const posting = () => api.app.get(ShipmentPosting);
  const ledger = () => api.app.get(LedgerService);
  const owner = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    api.owner.pool.query<T>(text, params);

  const phone = () => {
    n += 1;
    return `0105${String(1_000_000 + n)}`;
  };

  /** A COD channel order on the MAIN store's landing page channel: 2 M (`gid-m`) and 1 L (`gid-l`). */
  const channelOrder = async (
    lines: { channelLineId: string; variantId: string | null; quantity: number }[] = [
      { channelLineId: 'gid-m', variantId: skuM, quantity: 2 },
      { channelLineId: 'gid-l', variantId: skuL, quantity: 1 },
    ],
  ) => {
    n += 1;
    const input = ChannelOrderInput.parse({
      storeId: mainStore,
      channelId: lpChannel,
      channelOrderRef: `so-${randomUUID()}`,
      orderNumber: `#SO${String(n)}${randomUUID().slice(0, 4)}`,
      placedAt: new Date().toISOString(),
      type: 'sale',
      paymentMethod: 'cod',
      shippingChargedAmount: '50.00',
      channelCustomer: null,
      shipTo: { name: 'Stock Out Name', phone: phone(), address: '1 Stock Out Street' },
      lines: lines.map((line) => ({
        ...line,
        title: 'Stock out tee',
        unitPrice: '500.00',
        taxRate: '14.00',
      })),
    });
    const { orderId } = await run((tx) => intake().createFromChannel(tx, input, job()));
    return orderId;
  };

  /** A manual COD order through the route (2 M and 1 L). */
  const manualOrder = async () => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Stock Out Name', phone: phone(), address: '1 Stock Out Street' },
      lines: [
        { variantId: skuM, quantity: 2, unitPrice: '500.00' },
        { variantId: skuL, quantity: 1, unitPrice: '500.00' },
      ],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return CreatedOrder.parse(reply.body).id;
  };

  const fulfillment = () => ({ type: 'shopify_fulfillment' as const, id: randomUUID() });
  /** Feature 13's call when Shopify reports the order fulfilled (spec 0015 AC-28 a). */
  const shopifyFulfilled = (
    id: string,
    fulfilledLines = [
      { channelLineId: 'gid-m', quantity: 2 },
      { channelLineId: 'gid-l', quantity: 1 },
    ],
  ) =>
    run((tx) =>
      moves().recordChannelStockOut(
        tx,
        id,
        { at: new Date(), source: fulfillment(), fulfilledLines },
        job(),
      ),
    );
  const fulfillmentCancelled = (id: string) =>
    run((tx) =>
      moves().recordChannelFulfillmentCancelled(
        tx,
        id,
        { at: new Date(), source: fulfillment() },
        job(),
      ),
    );
  const fact = (to: ShipmentFact['to'], reasonCode?: string): ShipmentFact => ({
    to,
    occurredAt: new Date(),
    reasonCode: reasonCode ?? null,
    source: { type: 'carrier_delivery_event', id: randomUUID() },
  });
  const report = (id: string, f: ShipmentFact) =>
    run((tx) => moves().recordShipmentFact(tx, id, f, carrier));
  const confirm = (id: string) => run((tx) => moves().confirm(tx, id, person()));
  const cancelFromChannel = (id: string) =>
    run((tx) => intake().cancelFromChannel(tx, id, 'channel.customer', job()));

  const jobsOf = async (id: string) =>
    (
      await owner<JobRow>(
        `SELECT id, data FROM pgboss.job
         WHERE name = 'orders.post_shipment' AND data->>'orderId' = $1 ORDER BY created_on, id`,
        [id],
      )
    ).rows;
  /** Runs the order's queued jobs of a kind, oldest first, each once as a first attempt. */
  const runJobs = async (id: string, kind: PostShipmentJobData['kind']) => {
    const outputs: object[] = [];
    for (const queued of await jobsOf(id)) {
      if (queued.data.kind !== kind) continue;
      outputs.push(await posting().run({ id: queued.id, data: queued.data, retryCount: 0 }));
    }
    return outputs;
  };
  const linesOf = async (id: string) =>
    (
      await owner<LineRow>(
        `SELECT id, variant_id, quantity, line_state, unit_cost, stock_out_quantity,
                awaiting_restock_quantity, awaiting_restock_since, short_quantity,
                restocked_quantity, closed_quantity
         FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [id],
      )
    ).rows;
  const orderOf = async (id: string) =>
    (
      await owner<StockOutRow>(
        `SELECT fulfillment_state, stock_out_generation, stock_out_source, stock_out_requested_at,
                carrier_delivery_created_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM orders WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0] as StockOutRow;
  const groupsOf = async (id: string, sourceType = 'order_shipment') =>
    (
      await owner<{ id: string; idempotency_key: string; reverses_group_id: string | null }>(
        `SELECT id, idempotency_key, reverses_group_id FROM movement_groups
         WHERE source_type = $2 AND source_id = $1::uuid ORDER BY recorded_at, id`,
        [id, sourceType],
      )
    ).rows;
  const movementsOf = async (groupId: string) =>
    (
      await owner<{
        source_line_id: string;
        quantity: number;
        location_id: string;
        unit_cost: string;
      }>(
        `SELECT source_line_id, quantity, location_id, unit_cost FROM stock_movements
         WHERE group_id = $1::uuid ORDER BY quantity, source_line_id`,
        [groupId],
      )
    ).rows;
  const activeHolds = async (id: string) =>
    (await ledger().reservationsFor({ sourceType: 'order', sourceId: id })).filter(
      (held) => held.status === 'active',
    );
  const attentionsOf = (id: string) =>
    attentions.filter((a) => a.orderId === id).map((a) => a.kind);
  const auditOf = async (id: string, action: string) =>
    (
      await owner<{ reason: string | null; before: unknown; after: unknown; actor_kind: string }>(
        `SELECT reason, before, after, actor_kind FROM audit_entries
         WHERE record_type = 'order' AND record_id = $1::uuid AND action = $2 ORDER BY recorded_at`,
        [id, action],
      )
    ).rows;
  const detail = async (id: string) => {
    const reply = await api.call(manager, 'GET', `/api/orders/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OrderDetail.parse(reply.body);
  };

  /** An order Shopify fulfilled whose posting is booked, generation 1. */
  const postedShopifyOrder = async () => {
    const id = await channelOrder();
    await confirm(id);
    expect(await shopifyFulfilled(id)).toEqual({ requested: true });
    expect(await runJobs(id, 'post')).toEqual([expect.objectContaining({ posted: true })]);
    return id;
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    const supportPerson = await api.addPerson(['support']);
    supportId = supportPerson.id;
    support = await api.signIn(supportPerson.email);
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    lpChannel = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('SOLP', '{"en":"Stock out landing page"}', 'landing_page', '${mainStore}') RETURNING id`,
    );
    const sku = async (code: string) => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '500.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };
    skuM = await sku('SO-M');
    skuL = await sku('SO-L');
    shelf = await stockedOnline(api, [skuM, skuL]);
    api.app
      .get(DomainEvents)
      .on(OrderAttentionRaised, (_tx, e) => void attentions.push(e), 'orders-stock-out-e2e');
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('one shipment posting per order (AC-24, AC-15)', () => {
    it('recordChannelStockOut posted, then a carrier shipped: the request kept, a second post job stops at ALREADY_POSTED, one group', async () => {
      const id = await postedShopifyOrder();
      expect(await orderOf(id)).toMatchObject({
        stock_out_source: 'shopify_fulfillment',
        stock_out_generation: 1,
      });
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([2, 1]);

      expect(await report(id, fact('shipped'))).toEqual({ applied: true });

      // Every carrier `shipped` enqueues the post job (owner ruling 2026-11-21, option A).
      const jobs = await jobsOf(id);
      expect(jobs.map((queued) => queued.data)).toEqual([
        { kind: 'post', orderId: id, generation: 1, capability: 'orders.shipment_posting' },
        { kind: 'post', orderId: id, generation: 1, capability: 'orders.shipment_posting' },
      ]);
      const second = jobs[1] as JobRow;
      expect(await posting().run({ id: second.id, data: second.data, retryCount: 0 })).toEqual({
        posted: false,
        why: 'ALREADY_POSTED',
      });
      expect((await groupsOf(id)).map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(id),
      ]);
      // The request is recorded only once: the Shopify one stands.
      expect((await orderOf(id)).stock_out_source).toBe('shopify_fulfillment');
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([2, 1]);
    });

    it('a Shopify request, a cancel before its job ran, then a late carrier shipped: exactly one posting', async () => {
      const id = await postedShopifyOrderUnposted();
      await cancelFromChannel(id);
      expect(await runJobs(id, 'post')).toEqual([{ posted: false, why: 'CANCELLED' }]);
      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 1 }]);
      expect(await groupsOf(id)).toEqual([]);

      await report(id, fact('shipped'));
      expect(await orderOf(id)).toMatchObject({
        fulfillment_state: 'shipped',
        stock_out_source: 'shopify_fulfillment',
        stock_out_generation: 1,
      });
      const jobs = await jobsOf(id);
      expect(jobs.map((queued) => queued.data.kind)).toEqual(['post', 'after_cancel', 'post']);
      const late = jobs[2] as JobRow;
      expect(await posting().run({ id: late.id, data: late.data, retryCount: 0 })).toMatchObject({
        posted: true,
        lines: 2,
      });
      // Every job run again: the posting stands alone.
      expect(await runJobs(id, 'post')).toEqual([
        { posted: false, why: 'ALREADY_POSTED' },
        { posted: false, why: 'ALREADY_POSTED' },
      ]);
      const groups = await groupsOf(id);
      expect(groups.map((group) => group.idempotency_key)).toEqual([carrierShipmentKey(id)]);
      expect(
        (await movementsOf(groups[0]?.id as string)).map((movement) => movement.quantity),
      ).toEqual([-2, -1]);
    });

    it('the carrier fact first, then recordChannelStockOut: already requested, still one group', async () => {
      const id = await channelOrder();
      await confirm(id);
      await report(id, fact('shipped'));
      await runJobs(id, 'post');

      expect(await shopifyFulfilled(id)).toEqual({ requested: false, why: 'already_requested' });
      expect(await groupsOf(id)).toHaveLength(1);
      expect((await jobsOf(id)).map((queued) => queued.data.kind)).toEqual(['post']);
    });

    it('two jobs racing on one key with different lines: one posting and shipment_not_posted', async () => {
      const id = await postedShopifyOrderUnposted();
      const [m] = await linesOf(id);
      await ledger().postCarrierShipment({
        orderId: id,
        lines: [{ sourceLineId: m?.id as string, variantId: skuM, locationId: shelf, quantity: 1 }],
      });
      const read = vi.spyOn(ledger(), 'postingFor').mockResolvedValueOnce(null);
      try {
        expect(await runJobs(id, 'post')).toEqual([{ posted: false, why: 'IDEMPOTENCY_CONFLICT' }]);
      } finally {
        read.mockRestore();
      }
      expect(await groupsOf(id)).toHaveLength(1);
      expect(attentionsOf(id)).toContain('shipment_not_posted');
    });

    it('markPacked posts nothing', async () => {
      const id = await channelOrder();
      await confirm(id);
      await run((tx) => moves().markPacked(tx, id, person()));

      expect(await jobsOf(id)).toEqual([]);
      expect(await groupsOf(id)).toEqual([]);
    });

    it('a line with no reservation and no online location raises shipment_not_posted', async () => {
      await owner('UPDATE locations SET sellable_online = false WHERE sellable_online');
      try {
        const id = await channelOrder([{ channelLineId: 'gid-m', variantId: skuM, quantity: 1 }]);
        expect(await activeHolds(id)).toEqual([]);
        expect(await shopifyFulfilled(id, [{ channelLineId: 'gid-m', quantity: 1 }])).toEqual({
          requested: true,
        });
        const [line] = await linesOf(id);

        expect(await runJobs(id, 'post')).toEqual([{ posted: false, why: 'NOTHING_TO_POST' }]);
        expect(await groupsOf(id)).toEqual([]);
        expect(
          attentions
            .filter((a) => a.orderId === id && a.kind === 'shipment_not_posted')
            .map((a) => [a.sourceType, a.sourceId]),
        ).toEqual([['order_line', line?.id]]);
      } finally {
        await makeOnline(api, shelf);
      }
    });

    it('a carrier shipped with fulfilled_lines_differ open posts the full open quantities and closes the attention', async () => {
      const id = await channelOrder();
      await confirm(id);
      expect(await shopifyFulfilled(id, [{ channelLineId: 'gid-m', quantity: 1 }])).toEqual({
        requested: false,
        why: 'lines_differ',
      });
      expect(attentionsOf(id)).toEqual(['fulfilled_lines_differ']);
      const close = vi.spyOn(api.app.get(TasksService), 'closeByKey');
      try {
        await report(id, fact('shipped'));
        expect(close).toHaveBeenCalledWith(
          expect.anything(),
          attentionTaskKey('fulfilled_lines_differ', id),
          { outcome: 'cleared', by: { kind: 'system_job' } },
        );
      } finally {
        close.mockRestore();
      }

      expect(await orderOf(id)).toMatchObject({ stock_out_source: 'carrier_shipped' });
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([2, 1]);
      await runJobs(id, 'post');
      const [group] = await groupsOf(id);
      expect((await movementsOf(group?.id as string)).map((m) => m.quantity)).toEqual([-2, -1]);
    });
  });

  /** An order Shopify fulfilled whose posting job has not run yet. */
  async function postedShopifyOrderUnposted() {
    const id = await channelOrder();
    await confirm(id);
    expect(await shopifyFulfilled(id)).toEqual({ requested: true });
    return id;
  }

  describe('stock out without a carrier (AC-27)', () => {
    it('quantities that differ request nothing; "Post what Shopify fulfilled" posts only those and releases the rest', async () => {
      const id = await channelOrder();
      await confirm(id);
      expect(await shopifyFulfilled(id, [{ channelLineId: 'gid-m', quantity: 2 }])).toEqual({
        requested: false,
        why: 'lines_differ',
      });
      expect(await orderOf(id)).toMatchObject({ stock_out_source: null });
      expect(await jobsOf(id)).toEqual([]);
      expect(attentionsOf(id)).toEqual(['fulfilled_lines_differ']);

      const [m, l] = await linesOf(id);
      const { updated_at } = await orderOf(id);
      await run((tx) =>
        stock().postChannelFulfillment(
          tx,
          id,
          {
            reasonCode: 'shopify_fulfilled_less',
            expectedUpdatedAt: updated_at,
            fulfilled: [{ lineId: m?.id as string, quantity: 2 }],
          },
          { type: 'person', userId: supportId, hat: 'manager' },
        ),
      );
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([2, 0]);
      // The L line's hold is released at once; the M line's is fulfilled by the posting.
      expect((await activeHolds(id)).map((held) => held.sourceLineId)).toEqual([m?.id]);
      await runJobs(id, 'post');
      const [group] = await groupsOf(id);
      expect(await movementsOf(group?.id as string)).toEqual([
        expect.objectContaining({ source_line_id: m?.id, quantity: -2 }),
      ]);
      expect(await activeHolds(id)).toEqual([]);
      const [entry] = await auditOf(id, 'order.channel_fulfillment_posted');
      expect(entry?.reason).toBe('shopify_fulfilled_less');
      expect(entry?.after).toEqual({
        lines: [
          { lineId: m?.id, postedQuantity: 2, releasedQuantity: 0 },
          { lineId: l?.id, postedQuantity: 0, releasedQuantity: 1 },
        ],
      });
      // Requested once: a second post is refused, and so are equal quantities on another order.
      await expect(
        run((tx) =>
          stock().postChannelFulfillment(
            tx,
            id,
            { reasonCode: 'other', expectedUpdatedAt: updated_at, fulfilled: [] },
            person(),
          ),
        ),
      ).rejects.toBeInstanceOf(StockOutAlreadyRequested);
      const same = await channelOrder();
      const lines = await linesOf(same);
      await expect(
        run(async (tx) =>
          stock().postChannelFulfillment(
            tx,
            same,
            {
              reasonCode: 'other',
              expectedUpdatedAt: (await orderOf(same)).updated_at,
              fulfilled: lines.map((line) => ({ lineId: line.id, quantity: line.quantity })),
            },
            person(),
          ),
        ),
      ).rejects.toBeInstanceOf(NoLinesDiffer);
    });

    it('after a stock out no path reserves again: confirm, linkChannelLineVariant, the gate, and the hold skip it; markPacked is refused', async () => {
      const id = await channelOrder([
        { channelLineId: 'gid-m', variantId: skuM, quantity: 1 },
        { channelLineId: 'gid-u', variantId: null, quantity: 1 },
      ]);
      expect(
        await shopifyFulfilled(id, [
          { channelLineId: 'gid-m', quantity: 1 },
          { channelLineId: 'gid-u', quantity: 1 },
        ]),
      ).toEqual({ requested: true });
      await runJobs(id, 'post');
      expect(await activeHolds(id)).toEqual([]);

      await confirm(id);
      await expect(run((tx) => moves().markPacked(tx, id, person()))).rejects.toThrow(
        StockAlreadyLeft,
      );
      expect(await activeHolds(id)).toEqual([]);
      expect(
        await run((tx) => intake().linkChannelLineVariant(tx, id, 'gid-u', skuL)),
      ).toMatchObject({ reserved: false });
      expect(await activeHolds(id)).toEqual([]);
      expect(attentionsOf(id)).toContain('shipped_with_unmapped_lines');

      const candidate = await plantWarehouse(api);
      await api.call(manager, 'POST', '/api/orders/hold-open-orders', { locationId: candidate });
      expect(await activeHolds(id)).toEqual([]);
    });

    it('cancelFromChannel while the fulfillment is active: no reversal, the posted pieces await restock', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);

      expect(await runJobs(id, 'after_cancel')).toEqual([
        { afterCancel: 'awaiting_restock', row: 5 },
      ]);
      expect((await linesOf(id)).map((line) => line.awaiting_restock_quantity)).toEqual([2, 1]);
      expect(attentionsOf(id)).toContain('returned_pieces_to_receive');
      expect(await groupsOf(id)).toHaveLength(1);
      // A `found` adjustment of the SKU there is a returned parcel (spec 0011 AC-28): the provider
      // read names the order. The adjustment refusal itself lands with spec 0011's adjustments.
      expect(
        (await stock().pendingFor({ variantIds: [skuM], locationId: shelf })).map(
          (pending) => pending.orderId,
        ),
      ).toContain(id);
      expect(await stock().pendingFor({ variantIds: [skuM], locationId: randomUUID() })).toEqual(
        [],
      );
    });

    it('"Received on the shelf" posts one piece back at the line cost to where it left; the same key moves nothing', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      const [m] = await linesOf(id);
      const key = randomUUID();
      const restock = () =>
        api.call(
          warehouse,
          'POST',
          `/api/orders/${id}/lines/${m?.id as string}/restock`,
          { quantity: 1 },
          { 'Idempotency-Key': key },
        );

      const first = await restock();
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const page = OrderDetail.parse(first.body);
      expect(page.lines[0]?.awaitingRestockQuantity).toBe(1);
      const groups = await groupsOf(id, 'returned_to_origin_restock');
      expect(groups).toHaveLength(1);
      expect(await movementsOf(groups[0]?.id as string)).toEqual([
        { source_line_id: m?.id, quantity: 1, location_id: shelf, unit_cost: '100.0000' },
      ]);
      const [entry] = await auditOf(id, 'order.awaiting_restocked');
      expect(entry).toMatchObject({
        reason: 'received_on_shelf',
        after: { lineId: m?.id, awaitingRestockQuantity: 1, restockedQuantity: 1 },
      });

      const again = await restock();
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(await groupsOf(id, 'returned_to_origin_restock')).toHaveLength(1);
      expect((await linesOf(id))[0]?.awaiting_restock_quantity).toBe(1);

      // No header: 400; more than awaits: 409 NOTHING_AWAITING and no movement.
      const keyless = await api.call(
        warehouse,
        'POST',
        `/api/orders/${id}/lines/${m?.id as string}/restock`,
        { quantity: 1 },
      );
      expect(keyless.status).toBe(400);
      const tooMany = await api.call(
        warehouse,
        'POST',
        `/api/orders/${id}/lines/${m?.id as string}/restock`,
        { quantity: 2 },
        { 'Idempotency-Key': randomUUID() },
      );
      expect(tooMany.status).toBe(409);
      expect((tooMany.body as { code: string }).code).toBe('NOTHING_AWAITING');
      expect(await groupsOf(id, 'returned_to_origin_restock')).toHaveLength(1);
    });

    it('the same cancel with no carrier delivery: the same awaiting result (the Bosta source is never runnable today)', async () => {
      const id = await postedShopifyOrder();
      expect((await orderOf(id)).carrier_delivery_created_at).toBeNull();
      await cancelFromChannel(id);

      expect(await runJobs(id, 'after_cancel')).toEqual([
        { afterCancel: 'awaiting_restock', row: 5 },
      ]);
      expect((await linesOf(id)).map((line) => line.awaiting_restock_quantity)).toEqual([2, 1]);
    });

    it('a late carrier shipped closes the awaiting quantities with no movement; still one posting', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      await report(id, fact('shipped'));

      expect((await linesOf(id)).map((line) => line.awaiting_restock_quantity)).toEqual([0, 0]);
      expect(await groupsOf(id)).toHaveLength(1);
      expect(await groupsOf(id, 'returned_to_origin_restock')).toEqual([]);
    });

    it('recordChannelFulfillmentCancelled then cancelFromChannel: one reversal, the after cancel job stops at row 1', async () => {
      const id = await postedShopifyOrder();
      expect(await fulfillmentCancelled(id)).toEqual({ applied: true });
      expect(await orderOf(id)).toMatchObject({
        stock_out_generation: 2,
        stock_out_source: null,
      });
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([null, null]);
      // The open lines are held again (they read short until the reversal posts).
      expect(await activeHolds(id)).toHaveLength(2);
      await cancelFromChannel(id);

      expect(await runJobs(id, 'fulfillment_reversal')).toEqual([{ reversed: true }]);
      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 1 }]);
      const groups = await groupsOf(id);
      expect(groups.map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(id),
        fulfillmentReversalKey(id, 1),
      ]);
      expect(groups[1]?.reverses_group_id).toBe(groups[0]?.id);
      expect((await linesOf(id)).map((line) => line.awaiting_restock_quantity)).toEqual([0, 0]);
      const page = await detail(id);
      expect(page.stockOut).toMatchObject({
        generation: 2,
        source: null,
        reversals: [{ generation: 1, reasonCode: 'channel_fulfillment_cancelled' }],
      });
    });

    it('the fulfillment reversal and the after cancel reversal on one generation: one reversal, the other stops', async () => {
      const first = await postedShopifyOrder();
      // Security review low: a fulfillment reversal of a generation the order is still on skips.
      expect(await posting().fulfillmentReversal({ orderId: first, generation: 1 })).toEqual({
        reversed: false,
        why: 'NOT_MOVED_ON',
      });
      expect(await fulfillmentCancelled(first)).toEqual({ applied: true });
      expect(await runJobs(first, 'fulfillment_reversal')).toEqual([{ reversed: true }]);
      await report(first, fact('cancelled', 'carrier.terminated_before_pickup'));
      // The fulfillment cancel moved the order on, so the after cancel job meets row 1.
      expect(await runJobs(first, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 1 }]);
      expect(await groupsOf(first)).toHaveLength(2);

      const second = await postedShopifyOrder();
      await report(second, fact('cancelled', 'carrier.terminated_before_pickup'));
      expect(await runJobs(second, 'after_cancel')).toEqual([{ afterCancel: 'reversed', row: 4 }]);
      expect(await posting().fulfillmentReversal({ orderId: second, generation: 1 })).toEqual({
        reversed: false,
        why: 'ALREADY_REVERSED',
      });
      expect((await groupsOf(second)).map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(second),
        cancelReversalKey(second, 1),
      ]);
    });

    it('recordChannelFulfillmentCancelled after a carrier shipped answers after_pickup and changes nothing', async () => {
      const id = await postedShopifyOrder();
      await report(id, fact('shipped'));
      const before = await orderOf(id);

      expect(await fulfillmentCancelled(id)).toEqual({ applied: false, why: 'after_pickup' });
      expect(await orderOf(id)).toEqual(before);
      expect((await jobsOf(id)).map((queued) => queued.data.kind)).toEqual(['post', 'post']);
    });

    it('a cancel before the post job ran posts nothing', async () => {
      const id = await postedShopifyOrderUnposted();
      await cancelFromChannel(id);

      expect(await runJobs(id, 'post')).toEqual([{ posted: false, why: 'CANCELLED' }]);
      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 1 }]);
      expect(await groupsOf(id)).toEqual([]);
    });

    it('the carrier terminated before pickup after a Shopify stock out: one reversal, generation 2', async () => {
      const id = await postedShopifyOrder();
      await report(id, fact('cancelled', 'carrier.terminated_before_pickup'));

      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'reversed', row: 4 }]);
      expect(await orderOf(id)).toMatchObject({ stock_out_generation: 2, stock_out_source: null });
      const reversal = (await groupsOf(id))[1];
      expect(reversal?.idempotency_key).toBe(cancelReversalKey(id, 1));
      const page = await detail(id);
      expect(page.stockOut?.reversals).toEqual([
        expect.objectContaining({ generation: 1, reasonCode: 'order_cancelled_before_pickup' }),
      ]);
    });

    it('a cancelled fulfillment with no carrier delivery clears the freeze; a size edit applies; a new fulfillment posts under :2', async () => {
      const id = await channelOrder();
      await confirm(id);
      const firstAt = new Date(Date.now() - 60_000);
      await run((tx) =>
        moves().recordCarrierDelivery(
          tx,
          id,
          { at: firstAt, source: { type: 'shopify_fulfillment', id: randomUUID() } },
          job(),
        ),
      );
      await shopifyFulfilled(id);
      await runJobs(id, 'post');
      expect((await orderOf(id)).carrier_delivery_created_at).not.toBeNull();

      expect(await fulfillmentCancelled(id)).toEqual({ applied: true });
      expect((await orderOf(id)).carrier_delivery_created_at).toBeNull();
      const [cleared] = await auditOf(id, 'order.carrier_delivery_cleared');
      expect(cleared).toMatchObject({
        reason: 'channel_fulfillment_cancelled',
        actor_kind: 'system_job',
      });
      await runJobs(id, 'fulfillment_reversal');

      // The size swap arrives as a normal edit: M replaced by L.
      const [m] = await linesOf(id);
      const page = await detail(id);
      const edit = await api.call(support, 'POST', `/api/orders/${id}/edits`, {
        expectedUpdatedAt: page.updatedAt,
        reasonCode: 'size_change',
        operations: [
          {
            kind: 'replace_line',
            lineId: m?.id,
            variantId: skuL,
            quantity: 2,
            unitPrice: '500.00',
          },
        ],
      });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      const swapped = (await linesOf(id)).find(
        (line) => line.line_state === 'open' && line.quantity === 2,
      );
      expect(swapped?.variant_id).toBe(skuL);
      await owner(`UPDATE order_lines SET channel_line_id = 'gid-m2' WHERE id = $1::uuid`, [
        swapped?.id,
      ]);

      const secondAt = new Date();
      await run((tx) =>
        moves().recordCarrierDelivery(
          tx,
          id,
          { at: secondAt, source: { type: 'shopify_fulfillment', id: randomUUID() } },
          job(),
        ),
      );
      expect((await orderOf(id)).carrier_delivery_created_at?.toISOString()).toBe(
        secondAt.toISOString(),
      );
      expect(
        await shopifyFulfilled(id, [
          { channelLineId: 'gid-m2', quantity: 2 },
          { channelLineId: 'gid-l', quantity: 1 },
        ]),
      ).toEqual({ requested: true });
      expect(await runJobs(id, 'post')).toEqual([
        { posted: false, why: 'OLD_GENERATION' },
        expect.objectContaining({ posted: true, lines: 2 }),
      ]);
      const groups = await groupsOf(id);
      expect(groups.map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(id),
        fulfillmentReversalKey(id, 1),
        carrierShipmentKey(id, 2),
      ]);
      expect(carrierShipmentKey(id, 2)).toBe(`order_shipment:${id}:2`);
      const posted = await movementsOf(groups[2]?.id as string);
      expect(posted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source_line_id: swapped?.id, quantity: -2 }),
        ]),
      );
    });

    it('"Post what Shopify fulfilled" for 2 of 3 pieces posts 2, and a later cancel awaits at most 2', async () => {
      const id = await channelOrder([{ channelLineId: 'gid-m', variantId: skuM, quantity: 3 }]);
      await confirm(id);
      await shopifyFulfilled(id, [{ channelLineId: 'gid-m', quantity: 2 }]);
      const [m] = await linesOf(id);
      await run(async (tx) =>
        stock().postChannelFulfillment(
          tx,
          id,
          {
            reasonCode: 'shopify_fulfilled_less',
            expectedUpdatedAt: (await orderOf(id)).updated_at,
            fulfilled: [{ lineId: m?.id as string, quantity: 2 }],
          },
          person(),
        ),
      );
      expect((await linesOf(id))[0]?.stock_out_quantity).toBe(2);
      await runJobs(id, 'post');
      const [group] = await groupsOf(id);
      expect((await movementsOf(group?.id as string)).map((row) => row.quantity)).toEqual([-2]);
      // The rest of the line's hold was released in the posting.
      expect(await activeHolds(id)).toEqual([]);

      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      expect((await linesOf(id))[0]?.awaiting_restock_quantity).toBe(2);
    });

    it('recordChannelReturn of one of three lines, marked to restock or not, puts that line on the awaiting list', async () => {
      const id = await channelOrder([
        { channelLineId: 'gid-a', variantId: skuM, quantity: 1 },
        { channelLineId: 'gid-b', variantId: skuL, quantity: 1 },
        { channelLineId: 'gid-c', variantId: skuM, quantity: 1 },
      ]);
      await confirm(id);
      await shopifyFulfilled(id, [
        { channelLineId: 'gid-a', quantity: 1 },
        { channelLineId: 'gid-b', quantity: 1 },
        { channelLineId: 'gid-c', quantity: 1 },
      ]);
      await runJobs(id, 'post');
      const refund = randomUUID();

      expect(
        await run((tx) =>
          stock().recordChannelReturn(
            tx,
            id,
            {
              lines: [{ channelLineId: 'gid-b', quantity: 1 }],
              source: { type: 'shopify_refund', id: refund },
              markedToRestock: false,
            },
            job(),
          ),
        ),
      ).toMatchObject({ applied: true });
      expect((await linesOf(id)).map((line) => line.awaiting_restock_quantity)).toEqual([0, 1, 0]);
      expect(
        attentions
          .filter((a) => a.orderId === id && a.kind === 'returned_pieces_to_receive')
          .map((a) => [a.sourceType, a.sourceId]),
      ).toEqual([['shopify_refund_no_restock', refund]]);

      // Marked to restock: the same list, the source says so; never more than was posted.
      await run((tx) =>
        stock().recordChannelReturn(
          tx,
          id,
          {
            lines: [
              { channelLineId: 'gid-c', quantity: 1 },
              { channelLineId: 'gid-b', quantity: 1 },
            ],
            source: { type: 'shopify_return', id: randomUUID() },
          },
          job(),
        ),
      );
      expect((await linesOf(id)).map((line) => line.awaiting_restock_quantity)).toEqual([0, 1, 1]);
      // A carrier shipped order's return stays with features 21, 34, and 35.
      const carried = await channelOrder();
      await confirm(carried);
      await report(carried, fact('shipped'));
      expect(
        await run((tx) =>
          stock().recordChannelReturn(
            tx,
            carried,
            {
              lines: [{ channelLineId: 'gid-m', quantity: 1 }],
              source: { type: 'shopify_refund', id: randomUUID() },
            },
            job(),
          ),
        ),
      ).toEqual({ applied: false, why: 'not_shopify_stock_out' });
    });

    it('a warehouse hat sends a close request; a manager closes with lost_by_carrier; neither posts a movement', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      const [m] = await linesOf(id);
      const path = `/api/orders/${id}/lines/${m?.id as string}/close-awaiting-restock`;
      const movementsBefore = await groupsOf(id, 'returned_to_origin_restock');

      const requested = await api.call(warehouse, 'POST', path, {
        expectedUpdatedAt: (await detail(id)).updatedAt,
        quantity: 1,
        reasonCode: 'lost_by_carrier',
      });
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      expect((await linesOf(id))[0]?.awaiting_restock_quantity).toBe(2);
      expect(attentionsOf(id)).toContain('awaiting_restock_close_requested');
      expect(await auditOf(id, 'order.awaiting_restock_close_requested')).toEqual([
        expect.objectContaining({
          reason: 'lost_by_carrier',
          after: { lineId: m?.id, awaitingRestockQuantity: 2, requestedQuantity: 1 },
        }),
      ]);

      const stale = await api.call(manager, 'POST', path, {
        expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
        quantity: 1,
        reasonCode: 'lost_by_carrier',
      });
      expect(stale.status).toBe(409);
      expect((stale.body as { code: string }).code).toBe('STALE_RECORD');

      const closed = await api.call(manager, 'POST', path, {
        expectedUpdatedAt: (await detail(id)).updatedAt,
        quantity: 1,
        reasonCode: 'lost_by_carrier',
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect((await linesOf(id))[0]?.awaiting_restock_quantity).toBe(1);
      expect(await auditOf(id, 'order.awaiting_restock_closed')).toEqual([
        expect.objectContaining({
          reason: 'lost_by_carrier',
          after: { lineId: m?.id, awaitingRestockQuantity: 1, closedQuantity: 1 },
        }),
      ]);
      expect(await groupsOf(id, 'returned_to_origin_restock')).toEqual(movementsBefore);

      const tooMany = await api.call(manager, 'POST', path, {
        expectedUpdatedAt: (await detail(id)).updatedAt,
        quantity: 5,
        reasonCode: 'other',
      });
      expect((tooMany.body as { code: string }).code).toBe('NOTHING_AWAITING');
      // A hat with neither permission is refused before the body is read.
      const denied = await api.call(support, 'POST', path, {});
      expect(denied.status).toBe(403);
    });

    it('a line awaiting 10 operating days raises awaiting_restock_overdue once', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      const overdue = () =>
        attentions.filter((a) => a.orderId === id && a.kind === 'awaiting_restock_overdue');
      const since = (days: number) =>
        owner(
          `UPDATE order_lines SET awaiting_restock_since = now() - make_interval(days => $2)
           WHERE order_id = $1::uuid AND awaiting_restock_quantity > 0`,
          [id, days],
        );

      await since(9);
      await posting().awaitingRestockOverdue();
      expect(overdue()).toEqual([]);
      await since(10);
      await posting().awaitingRestockOverdue();
      const [m, l] = await linesOf(id);
      expect(overdue().map((a) => a.sourceId)).toEqual([m?.id, l?.id]);
      await since(11);
      await posting().awaitingRestockOverdue();
      expect(overdue()).toHaveLength(2);
    });

    it('a replacement order linked to an original whose stock out is requested is accepted while the Bosta source is off', async () => {
      const original = await postedShopifyOrder();
      expect((await orderOf(original)).fulfillment_state).toBe('confirmed');
      const reply = await api.call(support, 'POST', '/api/orders', {
        clientRef: randomUUID(),
        storeId: mainStore,
        channelId: manualChannel,
        relatedOrder: { orderId: original, relation: 'replacement_for' },
        shipTo: { name: 'Stock Out Name', phone: phone(), address: '1 Stock Out Street' },
        lines: [{ variantId: skuL, quantity: 1, unitPrice: '500.00' }],
        shippingChargedAmount: '50.00',
        paymentMethod: 'cod',
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      const replacement = await detail(CreatedOrder.parse(reply.body).id);
      expect(replacement.type).toBe('exchange_replacement');

      // An original with no stock out and not past packed is still refused.
      const plain = await manualOrder();
      const refused = await api.call(support, 'POST', '/api/orders', {
        clientRef: randomUUID(),
        storeId: mainStore,
        channelId: manualChannel,
        relatedOrder: { orderId: plain, relation: 'replacement_for' },
        shipTo: { name: 'Stock Out Name', phone: phone(), address: '1 Stock Out Street' },
        lines: [{ variantId: skuL, quantity: 1, unitPrice: '500.00' }],
        shippingChargedAmount: '50.00',
        paymentMethod: 'cod',
      });
      expect((refused.body as { code: string }).code).toBe('RELATED_ORDER_STATE');
    });
  });

  // The owner's rulings of 2026-11-21 on the milestone 5 code and security reviews: every
  // sequence the reviewers listed, plus the counters and the once per spell overdue mark.
  describe('review fixes: the restock cap, the lock re checks, and the refusals (2026-11-21)', () => {
    const channelReturn = (
      id: string,
      lines: { channelLineId: string; quantity: number }[],
      sourceId: string = randomUUID(),
      type: 'shopify_refund' | 'shopify_return' = 'shopify_refund',
    ) =>
      run((tx) =>
        stock().recordChannelReturn(tx, id, { lines, source: { type, id: sourceId } }, job()),
      );
    const restockRoute = (
      id: string,
      lineId: string,
      quantity: number,
      key: string = randomUUID(),
      who: string = warehouse,
    ) =>
      api.call(
        who,
        'POST',
        `/api/orders/${id}/lines/${lineId}/restock`,
        { quantity },
        { 'Idempotency-Key': key },
      );
    /** What the order's postings did to a SKU in total (shipment, restocks, and reversals). */
    const netOf = async (id: string, variantId: string) =>
      (
        await owner<{ net: number }>(
          `SELECT coalesce(sum(m.quantity), 0)::int AS net
           FROM stock_movements m JOIN movement_groups g ON g.id = m.group_id
           WHERE g.source_id = $1::uuid AND m.variant_id = $2::uuid`,
          [id, variantId],
        )
      ).rows[0]?.net;
    const counters = async (id: string) =>
      (await linesOf(id)).map((line) => [
        line.stock_out_quantity,
        line.awaiting_restock_quantity,
        line.restocked_quantity,
        line.closed_quantity,
      ]);

    it('a restock then a fulfillment cancel books back only the rest and raises reversal_after_restock', async () => {
      const id = await postedShopifyOrder();
      expect(await channelReturn(id, [{ channelLineId: 'gid-m', quantity: 1 }])).toMatchObject({
        applied: true,
      });
      const [m, l] = await linesOf(id);
      const restocked = await restockRoute(id, m?.id as string, 1);
      expect(restocked.status, JSON.stringify(restocked.body)).toBe(200);
      expect(await counters(id)).toEqual([
        [2, 0, 1, 0],
        [1, 0, 0, 0],
      ]);

      expect(await fulfillmentCancelled(id)).toEqual({ applied: true });
      // A new generation starts with every counter at 0.
      expect(await counters(id)).toEqual([
        [null, 0, 0, 0],
        [null, 0, 0, 0],
      ]);
      expect(await runJobs(id, 'fulfillment_reversal')).toEqual([{ reversed: true }]);
      const groups = await groupsOf(id);
      expect(groups.map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(id),
        fulfillmentReversalKey(id, 1),
      ]);
      // A partial counter posting, not a reversal of the whole group.
      expect(groups[1]?.reverses_group_id).toBeNull();
      const back = await movementsOf(groups[1]?.id as string);
      expect(back).toHaveLength(2);
      expect(back).toEqual(
        expect.arrayContaining([
          { source_line_id: m?.id, quantity: 1, location_id: shelf, unit_cost: '100.0000' },
          { source_line_id: l?.id, quantity: 1, location_id: shelf, unit_cost: '100.0000' },
        ]),
      );
      // -2 shipped, +1 restocked, +1 booked back: never a phantom piece.
      expect(await netOf(id, skuM)).toBe(0);
      expect(await netOf(id, skuL)).toBe(0);
      expect(attentionsOf(id)).toContain('reversal_after_restock');
      expect((await detail(id)).stockOut?.reversals).toEqual([
        expect.objectContaining({ generation: 1, reasonCode: 'channel_fulfillment_cancelled' }),
      ]);
      // The job is not run twice: the key stops it.
      expect(await posting().fulfillmentReversal({ orderId: id, generation: 1 })).toEqual({
        reversed: false,
        why: 'ALREADY_REVERSED',
      });
    });

    it('everything restocked or closed, then a fulfillment cancel: nothing booked back, the attention raised', async () => {
      const id = await postedShopifyOrder();
      await channelReturn(id, [
        { channelLineId: 'gid-m', quantity: 2 },
        { channelLineId: 'gid-l', quantity: 1 },
      ]);
      const [m, l] = await linesOf(id);
      expect((await restockRoute(id, m?.id as string, 2)).status).toBe(200);
      const closed = await api.call(
        manager,
        'POST',
        `/api/orders/${id}/lines/${l?.id as string}/close-awaiting-restock`,
        { expectedUpdatedAt: (await detail(id)).updatedAt, quantity: 1, reasonCode: 'other' },
      );
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(await counters(id)).toEqual([
        [2, 0, 2, 0],
        [1, 0, 0, 1],
      ]);

      await fulfillmentCancelled(id);
      expect(await runJobs(id, 'fulfillment_reversal')).toEqual([{ reversed: true }]);
      expect(await groupsOf(id)).toHaveLength(1);
      expect(await netOf(id, skuM)).toBe(0);
      expect(attentionsOf(id)).toContain('reversal_after_restock');
    });

    it('row 4 after a restock books back only the rest, raises reversal_after_restock, and moves on', async () => {
      const id = await postedShopifyOrder();
      await channelReturn(id, [{ channelLineId: 'gid-m', quantity: 1 }]);
      const [m] = await linesOf(id);
      expect((await restockRoute(id, m?.id as string, 1)).status).toBe(200);
      await report(id, fact('cancelled', 'carrier.terminated_before_pickup'));

      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'reversed', row: 4 }]);
      const groups = await groupsOf(id);
      expect(groups.map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(id),
        cancelReversalKey(id, 1),
      ]);
      expect((await movementsOf(groups[1]?.id as string)).map((row) => row.quantity)).toEqual([
        1, 1,
      ]);
      expect(await netOf(id, skuM)).toBe(0);
      expect(await netOf(id, skuL)).toBe(0);
      expect(attentionsOf(id)).toContain('reversal_after_restock');
      expect(await orderOf(id)).toMatchObject({ stock_out_generation: 2, stock_out_source: null });
      expect(await counters(id)).toEqual([
        [null, 0, 0, 0],
        [null, 0, 0, 0],
      ]);
    });

    it('a second return after a restock is capped: nothing more awaits', async () => {
      const id = await postedShopifyOrder();
      await channelReturn(id, [{ channelLineId: 'gid-m', quantity: 2 }]);
      const [m] = await linesOf(id);
      expect((await restockRoute(id, m?.id as string, 2)).status).toBe(200);

      expect(
        await channelReturn(
          id,
          [{ channelLineId: 'gid-m', quantity: 2 }],
          randomUUID(),
          'shopify_return',
        ),
      ).toEqual({ applied: false, why: 'nothing_to_await' });
      expect((await counters(id))[0]).toEqual([2, 0, 2, 0]);
      expect(await netOf(id, skuM)).toBe(0);
    });

    it('a repeated refund adds nothing; a return of the same pieces under its own id is capped at what was posted', async () => {
      const id = await postedShopifyOrder();
      const refundId = randomUUID();
      const [m] = await linesOf(id);
      expect(await channelReturn(id, [{ channelLineId: 'gid-m', quantity: 1 }], refundId)).toEqual({
        applied: true,
        lines: [{ lineId: m?.id, added: 1 }],
      });
      expect(await channelReturn(id, [{ channelLineId: 'gid-m', quantity: 1 }], refundId)).toEqual({
        applied: false,
        why: 'already_applied',
      });
      expect((await counters(id))[0]).toEqual([2, 1, 0, 0]);

      expect(
        await channelReturn(
          id,
          [{ channelLineId: 'gid-m', quantity: 2 }],
          randomUUID(),
          'shopify_return',
        ),
      ).toEqual({ applied: true, lines: [{ lineId: m?.id, added: 1 }] });
      expect((await counters(id))[0]).toEqual([2, 2, 0, 0]);
    });

    it('row 5 run again after a restock adds nothing (review minor 4)', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      expect(await runJobs(id, 'after_cancel')).toEqual([
        { afterCancel: 'awaiting_restock', row: 5 },
      ]);
      const [m] = await linesOf(id);
      expect((await restockRoute(id, m?.id as string, 2)).status).toBe(200);

      // A lost completion: pg-boss runs the same job again.
      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 5 }]);
      expect(await counters(id)).toEqual([
        [2, 0, 2, 0],
        [1, 1, 0, 0],
      ]);
    });

    it('a carrier shipped committing while the row 4 job runs: the reversal rolls back (row 3), one posting', async () => {
      const id = await postedShopifyOrder();
      await report(id, fact('cancelled', 'carrier.terminated_before_pickup'));
      const service = ledger();
      const reverse = service.reverse.bind(service);
      const spy = vi.spyOn(service, 'reverse').mockImplementationOnce(async (input, options) => {
        // The courier's late pickup lands between the job's decision and its posting.
        expect(await report(id, fact('shipped'))).toEqual({ applied: true });
        return reverse(input, options);
      });
      try {
        expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 3 }]);
      } finally {
        spy.mockRestore();
      }
      expect(await groupsOf(id)).toHaveLength(1);
      expect(await orderOf(id)).toMatchObject({
        fulfillment_state: 'shipped',
        stock_out_generation: 1,
        stock_out_source: 'shopify_fulfillment',
      });
    });

    it('a fulfillment cancel committing while the post job runs: nothing posts, the open lines stay held', async () => {
      const id = await postedShopifyOrderUnposted();
      const service = ledger();
      const post = service.postCarrierShipment.bind(service);
      const spy = vi
        .spyOn(service, 'postCarrierShipment')
        .mockImplementationOnce(async (input, options) => {
          expect(await fulfillmentCancelled(id)).toEqual({ applied: true });
          return post(input, options);
        });
      try {
        expect(await runJobs(id, 'post')).toEqual([{ posted: false, why: 'OLD_GENERATION' }]);
      } finally {
        spy.mockRestore();
      }
      expect(await groupsOf(id)).toEqual([]);
      expect(await runJobs(id, 'fulfillment_reversal')).toEqual([
        { reversed: false, why: 'NOTHING_POSTED' },
      ]);
      // The reservations the fulfillment cancel held again were not consumed by a rolled back post.
      expect((await activeHolds(id)).map((held) => held.quantity).sort()).toEqual([1, 2]);
      expect((await orderOf(id)).stock_out_generation).toBe(2);
    });

    it('a partial delivery that would leave fewer posted pieces than await is refused with a typed error', async () => {
      const id = await postedShopifyOrder();
      await channelReturn(id, [{ channelLineId: 'gid-m', quantity: 2 }]);
      await report(id, fact('shipped'));
      const [m] = await linesOf(id);

      await expect(
        run((tx) =>
          moves().recordPartialDelivery(
            tx,
            id,
            {
              lines: [{ lineId: m?.id as string, deliveredQuantity: 1 }],
              occurredAt: new Date(),
              source: { type: 'carrier_delivery_event', id: randomUUID() },
            },
            carrier,
          ),
        ),
      ).rejects.toThrow(PiecesAwaitingRestock);
      expect((await orderOf(id)).fulfillment_state).toBe('shipped');
      expect(await linesOf(id)).toHaveLength(2);
    });

    it('a restock key reused with another quantity or person answers 409 IDEMPOTENCY_CONFLICT; the same request replays', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      const [m] = await linesOf(id);
      const key = randomUUID();
      const lineId = m?.id as string;

      expect((await restockRoute(id, lineId, 1, key)).status).toBe(200);
      const otherQuantity = await restockRoute(id, lineId, 2, key);
      expect(otherQuantity.status).toBe(409);
      expect((otherQuantity.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
      const someoneElse = await api.signIn((await api.addPerson(['warehouse'])).email);
      const otherPerson = await restockRoute(id, lineId, 1, key, someoneElse);
      expect(otherPerson.status).toBe(409);
      expect((otherPerson.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
      const replay = await restockRoute(id, lineId, 1, key);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);

      expect(await groupsOf(id, 'returned_to_origin_restock')).toHaveLength(1);
      expect((await counters(id))[0]).toEqual([2, 1, 1, 0]);
    });

    it('a second close request while one is open answers 409 CLOSE_ALREADY_REQUESTED; a manager close settles it', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      const [m] = await linesOf(id);
      const path = `/api/orders/${id}/lines/${m?.id as string}/close-awaiting-restock`;
      const ask = async (who: string) =>
        api.call(who, 'POST', path, {
          expectedUpdatedAt: (await detail(id)).updatedAt,
          quantity: 1,
          reasonCode: 'lost_by_carrier',
        });

      expect((await ask(warehouse)).status).toBe(200);
      const again = await ask(warehouse);
      expect(again.status).toBe(409);
      expect((again.body as { code: string }).code).toBe('CLOSE_ALREADY_REQUESTED');
      expect(
        attentions.filter((a) => a.orderId === id && a.kind === 'awaiting_restock_close_requested'),
      ).toHaveLength(1);

      expect((await ask(manager)).status).toBe(200);
      expect((await counters(id))[0]).toEqual([2, 1, 0, 1]);
      expect((await ask(warehouse)).status).toBe(200);
    });

    it('Pack is refused with 409 STOCK_ALREADY_LEFT once the stock out is requested; Confirm is allowed', async () => {
      const id = await channelOrder();
      expect(await shopifyFulfilled(id)).toEqual({ requested: true });

      const confirmed = await api.call(support, 'POST', `/api/orders/${id}/confirm`, {
        expectedUpdatedAt: (await detail(id)).updatedAt,
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      const packed = await api.call(warehouse, 'POST', `/api/orders/${id}/pack`, {
        expectedUpdatedAt: (await detail(id)).updatedAt,
      });
      expect(packed.status).toBe(409);
      expect((packed.body as { code: string }).code).toBe('STOCK_ALREADY_LEFT');
      expect((await orderOf(id)).fulfillment_state).toBe('confirmed');
    });

    it('the overdue check catches up a missed day and raises a line once per awaiting spell', async () => {
      const id = await postedShopifyOrder();
      await cancelFromChannel(id);
      await runJobs(id, 'after_cancel');
      const [m, l] = await linesOf(id);
      const overdue = () =>
        attentions.filter((a) => a.orderId === id && a.kind === 'awaiting_restock_overdue');
      const marks = async () =>
        (
          await owner<{ raised: boolean }>(
            `SELECT awaiting_restock_overdue_raised_at IS NOT NULL AS raised
             FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
            [id],
          )
        ).rows.map((row) => row.raised);
      // The schedule did not run on the tenth day: day 12 still raises both lines.
      await owner(
        `UPDATE order_lines SET awaiting_restock_since = now() - make_interval(days => 12)
         WHERE order_id = $1::uuid AND awaiting_restock_quantity > 0`,
        [id],
      );
      await posting().awaitingRestockOverdue();
      expect(overdue().map((a) => a.sourceId)).toEqual([m?.id, l?.id]);
      await posting().awaitingRestockOverdue();
      expect(overdue()).toHaveLength(2);
      expect(await marks()).toEqual([true, true]);

      // The L line's spell ends when its last piece is back: its mark clears with it.
      expect((await restockRoute(id, l?.id as string, 1)).status).toBe(200);
      expect(await marks()).toEqual([true, false]);
    });
  });

  describe('seen: the order page, the list flag, and the Awaiting restock filter (AC-27 g, AC-5)', () => {
    it('the page shows the stock out source and time, and each line its posted and awaiting quantities', async () => {
      const id = await postedShopifyOrder();
      const page = await detail(id);

      expect(page.stockOut).toMatchObject({
        generation: 1,
        source: 'shopify_fulfillment',
        reversals: [],
      });
      expect(page.stockOut?.requestedAt).not.toBeNull();
      expect(page.stockOut?.postedAt).not.toBeNull();
      expect(
        page.lines.map((line) => [line.stockOutQuantity, line.awaitingRestockQuantity]),
      ).toEqual([
        [2, 0],
        [1, 0],
      ]);
    });

    it('the filter lists cancelled orders first, then the oldest awaiting, with keyset pages and the list flag', async () => {
      const older = await postedShopifyOrder();
      await cancelFromChannel(older);
      await runJobs(older, 'after_cancel');
      const returned = await postedShopifyOrder();
      await run((tx) =>
        stock().recordChannelReturn(
          tx,
          returned,
          {
            lines: [{ channelLineId: 'gid-l', quantity: 1 }],
            source: { type: 'shopify_return', id: randomUUID() },
          },
          job(),
        ),
      );
      const newer = await postedShopifyOrder();
      await cancelFromChannel(newer);
      await runJobs(newer, 'after_cancel');
      // The returned order's line awaits longest, but it is not cancelled: it comes after both.
      await owner(
        `UPDATE order_lines SET awaiting_restock_since = now() - interval '2 days'
         WHERE order_id = $1::uuid AND awaiting_restock_quantity > 0`,
        [returned],
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor
          ? `?awaitingRestock=true&limit=1&cursor=${cursor}`
          : '?awaitingRestock=true&limit=1';
        const reply = await api.call(manager, 'GET', `/api/orders${query}`);
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        const page = OrderListResponse.parse(reply.body);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      const ours = seen.filter((id) => [older, returned, newer].includes(id));
      expect(ours).toEqual([older, newer, returned]);
      expect(new Set(seen).size).toBe(seen.length);

      const list = OrderListResponse.parse(
        (await api.call(manager, 'GET', '/api/orders?awaitingRestock=true&limit=100')).body,
      );
      const row = list.items.find((item) => item.id === older);
      expect(row).toMatchObject({
        stockOutSource: 'shopify_fulfillment',
        awaitingRestockQuantity: 3,
      });
      expect(row?.stockOutRequestedAt).not.toBeNull();
      const none = OrderListResponse.parse(
        (await api.call(manager, 'GET', '/api/orders?awaitingRestock=false&limit=100')).body,
      );
      expect(none.items.map((item) => item.id)).not.toContain(older);
      const bad = await api.call(manager, 'GET', '/api/orders?awaitingRestock=true&cursor=abc');
      expect(bad.status).toBe(400);
    });

    it('fulfillment_partial_stale is raised for the warehouse from the connectors event', async () => {
      const id = await channelOrder();
      const connectionId = randomUUID();
      await run((tx) => stock().raiseFulfillmentPartialStale(tx, { orderId: id, connectionId }));

      expect(
        attentions
          .filter((a) => a.orderId === id && a.kind === 'fulfillment_partial_stale')
          .map((a) => [a.sourceType, a.sourceId]),
      ).toEqual([['connection', connectionId]]);
    });
  });

  it('puts awaiting pieces of a restock on the shelf through feature 20 and 21 calls too (scanned)', async () => {
    const id = await postedShopifyOrder();
    await cancelFromChannel(id);
    await runJobs(id, 'after_cancel');
    const [, l] = await linesOf(id);

    const result = await stock().restockAwaiting(
      id,
      l?.id as string,
      1,
      randomUUID(),
      { type: 'system_job', job: 'scan', jobId: randomUUID() },
      'scanned',
    );

    expect(result.replayed).toBe(false);
    expect((await linesOf(id))[1]).toMatchObject({
      awaiting_restock_quantity: 0,
      awaiting_restock_since: null,
    });
    expect((await auditOf(id, 'order.awaiting_restocked'))[0]?.reason).toBe('scanned');
  });
});
