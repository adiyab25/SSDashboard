import { randomUUID } from 'node:crypto';
import { CreatedOrder, SkuDetail, carrierShipmentKey } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import type { OrderActor } from '../src/orders/order-actor.js';
import { OrderTransactions, type OrderTransaction } from '../src/orders/order-transactions.js';
import { OrderAttentionRaised } from '../src/orders/orders.events.js';
import {
  POST_SHIPMENT_RETRY,
  cancelReversalKey,
  type PostShipmentJobData,
} from '../src/orders/shipment/post-shipment.queue.js';
import { ShipmentPosting } from '../src/orders/shipment/shipment-posting.js';
import {
  OrderTransitions,
  type ShipmentFact,
} from '../src/orders/transitions/order-transitions.service.js';
import { OrderWriter } from '../src/orders/writer/order-writer.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { makeOnline, putOnShelf, stockedOnline } from './order-stock.js';

/** A line row as the assertions read it. */
interface LineRow extends Record<string, unknown> {
  id: string;
  position: number;
  variant_id: string | null;
  quantity: number;
  line_state: string;
  unit_cost: string | null;
  stock_out_quantity: number | null;
  awaiting_restock_quantity: number;
  awaiting_restock_since: Date | null;
  split_from_line_id: string | null;
}

/** An order's stock out columns. */
interface StockOutRow extends Record<string, unknown> {
  fulfillment_state: string;
  stock_out_generation: number;
  stock_out_source: string | null;
  stock_out_requested_at: Date | null;
}

/** A queued `orders.post_shipment` job. */
interface JobRow extends Record<string, unknown> {
  id: string;
  data: PostShipmentJobData & { capability: string };
  group_id: string | null;
}

