import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  InvalidTransition,
  SkuDetail,
  replayStates,
  type ReplayEvent,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import type { OrderActor } from '../src/orders/order-actor.js';
import { OrderTransactions, type OrderTransaction } from '../src/orders/order-transactions.js';
import { InvalidOrderInput } from '../src/orders/orders.errors.js';
import {
  LinesReturnedToOrigin,
  OrderAttentionRaised,
  OrderCancelled,
} from '../src/orders/orders.events.js';
import {
  OrderTransitions,
  type ShipmentFact,
} from '../src/orders/transitions/order-transitions.service.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { stockedOnline } from './order-stock.js';

/** An order row as the assertions read it. */
interface OrderRow extends Record<string, unknown> {
  fulfillment_state: string;
  cash_state: string;
  outcome: string;
  lines_gross_amount: string;
  total_amount: string;
  cod_expected_amount: string;
  cod_due_amount: string;
  cod_collected_amount: string;
  remitted_amount: string;
  delivered_amount: string;
  refused_reason_code: string | null;
  carrier_delivery_created_at: Date | null;
  cancel_reason_code: string | null;
}

/** A line row as the assertions read it. */
interface LineRow extends Record<string, unknown> {
  id: string;
  position: number;
  variant_id: string | null;
  quantity: number;
  gross_amount: string;
  discount_amount: string;
  unit_price: string;
  line_state: string;
  split_from_line_id: string | null;
  short_quantity: number;
}

/** An event row as the assertions read it. */
interface EventRow extends Record<string, unknown> {
  machine: 'fulfillment' | 'cash';
  from_state: string | null;
  to_state: string;
  amount: string | null;
  actor_type: string;
  reason_code: string | null;
  source_type: string | null;
  source_id: string | null;
}