// Spec 0013 milestone 5 task 15 (AC-15, AC-24, AC-27 b): the `orders.post_shipment` job and the
// stock side of the carrier facts, in process, as the application role on a scratch database. A
// carrier `shipped` fact records the stock out request and enqueues the posting job in its own
// transaction; the job (run here through `ShipmentPosting`, the work the worker's handler calls)
// books one `order_shipment` per generation through `LedgerService.postCarrierShipment`, writes
// `unit_cost`, never posts twice, and raises its attentions; every cancel enqueues the after
// cancel job, which decides by the *After a cancel* table.
describe('orders, task 15: the shipment posting job', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let supportId = '';
  let mainStore = '';
  let manualChannel = '';
  let skuM = '';
  let skuL = '';
  let skuScarce = '';
  let shelf = '';
  let n = 0;
  const attentions: OrderAttentionRaised[] = [];

  const carrier: OrderActor = { type: 'carrier', connectionId: randomUUID() };
  const person = () => ({ type: 'person' as const, userId: supportId, hat: 'support' });
  const run = <T>(work: (tx: OrderTransaction) => Promise<T>) =>
    api.app.get(OrderTransactions).run(work);
  const moves = () => api.app.get(OrderTransitions);
  const posting = () => api.app.get(ShipmentPosting);
  const ledger = () => api.app.get(LedgerService);
  const owner = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    api.owner.pool.query<T>(text, params);

  const phone = () => {
    n += 1;
    return `0104${String(1_000_000 + n)}`;
  };

  /** Creates a COD order through the route (2 M and 1 L unless told otherwise) and answers its id. */
  const create = async (lines?: { variantId: string; quantity: number }[]) => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Shipment Name', phone: phone(), address: '1 Shipment Street' },
      lines: (
        lines ?? [
          { variantId: skuM, quantity: 2 },
          { variantId: skuL, quantity: 1 },
        ]
      ).map((line) => ({ ...line, unitPrice: '500.00' })),
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return CreatedOrder.parse(reply.body).id;
  };

  const fact = (to: ShipmentFact['to'], reasonCode?: string): ShipmentFact => ({
    to,
    occurredAt: new Date(),
    reasonCode: reasonCode ?? null,
    source: { type: 'carrier_delivery_event', id: randomUUID() },
  });
  const report = (id: string, f: ShipmentFact) =>
    run((tx) => moves().recordShipmentFact(tx, id, f, carrier));
  const confirm = (id: string) => run((tx) => moves().confirm(tx, id, person()));
  const cancel = (id: string) =>
    run((tx) => moves().cancel(tx, id, { reasonCode: 'customer_cancelled' }, person()));

  const jobsOf = async (id: string) =>
    (
      await owner<JobRow>(
        `SELECT id, data, group_id FROM pgboss.job
         WHERE name = 'orders.post_shipment' AND data->>'orderId' = $1 ORDER BY created_on, id`,
        [id],
      )
    ).rows;
  /** Runs every queued job of the order once, in order, as a first attempt; answers the outputs. */
  const runJobs = async (id: string, kind?: PostShipmentJobData['kind']) => {
    const outputs: object[] = [];
    for (const job of await jobsOf(id)) {
      if (kind && job.data.kind !== kind) continue;
      outputs.push(await posting().run({ id: job.id, data: job.data, retryCount: 0 }));
    }
    return outputs;
  };
  const linesOf = async (id: string) =>
    (
      await owner<LineRow>(
        `SELECT id, position, variant_id, quantity, line_state, unit_cost, stock_out_quantity,
                awaiting_restock_quantity, awaiting_restock_since, split_from_line_id
         FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [id],
      )
    ).rows;
  const stockOutOf = async (id: string) =>
    (
      await owner<StockOutRow>(
        `SELECT fulfillment_state, stock_out_generation, stock_out_source, stock_out_requested_at
         FROM orders WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0] as StockOutRow;
  const groupsOf = async (id: string) =>
    (
      await owner<{ id: string; idempotency_key: string; reverses_group_id: string | null }>(
        `SELECT id, idempotency_key, reverses_group_id FROM movement_groups
         WHERE source_type = 'order_shipment' AND source_id = $1::uuid ORDER BY recorded_at, id`,
        [id],
      )
    ).rows;
  const movementsOf = async (groupId: string) =>
    (
      await owner<{ source_line_id: string; quantity: number; location_id: string }>(
        `SELECT source_line_id, quantity, location_id FROM stock_movements
         WHERE group_id = $1::uuid ORDER BY quantity, source_line_id`,
        [groupId],
      )
    ).rows;
  const reservationsOf = async (id: string) =>
    ledger().reservationsFor({ sourceType: 'order', sourceId: id });
  const attentionsOf = (id: string) =>
    attentions.filter((a) => a.orderId === id).map((a) => a.kind);

  /** Records a Shopify fulfillment's stock out request as feature 13's call will (AC-27 a). */
  const shopifyStockOut = async (id: string) => {
    const writer = api.app.get(OrderWriter);
    await run(async (tx) => {
      await writer.lockOrder(tx, id);
      const lines = await linesOf(id);
      await writer.requestStockOut(tx, id, {
        source: 'shopify_fulfillment',
        at: new Date(),
        lines: lines.map((line) => ({ lineId: line.id, quantity: line.quantity })),
      });
    });
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    const supportPerson = await api.addPerson(['support']);
    supportId = supportPerson.id;
    support = await api.signIn(supportPerson.email);
    const manager = await api.signIn((await api.addPerson(['manager'])).email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    const sku = async (code: string) => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '500.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };
    skuM = await sku('SP-M');
    skuL = await sku('SP-L');
    skuScarce = await sku('SP-S');
    shelf = await stockedOnline(api, [skuM, skuL]);
    await putOnShelf(api, shelf, [skuScarce], 1);
    api.app
      .get(DomainEvents)
      .on(OrderAttentionRaised, (_tx, e) => void attentions.push(e), 'orders-shipment-e2e');
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('a carrier shipped fact (AC-15, AC-24)', () => {
    it('records the stock out request and enqueues one posting job in its group, in the move', async () => {
      const id = await create();
      await confirm(id);
      const shipped = fact('shipped');
      await report(id, shipped);

      const order = await stockOutOf(id);
      expect(order).toMatchObject({
        fulfillment_state: 'shipped',
        stock_out_generation: 1,
        stock_out_source: 'carrier_shipped',
      });
      expect(order.stock_out_requested_at?.toISOString()).toBe(shipped.occurredAt.toISOString());
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([2, 1]);
      const jobs = await jobsOf(id);
      expect(jobs.map((job) => job.data)).toEqual([
        { kind: 'post', orderId: id, generation: 1, capability: 'orders.shipment_posting' },
      ]);
      expect(jobs[0]?.group_id).toBe(id.toLowerCase());
    });

    it('posts the order_shipment from the lines, fulfils the reservations, and writes unit_cost', async () => {
      const id = await create();
      await confirm(id);
      expect((await reservationsOf(id)).map((held) => held.status)).toEqual(['active', 'active']);
      await report(id, fact('shipped'));

      const [output] = await runJobs(id);
      const groups = await groupsOf(id);
      const lines = await linesOf(id);

      expect(output).toMatchObject({ posted: true, lines: 2 });
      expect(groups.map((group) => group.idempotency_key)).toEqual([carrierShipmentKey(id)]);
      expect(await movementsOf(groups[0]?.id as string)).toEqual(
        [
          { source_line_id: lines[0]?.id, quantity: -2, location_id: shelf },
          { source_line_id: lines[1]?.id, quantity: -1, location_id: shelf },
        ].sort((a, b) => a.quantity - b.quantity),
      );
      expect((await reservationsOf(id)).map((held) => held.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      expect(lines.map((line) => line.unit_cost)).toEqual(['100.0000', '100.0000']);
    });

    it('a retried job posts nothing twice: it stops at postingFor', async () => {
      const id = await create();
      await confirm(id);
      await report(id, fact('shipped'));
      await runJobs(id);
      const again = await runJobs(id);

      expect(again).toEqual([{ posted: false, why: 'ALREADY_POSTED' }]);
      expect(await groupsOf(id)).toHaveLength(1);
    });

    it('posts a short line all the same, and the carrier fact never waits on stock', async () => {
      const first = await create([{ variantId: skuScarce, quantity: 1 }]);
      const short = await create([{ variantId: skuScarce, quantity: 2 }]);
      expect((await reservationsOf(short))[0]?.unfilledQuantity).toBe(2);

      expect(await report(short, fact('shipped'))).toEqual({ applied: true });
      const [output] = await runJobs(short);
      const [group] = await groupsOf(short);

      expect(output).toMatchObject({ posted: true });
      expect(await movementsOf(group?.id as string)).toEqual([
        expect.objectContaining({ quantity: -2, location_id: shelf }),
      ]);
      // The other order's held piece was taken: the ledger shortened it (spec 0011 AC-22).
      expect(attentionsOf(first)).toContain('reservation_shortened');
    });

    it('enqueues nothing for a pack: markPacked posts no stock', async () => {
      const id = await create();
      await confirm(id);
      await run((tx) => moves().markPacked(tx, id, person()));

      expect(await jobsOf(id)).toEqual([]);
      expect((await stockOutOf(id)).stock_out_source).toBeNull();
    });

    it('a partial delivery after the posting keeps unit_cost and splits the stock out quantity', async () => {
      const id = await create();
      await confirm(id);
      await report(id, fact('shipped'));
      await runJobs(id);
      const [m] = await linesOf(id);
      await run((tx) =>
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
      );
      const lines = await linesOf(id);

      expect(
        lines.map((line) => [
          line.quantity,
          line.stock_out_quantity,
          line.unit_cost,
          line.line_state,
        ]),
      ).toEqual([
        [1, 1, '100.0000', 'delivered'],
        [1, 1, '100.0000', 'delivered'],
        [1, 1, '100.0000', 'returned_to_origin'],
      ]);
      expect(lines[2]?.split_from_line_id).toBe(m?.id);
    });
  });

  describe('the attentions of the posting (AC-24)', () => {
    it('skips an unmapped line with shipped_with_unmapped_lines and posts the rest', async () => {
      const id = await create([{ variantId: skuM, quantity: 1 }]);
      await confirm(id);
      // An unmapped line as a channel order carries it (no variant, no reservation).
      await owner(
        `INSERT INTO order_lines (order_id, position, variant_id, title, quantity, unit_price,
                                  net_amount, tax_rate, tax_amount, gross_amount)
         VALUES ($1::uuid, 2, NULL, 'Unmapped tee', 1, 0, 0, 0, 0, 0)`,
        [id],
      );
      await report(id, fact('shipped'));
      const [output] = await runJobs(id);
      const [group] = await groupsOf(id);

      expect(output).toMatchObject({ posted: true, lines: 1 });
      expect(await movementsOf(group?.id as string)).toHaveLength(1);
      expect(attentionsOf(id)).toEqual(['shipped_with_unmapped_lines']);
      // A retry stops at postingFor and raises nothing again.
      await runJobs(id);
      expect(attentionsOf(id)).toEqual(['shipped_with_unmapped_lines']);
    });

    it('a line with no reservation and no online location raises shipment_not_posted', async () => {
      await owner('UPDATE locations SET sellable_online = false WHERE sellable_online');
      try {
        const id = await create([{ variantId: skuM, quantity: 1 }]);
        expect(await reservationsOf(id)).toEqual([]);
        await report(id, fact('shipped'));
        const [line] = await linesOf(id);
        const [output] = await runJobs(id);

        expect(output).toEqual({ posted: false, why: 'NOTHING_TO_POST' });
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

    it('a race on the key (IdempotencyConflict) posts nothing and raises shipment_not_posted', async () => {
      const id = await create();
      await confirm(id);
      await report(id, fact('shipped'));
      const [m] = await linesOf(id);
      // Another job posted other lines under the key between this job's read and its post.
      await ledger().postCarrierShipment({
        orderId: id,
        lines: [{ sourceLineId: m?.id as string, variantId: skuM, locationId: shelf, quantity: 1 }],
      });
      const read = vi.spyOn(ledger(), 'postingFor').mockResolvedValueOnce(null);
      try {
        const [output] = await runJobs(id);
        expect(output).toEqual({ posted: false, why: 'IDEMPOTENCY_CONFLICT' });
      } finally {
        read.mockRestore();
      }
      expect(await groupsOf(id)).toHaveLength(1);
      expect(attentionsOf(id)).toEqual(['shipment_not_posted']);
    });

    it('a failure is retried, and the last attempt raises shipment_not_posted instead', async () => {
      const id = await create();
      await confirm(id);
      await report(id, fact('shipped'));
      const [job] = await jobsOf(id);
      const failing = vi
        .spyOn(ledger(), 'postCarrierShipment')
        .mockRejectedValue(new Error('connection lost'));
      try {
        await expect(
          posting().run({ id: job?.id as string, data: job?.data as object, retryCount: 0 }),
        ).rejects.toThrow('connection lost');
        expect(attentionsOf(id)).toEqual([]);
        const last = await posting().run({
          id: job?.id as string,
          data: job?.data as object,
          retryCount: POST_SHIPMENT_RETRY.retryLimit,
        });
        expect(last).toEqual({ posted: false, why: 'FAILED_AFTER_RETRIES' });
      } finally {
        failing.mockRestore();
      }
      expect(attentionsOf(id)).toEqual(['shipment_not_posted']);
      expect(await groupsOf(id)).toEqual([]);
    });

    it('does nothing for a job of an older generation or a cancelled order', async () => {
      const id = await create();
      await confirm(id);
      await report(id, fact('shipped'));

      expect(
        await posting().post(
          { orderId: id, generation: 2 },
          { jobId: randomUUID(), retryCount: 0 },
        ),
      ).toEqual({ posted: false, why: 'OLD_GENERATION' });

      const cancelled = await create();
      await confirm(cancelled);
      await cancel(cancelled);
      expect(
        await posting().post(
          { orderId: cancelled, generation: 1 },
          { jobId: randomUUID(), retryCount: 0 },
        ),
      ).toEqual({ posted: false, why: 'CANCELLED' });
    });
  });

  describe('after a cancel (AC-27 b, the After a cancel table)', () => {
    it('every cancel enqueues the after cancel job; with nothing posted it does nothing (row 1)', async () => {
      const id = await create();
      await confirm(id);
      await cancel(id);

      expect((await jobsOf(id)).map((job) => job.data)).toEqual([
        {
          kind: 'after_cancel',
          orderId: id,
          generation: 1,
          origin: 'person',
          reasonCode: 'customer_cancelled',
          capability: 'orders.shipment_posting',
        },
      ]);
      expect(await runJobs(id)).toEqual([{ afterCancel: 'nothing', row: 1 }]);
      expect((await reservationsOf(id)).map((held) => held.status)).toEqual([
        'released',
        'released',
      ]);
    });

    it('the carrier terminated before pickup after a Shopify stock out: one reversal, generation 2 (row 4)', async () => {
      const id = await create();
      await confirm(id);
      await shopifyStockOut(id);
      await posting().post({ orderId: id, generation: 1 }, { jobId: randomUUID(), retryCount: 0 });
      await report(id, fact('cancelled', 'carrier.terminated_before_pickup'));

      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'reversed', row: 4 }]);
      const groups = await groupsOf(id);
      expect(groups.map((group) => group.idempotency_key)).toEqual([
        carrierShipmentKey(id),
        cancelReversalKey(id, 1),
      ]);
      expect(groups[1]?.reverses_group_id).toBe(groups[0]?.id);
      expect(await stockOutOf(id)).toMatchObject({
        stock_out_generation: 2,
        stock_out_source: null,
        stock_out_requested_at: null,
      });
      expect((await linesOf(id)).map((line) => line.stock_out_quantity)).toEqual([null, null]);
      // A second run finds the order at another generation: row 1, nothing reversed twice.
      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 1 }]);
      expect(await groupsOf(id)).toHaveLength(2);
    });

    it('a cancel after a Shopify stock out puts the posted pieces on the awaiting list (row 5); a late shipped closes them', async () => {
      const id = await create();
      await confirm(id);
      await shopifyStockOut(id);
      await posting().post({ orderId: id, generation: 1 }, { jobId: randomUUID(), retryCount: 0 });
      await cancel(id);

      expect(await runJobs(id, 'after_cancel')).toEqual([
        { afterCancel: 'awaiting_restock', row: 5 },
      ]);
      const awaiting = await linesOf(id);
      expect(awaiting.map((line) => line.awaiting_restock_quantity)).toEqual([2, 1]);
      expect(awaiting.every((line) => line.awaiting_restock_since !== null)).toBe(true);
      expect(attentionsOf(id)).toContain('returned_pieces_to_receive');

      // The courier picked it up after all: the posting stands, nothing new is posted.
      await report(id, fact('shipped'));
      const closed = await linesOf(id);
      expect(closed.map((line) => line.awaiting_restock_quantity)).toEqual([0, 0]);
      expect(closed.map((line) => line.awaiting_restock_since)).toEqual([null, null]);
      expect((await jobsOf(id)).map((job) => job.data.kind)).toEqual(['after_cancel']);
      expect(await groupsOf(id)).toHaveLength(1);
      // A replay of the after cancel job finds the order shipped: row 3.
      expect(await runJobs(id, 'after_cancel')).toEqual([{ afterCancel: 'nothing', row: 3 }]);
    });

    it('a late carrier shipped on a cancelled order with no stock out posts it from on hand', async () => {
      const id = await create();
      await confirm(id);
      await cancel(id);
      await runJobs(id);
      await report(id, fact('shipped'));

      expect(attentionsOf(id)).toContain('shipped_after_cancellation');
      expect(await runJobs(id, 'post')).toEqual([expect.objectContaining({ posted: true })]);
      const [group] = await groupsOf(id);
      expect(await movementsOf(group?.id as string)).toHaveLength(2);
    });
  });
});