// Spec 0013 milestone 5 task 14 (AC-6, AC-8, AC-11, AC-15, AC-16, AC-17): every carrier and cash
// row of the spec 0002 transition tables through the orders writer, in process, inside
// `OrderTransactions.run`, as the application role on a scratch database, with the spec 0002
// worked examples. The shipment posting job and the stock out request are task 15's: nothing
// here posts stock.
describe('orders, milestone 5: the carrier and cash moves', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let supportId = '';
  let mainStore = '';
  let manualChannel = '';
  let skuM = '';
  let skuL = '';
  let n = 0;
  const created: string[] = [];
  const attentions: OrderAttentionRaised[] = [];
  const returned: LinesReturnedToOrigin[] = [];
  const cancelled: OrderCancelled[] = [];

  const carrier: OrderActor = { type: 'carrier', connectionId: randomUUID() };
  const job = (): OrderActor => ({
    type: 'system_job',
    job: 'settlement.match',
    jobId: randomUUID(),
  });
  const person = (): OrderActor => ({ type: 'person', userId: supportId, hat: 'support' });

  const run = <T>(work: (tx: OrderTransaction) => Promise<T>) =>
    api.app.get(OrderTransactions).run(work);
  const moves = () => api.app.get(OrderTransitions);
  const failureOf = (call: Promise<unknown>): Promise<unknown> =>
    call.then(
      () => null,
      (error: unknown) => error,
    );
  const owner = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    api.owner.pool.query<T>(text, params);

  const phone = () => {
    n += 1;
    return `0103${String(1_000_000 + n)}`;
  };

  /** Creates a COD order through the route (two lines unless told otherwise) and answers its id. */
  const create = async (over: Record<string, unknown> = {}) => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Transit Name', phone: phone(), address: '1 Transit Street' },
      lines: [
        { variantId: skuM, quantity: 2, unitPrice: '500.00' },
        { variantId: skuL, quantity: 1, unitPrice: '400.00' },
      ],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
      ...over,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const id = CreatedOrder.parse(reply.body).id;
    created.push(id);
    return id;
  };

  const fact = (to: ShipmentFact['to'], reasonCode?: string): ShipmentFact => ({
    to,
    occurredAt: new Date(),
    reasonCode: reasonCode ?? null,
    source: { type: 'carrier_delivery_event', id: randomUUID() },
  });
  const report = (id: string, f: ShipmentFact, actor: OrderActor = carrier) =>
    run((tx) => moves().recordShipmentFact(tx, id, f, actor));
  const confirm = (id: string) =>
    run((tx) => moves().confirm(tx, id, { type: 'person', userId: supportId, hat: 'support' }));
  const pack = (id: string) =>
    run((tx) => moves().markPacked(tx, id, { type: 'person', userId: supportId, hat: 'support' }));
  /** A confirmed order the courier picked up. */
  const shippedOrder = async (over: Record<string, unknown> = {}) => {
    const id = await create(over);
    await confirm(id);
    expect(await report(id, fact('shipped'))).toEqual({ applied: true });
    return id;
  };

  const orderOf = async (id: string) =>
    (
      await owner<OrderRow>(
        `SELECT fulfillment_state, cash_state, outcome, lines_gross_amount, total_amount,
                cod_expected_amount, cod_due_amount, cod_collected_amount, remitted_amount,
                delivered_amount, refused_reason_code, carrier_delivery_created_at, cancel_reason_code
         FROM orders WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0] as OrderRow;
  const linesOf = async (id: string) =>
    (
      await owner<LineRow>(
        `SELECT id, position, variant_id, quantity, gross_amount, discount_amount, unit_price,
                line_state, split_from_line_id, short_quantity
         FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [id],
      )
    ).rows;
  const eventsOf = async (id: string) =>
    (
      await owner<EventRow>(
        `SELECT machine, from_state, to_state, amount, actor_type, reason_code, source_type, source_id
         FROM order_events WHERE order_id = $1::uuid ORDER BY recorded_at, id`,
        [id],
      )
    ).rows;
  const auditOf = async (id: string, action: string) =>
    (
      await owner<{
        action: string;
        reason: string | null;
        actor_kind: string;
        record_label: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }>(
        `SELECT action, reason, actor_kind, record_label, before, after
         FROM audit_entries WHERE record_id = $1::uuid AND action = $2 ORDER BY recorded_at`,
        [id, action],
      )
    ).rows;
  const attentionsOf = (id: string) =>
    attentions.filter((a) => a.orderId === id).map((a) => a.kind);
  const heldFor = async (id: string) =>
    (
      await api.app.get(LedgerService).reservationsFor({ sourceType: 'order', sourceId: id })
    ).filter((row) => row.status === 'active');

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
    skuM = await sku('TR-M');
    skuL = await sku('TR-L');
    await stockedOnline(api, [skuM, skuL]);
    const events = api.app.get(DomainEvents);
    events.on(OrderAttentionRaised, (_tx, e) => void attentions.push(e), 'orders-transitions-e2e');
    events.on(LinesReturnedToOrigin, (_tx, e) => void returned.push(e), 'orders-transitions-e2e');
    events.on(OrderCancelled, (_tx, e) => void cancelled.push(e), 'orders-transitions-e2e');
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('carrier facts on the fulfillment table (AC-15)', () => {
    it('ships a new order: moved, shipped_without_confirmation, the freeze set from the fact', async () => {
      const id = await create();
      const shipped = fact('shipped');

      expect(await report(id, shipped)).toEqual({ applied: true });
      const order = await orderOf(id);
      const events = await eventsOf(id);

      expect(order.fulfillment_state).toBe('shipped');
      expect(order.carrier_delivery_created_at?.toISOString()).toBe(
        shipped.occurredAt.toISOString(),
      );
      expect(order.cod_due_amount).toBe('1450.00');
      expect(order.outcome).toBe('open');
      expect(attentionsOf(id)).toEqual(['shipped_without_confirmation']);
      expect(events.at(-1)).toMatchObject({
        machine: 'fulfillment',
        from_state: 'new',
        to_state: 'shipped',
        actor_type: 'carrier',
        source_type: 'carrier_delivery_event',
        source_id: shipped.source.id,
      });
      expect((await linesOf(id)).map((line) => line.line_state)).toEqual(['open', 'open']);
    });

    it('ships a confirmed order with no task, and a packed one', async () => {
      const confirmed = await create();
      await confirm(confirmed);
      const packed = await create();
      await confirm(packed);
      await pack(packed);

      expect(await report(confirmed, fact('shipped'))).toEqual({ applied: true });
      expect(await report(packed, fact('shipped'))).toEqual({ applied: true });
      expect(attentionsOf(confirmed)).toEqual([]);
      expect((await orderOf(packed)).fulfillment_state).toBe('shipped');
    });

    it('opens shipped_before_edit_synced when a write back is still open', async () => {
      const id = await create();
      await confirm(id);
      await owner(`UPDATE orders SET write_back_state = 'waiting' WHERE id = $1::uuid`, [id]);

      expect(await report(id, fact('shipped'))).toEqual({ applied: true });
      expect(attentionsOf(id)).toEqual(['shipped_before_edit_synced']);
    });

    it('keeps the earlier carrier delivery time when the freeze already exists', async () => {
      const id = await create();
      const at = new Date('2026-11-01T08:00:00Z');
      await run((tx) =>
        moves().recordCarrierDelivery(
          tx,
          id,
          { at, source: { type: 'carrier_delivery', id: randomUUID() } },
          carrier,
        ),
      );
      await confirm(id);
      await report(id, fact('shipped'));

      expect((await orderOf(id)).carrier_delivery_created_at?.toISOString()).toBe(at.toISOString());
    });

    it('records each failed attempt, then delivers every open line', async () => {
      const id = await shippedOrder();
      const expected = (await orderOf(id)).cod_expected_amount;

      await report(id, fact('failed_attempt'));
      await report(id, fact('failed_attempt'));
      expect(await report(id, fact('delivered'))).toEqual({ applied: true });
      const order = await orderOf(id);
      const fulfillment = (await eventsOf(id)).filter((e) => e.machine === 'fulfillment');

      expect(fulfillment.map((e) => e.to_state)).toEqual([
        'new',
        'confirmed',
        'shipped',
        'failed_attempt',
        'failed_attempt',
        'delivered',
      ]);
      expect((await linesOf(id)).map((line) => line.line_state)).toEqual([
        'delivered',
        'delivered',
      ]);
      expect(order).toMatchObject({
        fulfillment_state: 'delivered',
        cash_state: 'unpaid',
        outcome: 'kept',
        cod_due_amount: '1450.00',
        cod_expected_amount: expected,
        delivered_amount: '1400.00',
      });
    });

    it('refuses at the door: the reason stored, the amount due kept, then back to origin', async () => {
      const id = await shippedOrder();

      expect(await report(id, fact('refused', 'size'))).toEqual({ applied: true });
      const refused = await orderOf(id);
      expect(refused).toMatchObject({
        fulfillment_state: 'refused',
        refused_reason_code: 'size',
        cod_due_amount: '1450.00',
        cash_state: 'unpaid',
        outcome: 'failed_delivery',
      });

      expect(await report(id, fact('returned_to_origin'))).toEqual({ applied: true });
      const back = await orderOf(id);
      const lines = await linesOf(id);
      const events = await eventsOf(id);
      const [rto, ntc] = events.slice(-2);

      expect(back).toMatchObject({
        fulfillment_state: 'returned_to_origin',
        cod_due_amount: '0.00',
        cash_state: 'nothing_to_collect',
        cod_expected_amount: '1450.00',
      });
      expect(lines.map((line) => line.line_state)).toEqual([
        'returned_to_origin',
        'returned_to_origin',
      ]);
      expect(ntc).toMatchObject({
        machine: 'cash',
        from_state: 'unpaid',
        to_state: 'nothing_to_collect',
        actor_type: 'system_job',
        source_type: 'order_event',
      });
      expect(rto?.to_state).toBe('returned_to_origin');
      expect(returned.filter((e) => e.orderId === id)).toEqual([
        expect.objectContaining({
          lineIds: lines.map((line) => line.id),
          to: 'returned_to_origin',
        }),
      ]);
    });

    it('returns to origin straight from a failed attempt', async () => {
      const id = await shippedOrder();
      await report(id, fact('failed_attempt'));

      expect(await report(id, fact('returned_to_origin'))).toEqual({ applied: true });
      expect((await orderOf(id)).cash_state).toBe('nothing_to_collect');
    });

    it('loses a parcel by the carrier: lines lost, LinesReturnedToOrigin with lost, nothing to collect', async () => {
      const id = await shippedOrder();

      expect(await report(id, fact('lost'))).toEqual({ applied: true });
      expect((await linesOf(id)).map((line) => line.line_state)).toEqual(['lost', 'lost']);
      expect(await orderOf(id)).toMatchObject({
        fulfillment_state: 'lost',
        outcome: 'failed_delivery',
        cash_state: 'nothing_to_collect',
        cod_due_amount: '0.00',
      });
      expect(returned.find((e) => e.orderId === id)?.to).toBe('lost');
    });

    it('lets a person record lost only with a reason, from refused too', async () => {
      const id = await shippedOrder();
      await report(id, fact('refused', 'changed_mind'));

      expect(await failureOf(report(id, fact('lost'), person()))).toBeInstanceOf(InvalidTransition);
      expect(await report(id, fact('lost', 'courier_missing'), person())).toEqual({
        applied: true,
      });
      expect((await eventsOf(id)).at(-2)).toMatchObject({
        to_state: 'lost',
        actor_type: 'person',
        reason_code: 'courier_missing',
      });
    });

    it('cancels before pickup on the carrier fact, and a late shipped moves it with its task (Q-16.4)', async () => {
      const id = await create();
      await confirm(id);
      expect(await heldFor(id)).not.toHaveLength(0);

      expect(await report(id, fact('cancelled', 'carrier.terminated_before_pickup'))).toEqual({
        applied: true,
      });
      const order = await orderOf(id);

      expect(order).toMatchObject({
        fulfillment_state: 'cancelled',
        cancel_reason_code: 'carrier.terminated_before_pickup',
        cash_state: 'nothing_to_collect',
        cod_due_amount: '0.00',
        outcome: 'cancelled_before_shipping',
      });
      expect(order.carrier_delivery_created_at).not.toBeNull();
      expect(await heldFor(id)).toHaveLength(0);
      expect(attentionsOf(id)).not.toContain('terminate_carrier_delivery');
      expect(cancelled.find((e) => e.orderId === id)?.origin).toBe('carrier');

      expect(await report(id, fact('shipped'))).toEqual({ applied: true });
      expect((await orderOf(id)).fulfillment_state).toBe('shipped');
      expect(attentionsOf(id)).toContain('shipped_after_cancellation');
    });

    it('applies nothing and raises carrier_fact_contradicts_state for a pair the table does not list', async () => {
      const back = await shippedOrder();
      await report(back, fact('returned_to_origin'));
      const fresh = await create();
      const shipped = await shippedOrder();
      const before = {
        back: await eventsOf(back),
        fresh: await eventsOf(fresh),
        shipped: await eventsOf(shipped),
      };

      const late = fact('shipped');
      expect(await report(back, late)).toEqual({ applied: false });
      expect(await report(fresh, fact('delivered'))).toEqual({ applied: false });
      expect(await report(fresh, fact('failed_attempt'))).toEqual({ applied: false });
      // After pickup a carrier cancel is a contradiction, not a cancel (AC-8).
      expect(await report(shipped, fact('cancelled', 'carrier.terminated_before_pickup'))).toEqual({
        applied: false,
      });

      expect(await eventsOf(back)).toEqual(before.back);
      expect(await eventsOf(fresh)).toEqual(before.fresh);
      expect(await eventsOf(shipped)).toEqual(before.shipped);
      expect((await orderOf(shipped)).fulfillment_state).toBe('shipped');
      expect(
        attentions.find((a) => a.orderId === back && a.kind === 'carrier_fact_contradicts_state'),
      ).toMatchObject({
        sourceType: 'shipped',
        sourceId: late.source.id,
      });
      expect(attentionsOf(fresh)).toEqual([
        'carrier_fact_contradicts_state',
        'carrier_fact_contradicts_state',
      ]);
    });

    it('throws for a malformed fact and for a move a non carrier actor may not make', async () => {
      const id = await shippedOrder();
      const before = await eventsOf(id);

      expect(await failureOf(report(id, fact('refused', 'weather')))).toBeInstanceOf(
        InvalidOrderInput,
      );
      expect(await failureOf(report(id, fact('refused')))).toBeInstanceOf(InvalidOrderInput);
      expect(
        await failureOf(report(id, { ...fact('shipped'), to: 'partially_delivered' as never })),
      ).toBeInstanceOf(InvalidOrderInput);
      expect(
        await failureOf(
          report(id, fact('cancelled', 'carrier.terminated_before_pickup'), person()),
        ),
      ).toBeInstanceOf(InvalidTransition);
      expect(await failureOf(report(id, fact('delivered'), person()))).toBeInstanceOf(
        InvalidTransition,
      );
      expect(await eventsOf(id)).toEqual(before);
    });

    it('keeps the edit lock and the money freeze after a carrier fact (AC-8)', async () => {
      const id = await shippedOrder();
      const before = await orderOf(id);
      const detail = await api.call(support, 'GET', `/api/orders/${id}`);
      const { updatedAt } = detail.body as { updatedAt: string };

      const edit = await api.call(support, 'POST', `/api/orders/${id}/edits`, {
        expectedUpdatedAt: updatedAt,
        operations: [{ kind: 'shipping', shippingChargedAmount: '70.00' }],
      });
      const cancel = await api.call(support, 'POST', `/api/orders/${id}/cancel`, {
        expectedUpdatedAt: updatedAt,
        reasonCode: 'fake',
      });

      expect(edit.status).toBe(409);
      expect((edit.body as { code: string }).code).toBe('ORDER_LOCKED');
      expect(cancel.status).toBe(409);
      expect((cancel.body as { code: string }).code).toBe('INVALID_TRANSITION');
      expect((await orderOf(id)).cod_expected_amount).toBe(before.cod_expected_amount);
    });
  });

  describe('partial delivery (AC-16)', () => {
    /** The spec 0002 worked example: three pieces at 2,400.00, 50.00 shipping, all COD. */
    const workedExample = () =>
      shippedOrder({
        lines: [{ variantId: skuM, quantity: 3, unitPrice: '800.00' }],
      });

    it('splits the worked example: one piece back leaves 1,650.00 due of 2,450.00 expected', async () => {
      const id = await workedExample();
      const [original] = await linesOf(id);

      await run((tx) =>
        moves().recordPartialDelivery(
          tx,
          id,
          {
            lines: [{ lineId: original?.id as string, deliveredQuantity: 2 }],
            occurredAt: new Date(),
            source: { type: 'carrier_delivery_event', id: randomUUID() },
          },
          carrier,
        ),
      );
      const order = await orderOf(id);
      const lines = await linesOf(id);

      expect(order).toMatchObject({
        fulfillment_state: 'partially_delivered',
        lines_gross_amount: '2400.00',
        total_amount: '2450.00',
        cod_expected_amount: '2450.00',
        cod_due_amount: '1650.00',
        delivered_amount: '1600.00',
        outcome: 'kept',
      });
      expect(lines).toEqual([
        expect.objectContaining({
          id: original?.id,
          quantity: 2,
          gross_amount: '1600.00',
          line_state: 'delivered',
          split_from_line_id: null,
          short_quantity: 0,
        }),
        expect.objectContaining({
          position: 2,
          variant_id: skuM,
          quantity: 1,
          unit_price: '800.00',
          gross_amount: '800.00',
          line_state: 'returned_to_origin',
          split_from_line_id: original?.id,
        }),
      ]);
      const audit = await auditOf(id, 'order.partial_delivery_split');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        reason: 'carrier_report',
        actor_kind: 'carrier',
        record_label: expect.stringMatching(/^MAIN\//) as string,
        before: { codDueAmount: '2450.00' },
        after: { codDueAmount: '1650.00', deliveredAmount: '1600.00' },
      });
      expect(returned.find((e) => e.orderId === id)).toMatchObject({
        lineIds: [lines[1]?.id],
        to: 'returned_to_origin',
      });

      // A collection of the amount due reconciles with no shortfall (spec 0002 worked example).
      await run((tx) =>
        moves().recordCollection(
          tx,
          id,
          {
            amount: '1650.00',
            occurredAt: new Date(),
            source: { type: 'carrier_delivery_event', id: randomUUID() },
          },
          carrier,
        ),
      );
      const collected = await orderOf(id);
      expect(collected.cod_collected_amount).toBe(collected.cod_due_amount);
    });

    it('splits the discounted line of the worked example to the cent', async () => {
      const id = await shippedOrder({
        lines: [{ variantId: skuM, quantity: 3, unitPrice: '366.67', discountAmount: '100.01' }],
      });
      const [original] = await linesOf(id);
      expect(original?.gross_amount).toBe('1000.00');

      await run((tx) =>
        moves().recordPartialDelivery(
          tx,
          id,
          {
            lines: [{ lineId: original?.id as string, deliveredQuantity: 2 }],
            occurredAt: new Date(),
            source: { type: 'carrier_delivery_event', id: randomUUID() },
          },
          carrier,
        ),
      );
      const lines = await linesOf(id);

      expect(lines.map((line) => [line.gross_amount, line.discount_amount])).toEqual([
        ['666.67', '66.67'],
        ['333.33', '33.34'],
      ]);
    });

    it('returns a one piece line whole and delivers the line not named; a person writes the audit', async () => {
      const id = await shippedOrder();
      const [m, l] = await linesOf(id);

      await run((tx) =>
        moves().recordPartialDelivery(
          tx,
          id,
          {
            lines: [{ lineId: l?.id as string, deliveredQuantity: 0 }],
            occurredAt: new Date(),
            source: { type: 'courier_note', id: randomUUID() },
            reasonCode: 'courier_note',
          },
          person(),
        ),
      );
      const lines = await linesOf(id);

      expect(lines.map((line) => [line.id, line.line_state])).toEqual([
        [m?.id, 'delivered'],
        [l?.id, 'returned_to_origin'],
      ]);
      expect((await orderOf(id)).cod_due_amount).toBe('1050.00');
      expect(await auditOf(id, 'order.partial_delivery_split')).toEqual([
        expect.objectContaining({ actor_kind: 'person', reason: 'courier_note' }),
      ]);
    });

    it('refuses a split with nothing back, nothing delivered, a foreign line, or before pickup', async () => {
      const id = await shippedOrder();
      const other = await create();
      const [m, l] = await linesOf(id);
      const [foreign] = await linesOf(other);
      const partial = (orderId: string, lines: { lineId: string; deliveredQuantity: number }[]) =>
        failureOf(
          run((tx) =>
            moves().recordPartialDelivery(
              tx,
              orderId,
              { lines, occurredAt: new Date(), source: { type: 'test', id: randomUUID() } },
              carrier,
            ),
          ),
        );
      const before = await eventsOf(id);

      expect(await partial(id, [])).toBeInstanceOf(InvalidTransition);
      expect(
        await partial(id, [
          { lineId: m?.id as string, deliveredQuantity: 0 },
          { lineId: l?.id as string, deliveredQuantity: 0 },
        ]),
      ).toBeInstanceOf(InvalidTransition);
      expect(
        await partial(id, [{ lineId: foreign?.id as string, deliveredQuantity: 0 }]),
      ).toBeInstanceOf(InvalidOrderInput);
      expect(
        await partial(other, [{ lineId: foreign?.id as string, deliveredQuantity: 1 }]),
      ).toBeInstanceOf(InvalidTransition);
      expect(await eventsOf(id)).toEqual(before);
      expect(await linesOf(id)).toHaveLength(2);
      expect(await auditOf(id, 'order.partial_delivery_split')).toEqual([]);
    });
  });

  describe('cash moves (AC-17, AC-11)', () => {
    const src = () => ({ type: 'carrier_delivery_event', id: randomUUID() });
    const collect = (
      id: string,
      amount: string,
      actor: OrderActor = carrier,
      reasonCode?: string,
    ) =>
      run((tx) =>
        moves().recordCollection(
          tx,
          id,
          { amount, occurredAt: new Date(), source: src(), reasonCode: reasonCode ?? null },
          actor,
        ),
      );
    const settle = (
      id: string,
      change: Parameters<OrderTransitions['recordSettlement']>[2],
      actor: OrderActor = job(),
    ) => run((tx) => moves().recordSettlement(tx, id, change, actor));
    const deliveredOrder = async () => {
      const id = await shippedOrder();
      await report(id, fact('delivered'));
      return id;
    };

    it('collects 1,000.00 then corrects to 1,450.00: two events, the total collected; a repeat writes nothing', async () => {
      const id = await deliveredOrder();

      expect(await collect(id, '1000.00')).toEqual({ applied: true });
      expect(await collect(id, '1450.00')).toEqual({ applied: true });
      expect(await collect(id, '1450.00')).toEqual({ applied: false });
      const cash = (await eventsOf(id)).filter((e) => e.machine === 'cash');

      expect(cash.map((e) => [e.from_state, e.to_state, e.amount])).toEqual([
        [null, 'unpaid', null],
        ['unpaid', 'collected_by_carrier', '1000.00'],
        ['collected_by_carrier', 'collected_by_carrier', '1450.00'],
      ]);
      expect((await orderOf(id)).cod_collected_amount).toBe('1450.00');
      expect(await auditOf(id, 'order.collection_recorded_manually')).toEqual([]);
    });

    it('needs a person to give a listed reason, and writes order.collection_recorded_manually', async () => {
      const id = await deliveredOrder();

      expect(await failureOf(collect(id, '1450.00', person()))).toBeInstanceOf(InvalidTransition);
      expect(await failureOf(collect(id, '1450.00', person(), 'because'))).toBeInstanceOf(
        InvalidOrderInput,
      );
      expect(await failureOf(collect(id, '0.00'))).toBeInstanceOf(InvalidOrderInput);
      expect(await collect(id, '1450.00', person(), 'courier_note')).toEqual({ applied: true });

      expect(await auditOf(id, 'order.collection_recorded_manually')).toEqual([
        expect.objectContaining({
          reason: 'courier_note',
          actor_kind: 'person',
          before: { cashState: 'unpaid', codCollectedAmount: '0.00' },
          after: { cashState: 'collected_by_carrier', codCollectedAmount: '1450.00' },
        }),
      ]);
    });

    it('reverses a collection back to unpaid, by the carrier and by a person with a reason', async () => {
      const id = await deliveredOrder();
      await collect(id, '1450.00');
      const reverse = (actor: OrderActor, reasonCode?: string) =>
        run((tx) =>
          moves().reverseCollection(
            tx,
            id,
            { occurredAt: new Date(), source: src(), reasonCode: reasonCode ?? null },
            actor,
          ),
        );

      await reverse(carrier);
      expect(await orderOf(id)).toMatchObject({
        cash_state: 'unpaid',
        cod_collected_amount: '0.00',
      });
      expect(await failureOf(reverse(carrier))).toBeInstanceOf(InvalidTransition);

      await collect(id, '1450.00');
      expect(await failureOf(reverse(person()))).toBeInstanceOf(InvalidTransition);
      await reverse(person(), 'correction');
      expect((await eventsOf(id)).at(-1)).toMatchObject({
        to_state: 'unpaid',
        amount: '0.00',
        reason_code: 'correction',
      });
      expect(await auditOf(id, 'order.collection_recorded_manually')).toEqual([
        expect.objectContaining({
          reason: 'correction',
          after: { cashState: 'unpaid', codCollectedAmount: '0.00' },
        }),
      ]);
    });

    it('takes late cash on nothing_to_collect from the carrier with its task, never from a person', async () => {
      const id = await shippedOrder();
      await report(id, fact('returned_to_origin'));

      expect(await failureOf(collect(id, '100.00', person(), 'courier_note'))).toBeInstanceOf(
        InvalidTransition,
      );
      expect(await collect(id, '100.00')).toEqual({ applied: true });
      expect((await orderOf(id)).cash_state).toBe('collected_by_carrier');
      expect(attentionsOf(id)).toContain('late_cash_on_nothing_to_collect');
    });

    it('settles: remitted needs its deposit date, reconciled needs it fully settled, and both revokes need a reason', async () => {
      const id = await deliveredOrder();
      await collect(id, '1450.00');
      const source = randomUUID();

      expect(
        await failureOf(
          settle(id, { to: 'remitted', remittedAmount: '1450.00', sourceId: source }),
        ),
      ).toBeInstanceOf(InvalidTransition);
      expect(
        await failureOf(
          settle(
            id,
            {
              to: 'remitted',
              remittedAmount: '1450.00',
              depositedOn: '2026-11-20',
              sourceId: source,
            },
            person(),
          ),
        ),
      ).toBeInstanceOf(InvalidTransition);
      await settle(id, {
        to: 'remitted',
        remittedAmount: '1450.00',
        depositedOn: '2026-11-20',
        sourceId: source,
      });
      expect(await orderOf(id)).toMatchObject({
        cash_state: 'remitted',
        remitted_amount: '1450.00',
      });
      expect((await eventsOf(id)).at(-1)).toMatchObject({
        to_state: 'remitted',
        amount: '1450.00',
        source_type: 'settlement_match',
        source_id: source,
      });

      expect(await failureOf(settle(id, { to: 'reconciled', sourceId: source }))).toBeInstanceOf(
        InvalidTransition,
      );
      await settle(id, { to: 'reconciled', fullySettled: true, sourceId: source });
      expect((await orderOf(id)).cash_state).toBe('reconciled');

      expect(await failureOf(settle(id, { to: 'remitted', sourceId: source }))).toBeInstanceOf(
        InvalidTransition,
      );
      await settle(id, { to: 'remitted', reasonCode: 'match_revoked', sourceId: source });
      expect(await orderOf(id)).toMatchObject({
        cash_state: 'remitted',
        remitted_amount: '1450.00',
      });

      expect(
        await failureOf(settle(id, { to: 'collected_by_carrier', sourceId: source })),
      ).toBeInstanceOf(InvalidTransition);
      await settle(id, {
        to: 'collected_by_carrier',
        reasonCode: 'deposit_revoked',
        sourceId: source,
      });
      expect(await orderOf(id)).toMatchObject({
        cash_state: 'collected_by_carrier',
        remitted_amount: '0.00',
        cod_collected_amount: '1450.00',
      });
    });

    it('reconciles a prepaid order by a job or a person, and refuses a collection on it', async () => {
      const byJob = await create({ paymentMethod: 'instapay', prepaidAmount: '1450.00' });
      const byPerson = await create({ paymentMethod: 'instapay', prepaidAmount: '1450.00' });
      expect((await orderOf(byJob)).cash_state).toBe('prepaid');

      expect(await failureOf(collect(byJob, '10.00'))).toBeInstanceOf(InvalidTransition);
      await settle(byJob, { to: 'reconciled', sourceId: randomUUID() });
      await settle(byPerson, { to: 'reconciled', sourceId: randomUUID() }, person());

      expect((await orderOf(byJob)).cash_state).toBe('reconciled');
      expect((await orderOf(byPerson)).cash_state).toBe('reconciled');
    });
  });

  describe('exchanged (AC-17)', () => {
    it('moves a delivered or partly delivered order to exchanged by a job, once', async () => {
      const delivered = await shippedOrder();
      await report(delivered, fact('delivered'));
      const shipped = await shippedOrder();
      const exchangeId = randomUUID();
      const exchange = (id: string, actor: OrderActor) =>
        run((tx) => moves().markExchanged(tx, id, { exchangeId }, actor));

      expect(await failureOf(exchange(delivered, person()))).toBeInstanceOf(InvalidTransition);
      expect(await failureOf(exchange(shipped, job()))).toBeInstanceOf(InvalidTransition);
      await exchange(delivered, job());
      expect(await failureOf(exchange(delivered, job()))).toBeInstanceOf(InvalidTransition);

      expect(await orderOf(delivered)).toMatchObject({
        fulfillment_state: 'exchanged',
        outcome: 'kept',
      });
      expect((await eventsOf(delivered)).at(-1)).toMatchObject({
        to_state: 'exchanged',
        actor_type: 'system_job',
        source_type: 'exchange',
        source_id: exchangeId,
      });
    });
  });

  it('replays every order of this suite to its stored states (AC-6)', async () => {
    expect(created.length).toBeGreaterThan(10);
    for (const id of created) {
      const events = (await eventsOf(id)).map((e): ReplayEvent => ({
        machine: e.machine,
        fromState: e.from_state,
        toState: e.to_state,
      }));
      const order = await orderOf(id);

      expect(replayStates(events)).toEqual({
        fulfillment: order.fulfillment_state,
        cash: order.cash_state,
      });
    }
  });
});
