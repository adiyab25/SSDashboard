import { randomUUID } from 'node:crypto';
import {
  ChannelOrderInput,
  ChannelOrderSnapshot,
  CreatedOrder,
  InvalidTransition,
  OrderDetail,
  OrderListResponse,
  SkuDetail,
  replayStates,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderIntake, type ChannelActor } from '../src/orders/intake/order-intake.service.js';
import { OrderTransactions, type OrderTransaction } from '../src/orders/order-transactions.js';
import {
  InvalidOrderInput,
  LineAlreadyMapped,
  OrderNumberTaken,
  PaymentMethodLocked,
  RelatedOrderState,
} from '../src/orders/orders.errors.js';
import { OrderAttentionRaised, OrderEdited, OrderPlaced } from '../src/orders/orders.events.js';
import { OrderTransitions } from '../src/orders/transitions/order-transitions.service.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0013 milestone 3 (AC-11, AC-14, AC-15, AC-18, AC-23, AC-25, B1): the in process channel
// calls feature 13 makes, run inside `OrderTransactions.run` as the application role on a scratch
// database. Inputs are built here with a small local builder; the recorded Shopify shaped fixtures
// drive them in a follow up. Reservations and the shipment posting are milestones 4 and 5: the
// closed order import proves only that no order holding path and no shipment job runs for it.
describe('orders, milestone 3: the channel intake contract', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let mainStore = '';
  let manualChannel = '';
  let essStore = '';
  let essChannel = '';
  let connection = '';
  let skuM = '';
  let skuL = '';
  let n = 0;
  const edited: OrderEdited[] = [];
  const attentions: OrderAttentionRaised[] = [];
  const placed: OrderPlaced[] = [];

  const job = (): ChannelActor => ({
    type: 'system_job',
    job: 'shopify.intake',
    jobId: randomUUID(),
  });
  const importRun = () => ({ type: 'import' as const, runId: randomUUID() });
  const run = <T>(work: (tx: OrderTransaction) => Promise<T>) =>
    api.app.get(OrderTransactions).run(work);
  const intake = () => api.app.get(OrderIntake);
  /** The error a call rejects with (null when it resolves), caught at once so no rejection dangles. */
  const failureOf = (call: Promise<unknown>): Promise<unknown> =>
    call.then(
      () => null,
      (error: unknown) => error,
    );

  const phone = () => {
    n += 1;
    return `0102${String(1_000_000 + n)}`;
  };

  /** One Shopify shaped line. */
  const line = (over: Record<string, unknown> = {}) => ({
    channelLineId: `cl-m-${randomUUID()}`,
    variantId: skuM,
    title: 'Shopify Tee M',
    quantity: 1,
    unitPrice: '570.00',
    discountAmount: '0.00',
    taxRate: '14.00',
    ...over,
  });

  /** A Shopify shaped order into ESS, as feature 13 maps a webhook. */
  const channelInput = (over: Record<string, unknown> = {}) =>
    ChannelOrderInput.parse({
      storeId: essStore,
      channelId: essChannel,
      channelOrderRef: `gid-${randomUUID()}`,
      orderNumber: `#${String(2000 + (n += 1))}`,
      placedAt: new Date(Date.now() - 60_000).toISOString(),
      type: 'sale',
      paymentMethod: 'cod',
      shippingChargedAmount: '50.00',
      customerNote: 'Sentinel customer note',
      channelCustomer: { kind: 'shopify_customer', connectionId: connection, externalId: `c-${n}` },
      source: { capturedFrom: 'shopify_journey', utmSource: 'facebook', utmCampaign: 'eid' },
      shipTo: {
        name: 'Sentinel Name',
        phone: phone(),
        phoneAlt: null,
        address: '12 Sentinel Street',
      },
      lines: [
        line(),
        line({
          channelLineId: `cl-l-${randomUUID()}`,
          variantId: skuL,
          title: 'Shopify Tee L',
          unitPrice: '400.00',
        }),
      ],
      ...over,
    });

  /** The snapshot of an input as the channel holds it now, with changes on top. */
  const snapshotOf = (input: ChannelOrderInput, over: Record<string, unknown> = {}) =>
    ChannelOrderSnapshot.parse({
      type: input.type,
      giftReasonCode: input.giftReasonCode,
      paymentMethod: input.paymentMethod,
      shippingChargedAmount: input.shippingChargedAmount,
      discountCode: input.discountCode,
      customerNote: input.customerNote,
      channelCustomer: input.channelCustomer,
      source: input.source,
      shipTo: input.shipTo,
      lines: input.lines,
      ...over,
    });

  const create = async (
    input: ChannelOrderInput,
    actor: ChannelActor | ReturnType<typeof importRun> = job(),
  ) => run((tx) => intake().createFromChannel(tx, input, actor));

  const detail = async (id: string) => {
    const reply = await api.call(support, 'GET', `/api/orders/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OrderDetail.parse(reply.body);
  };

  const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => api.owner.pool.query<T>(text, params);

  const orderRow = async (id: string) =>
    (
      await owner<{
        customer_id: string | null;
        contact_phone_raw: string | null;
        ship_to_phone: string | null;
        ship_to_phone_alt: string | null;
        prepaid_amount: string;
        updated_at: string;
        confirmed_at: string | null;
        confirmed_by: string | null;
        placed_at: string;
        carrier_delivery_created_at: string | null;
      }>(
        `SELECT customer_id, contact_phone_raw, ship_to_phone, ship_to_phone_alt, prepaid_amount,
                updated_at::text, confirmed_at::text, confirmed_by, placed_at::text,
                carrier_delivery_created_at::text
         FROM orders WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0];

  const eventsOf = async (id: string) =>
    (
      await owner<{
        machine: 'fulfillment' | 'cash';
        from_state: string | null;
        to_state: string;
        actor_type: string;
        reason_code: string | null;
      }>(
        `SELECT machine, from_state, to_state, actor_type, reason_code FROM order_events
         WHERE order_id = $1::uuid ORDER BY recorded_at, id`,
        [id],
      )
    ).rows;

  const auditOf = async (id: string) =>
    (
      await owner<{
        action: string;
        reason: string | null;
        actor_kind: string;
        record_label: string;
        after: Record<string, unknown> | null;
      }>(
        `SELECT action, reason, actor_kind, record_label, after FROM audit_entries
         WHERE record_id = $1::uuid ORDER BY recorded_at, id`,
        [id],
      )
    ).rows;

  const attentionsOf = (id: string) =>
    attentions.filter((a) => a.orderId === id).map((a) => [a.kind, a.sourceType]);

  /** Plants a waiting outbound command on the order, as feature 18's executor will queue one. */
  const openCommand = async (orderId: string) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO outbound_commands (connection_id, kind, linked_type, linked_id, payload, idempotency_key)
         VALUES ($1::uuid, 'shopify.order_edit', 'order', $2::uuid, '{}'::jsonb, $3) RETURNING id`,
        [connection, orderId, `fixture:${randomUUID()}`],
      )
    ).rows[0]?.id as string;

  const recordDelivery = (orderId: string, type: 'carrier_delivery' | 'shopify_fulfillment') =>
    run((tx) =>
      api.app
        .get(OrderTransitions)
        .recordCarrierDelivery(
          tx,
          orderId,
          { at: new Date(), source: { type, id: randomUUID() } },
          job(),
        ),
    );

  beforeAll(async () => {
    api = await startInProcessApi();
    const manager = await api.signIn((await api.addPerson(['manager'])).email);
    support = await api.signIn((await api.addPerson(['support'])).email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    essStore = await one(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ('ESS', '{"en":"Essentials"}', '{"en":"Essentials"}', 'shopify') RETURNING id`,
    );
    essChannel = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('ESS', '{"en":"Essentials"}', 'shopify', '${essStore}') RETURNING id`,
    );
    connection = await one(
      `INSERT INTO connections (provider, label, store_id, shop_domain)
       VALUES ('shopify', 'Essentials', '${essStore}', 'ess.myshopify.com') RETURNING id`,
    );
    const sku = async (code: string) => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '570.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };
    skuM = await sku('IN-M');
    skuL = await sku('IN-L');
    const events = api.app.get(DomainEvents);
    events.on(OrderEdited, (_tx, event) => void edited.push(event), 'orders-intake-e2e');
    events.on(
      OrderAttentionRaised,
      (_tx, event) => void attentions.push(event),
      'orders-intake-e2e',
    );
    events.on(OrderPlaced, (_tx, event) => void placed.push(event), 'orders-intake-e2e');
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('channel intake (AC-14)', () => {
    it('creates once per channel ref: a repeat answers created false and writes nothing', async () => {
      const input = channelInput();

      const first = await create(input);
      const again = await create(input);
      const page = await detail(first.orderId);
      const count = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM orders WHERE store_id = $1::uuid AND channel_order_ref = $2`,
        [essStore, input.channelOrderRef],
      );
      const external = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_external_ids WHERE external_id = $1`,
        [input.channelCustomer?.externalId],
      );

      expect(first.created).toBe(true);
      expect(again).toEqual({ orderId: first.orderId, created: false });
      expect(count.rows[0]?.count).toBe('1');
      expect(page).toMatchObject({
        storeCode: 'ESS',
        orderNumber: input.orderNumber,
        fulfillmentState: 'new',
        cashState: 'unpaid',
        customerNote: 'Sentinel customer note',
        source: { capturedFrom: 'shopify_journey', utmSource: 'facebook', utmCampaign: 'eid' },
      });
      expect(page.customer).not.toBeNull();
      expect(page.money).toMatchObject({ totalAmount: '1020.00', codExpectedAmount: '1020.00' });
      expect(page.lines.map((l) => [l.title, l.variantId])).toEqual([
        ['Shopify Tee M', skuM],
        ['Shopify Tee L', skuL],
      ]);
      expect(external.rows[0]?.count).toBe('1');
      expect(placed.filter((p) => p.orderId === first.orderId)).toHaveLength(1);
      expect(await auditOf(first.orderId)).toEqual([]);
    });

    it('keeps an unmapped line with the channel title, and a bad main or second phone without refusing', async () => {
      const input = channelInput({
        shipTo: { name: 'Sentinel Name', phone: '01x 2345', phoneAlt: '12 34', address: 'x' },
        lines: [line({ variantId: null, title: 'Mystery tee' })],
      });

      const { orderId } = await create(input);
      const row = await orderRow(orderId);
      const page = await detail(orderId);

      expect(page.lines[0]).toMatchObject({ variantId: null, title: 'Mystery tee', skuCode: null });
      expect(row).toMatchObject({
        customer_id: null,
        ship_to_phone: null,
        contact_phone_raw: '01x 2345',
        ship_to_phone_alt: null,
      });
      expect(attentionsOf(orderId)).toEqual([
        ['phone_unparseable', 'order'],
        ['phone_unparseable', 'ship_to_phone_alt'],
      ]);
    });

    it('applies a snapshot that drops a line and changes a quantity: one cancel, one cancel plus add', async () => {
      const input = channelInput();
      const { orderId } = await create(input);
      const [m] = input.lines;
      const snapshot = snapshotOf(input, { lines: [{ ...m, quantity: 2 }] });

      const result = await run((tx) => intake().applyChannelEdit(tx, orderId, snapshot, job()));
      const page = await detail(orderId);

      expect(result).toEqual({ applied: true, changed: true });
      expect(
        page.lines.map((x) => [x.position, x.title, x.quantity, x.lineState, x.cancelReasonCode]),
      ).toEqual([
        [1, 'Shopify Tee M', 1, 'cancelled', 'edit_removal'],
        [2, 'Shopify Tee L', 1, 'cancelled', 'channel_edit'],
        [3, 'Shopify Tee M', 2, 'open', null],
      ]);
      expect(page.money).toMatchObject({ totalAmount: '1190.00', codExpectedAmount: '1190.00' });
      const entries = await auditOf(orderId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'order.edited',
        reason: 'channel_edit',
        actor_kind: 'system_job',
        record_label: `ESS/${input.orderNumber}`,
        after: { origin: 'channel' },
      });
      expect(edited.find((e) => e.orderId === orderId)).toMatchObject({
        origin: 'channel',
        cancelledLineIds: [page.lines[0]?.id, page.lines[1]?.id],
        addedLineIds: [page.lines[2]?.id],
      });
    });

    it('applies nothing while a write back command is open, raising no attention; applies once it syncs', async () => {
      const input = channelInput();
      const { orderId } = await create(input);
      const command = await openCommand(orderId);
      const before = await orderRow(orderId);
      const snapshot = snapshotOf(input, { shippingChargedAmount: '70.00' });

      const held = await run((tx) => intake().applyChannelEdit(tx, orderId, snapshot, job()));
      const after = await orderRow(orderId);
      await owner(
        `UPDATE outbound_commands SET sync_state = 'synced', synced_at = now() WHERE id = $1::uuid`,
        [command],
      );
      const applied = await run((tx) => intake().applyChannelEdit(tx, orderId, snapshot, job()));

      expect(held).toEqual({ applied: false, why: 'write_back_open' });
      expect(after?.updated_at).toBe(before?.updated_at);
      expect(attentionsOf(orderId)).toEqual([]);
      expect(applied).toEqual({ applied: true, changed: true });
      expect((await detail(orderId)).money.shippingChargedAmount).toBe('70.00');
    });

    it('matches a line with no channel id by variant, quantity, and price; recordChannelLineIds makes the echo a no change', async () => {
      // A MAIN store channel order, so a person may add the L line in the app (no write back).
      const input = channelInput({
        storeId: mainStore,
        channelId: manualChannel,
        lines: [line()],
      });
      const { orderId } = await create(input);
      const page = await detail(orderId);
      const add = await api.call(support, 'POST', `/api/orders/${orderId}/edits`, {
        expectedUpdatedAt: page.updatedAt,
        operations: [{ kind: 'add_line', variantId: skuL, quantity: 1, unitPrice: '400.00' }],
      });
      expect(add.status, JSON.stringify(add.body)).toBe(200);
      const added = OrderDetail.parse(add.body).lines.find((x) => x.variantId === skuL)
        ?.id as string;
      const lLine = line({
        channelLineId: 'cl-l-matched',
        variantId: skuL,
        title: 'Tee L',
        unitPrice: '400.00',
      });

      const matched = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snapshotOf(input, { lines: [...input.lines, lLine] }),
          job(),
        ),
      );
      const lines = await owner<{ id: string; channel_line_id: string | null }>(
        `SELECT id, channel_line_id FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [orderId],
      );

      expect(matched).toEqual({ applied: true, changed: false });
      expect(lines.rows).toHaveLength(2);
      expect(lines.rows.find((r) => r.id === added)?.channel_line_id).toBe('cl-l-matched');

      // A second added line, then the executor records its id: the echo changes nothing.
      const page2 = await detail(orderId);
      const add2 = await api.call(support, 'POST', `/api/orders/${orderId}/edits`, {
        expectedUpdatedAt: page2.updatedAt,
        operations: [{ kind: 'add_line', variantId: skuL, quantity: 3, unitPrice: '400.00' }],
      });
      const second = OrderDetail.parse(add2.body).lines.find((x) => x.quantity === 3)?.id as string;
      const recorded = await run((tx) =>
        intake().recordChannelLineIds(
          tx,
          orderId,
          [{ lineId: second, channelLineId: 'cl-l-3' }],
          job(),
        ),
      );
      const echo = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snapshotOf(input, {
            lines: [
              ...input.lines,
              lLine,
              line({ channelLineId: 'cl-l-3', variantId: skuL, quantity: 3, unitPrice: '400.00' }),
            ],
          }),
          job(),
        ),
      );
      const conflict = await failureOf(
        run((tx) =>
          intake().recordChannelLineIds(
            tx,
            orderId,
            [{ lineId: second, channelLineId: 'cl-other' }],
            job(),
          ),
        ),
      );

      expect(recorded).toEqual({ recorded: 1 });
      expect(echo).toEqual({ applied: true, changed: false });
      expect(conflict).toMatchObject({ code: 'ChannelLineIdConflict' });
      expect((await auditOf(orderId)).filter((e) => e.actor_kind === 'system_job')).toEqual([]);
    });

    it('applies nothing once the carrier delivery exists (Shopify fulfillment source), raising channel_edit_not_applied; an echo raises nothing', async () => {
      const input = channelInput();
      const { orderId } = await create(input);

      const delivered = await recordDelivery(orderId, 'shopify_fulfillment');
      const echo = await run((tx) =>
        intake().applyChannelEdit(tx, orderId, snapshotOf(input), job()),
      );
      const refused = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snapshotOf(input, { lines: [{ ...input.lines[0], quantity: 3 }] }),
          job(),
        ),
      );
      const page = await detail(orderId);

      expect(delivered).toEqual({ applied: true });
      expect(page.carrierDeliveryCreatedAt).not.toBeNull();
      expect(echo).toEqual({ applied: true, changed: false });
      expect(refused).toEqual({ applied: false, why: 'carrier_delivery_exists' });
      expect(attentionsOf(orderId)).toEqual([['channel_edit_not_applied', 'order']]);
      expect(page.lines.every((x) => x.lineState === 'open')).toBe(true);
    });

    it('refuses an overpaying snapshot as an attention, and never changes the prepayment', async () => {
      const prepaid = channelInput({
        paymentMethod: 'gateway',
        prepaidAmount: '1020.00',
        prepaidMethod: 'gateway',
      });
      const { orderId } = await create(prepaid);
      const deposit = channelInput({
        paymentMethod: 'cod',
        prepaidAmount: '100.00',
        prepaidMethod: 'instapay',
      });
      const second = await create(deposit);

      const overpaid = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snapshotOf(prepaid, { lines: [prepaid.lines[0]] }),
          job(),
        ),
      );
      const grown = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          second.orderId,
          snapshotOf(deposit, { lines: [...deposit.lines, line({ channelLineId: 'cl-extra' })] }),
          job(),
        ),
      );

      expect(overpaid).toEqual({ applied: false, why: 'overpaid' });
      expect(attentionsOf(orderId)).toEqual([['channel_edit_not_applied', 'order']]);
      expect(grown).toEqual({ applied: true, changed: true });
      expect((await orderRow(second.orderId))?.prepaid_amount).toBe('100.00');
      expect(
        ChannelOrderSnapshot.safeParse({ ...snapshotOf(deposit), prepaidAmount: '0.00' }).success,
      ).toBe(false);
    });

    it('unlinks the customer when the main phone stops parsing and drops a bad second phone (review N4)', async () => {
      const input = channelInput({
        shipTo: { name: 'Sentinel Name', phone: phone(), phoneAlt: phone(), address: 'x' },
      });
      const { orderId } = await create(input);
      expect((await orderRow(orderId))?.customer_id).not.toBeNull();

      const result = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snapshotOf(input, {
            shipTo: { ...input.shipTo, phone: '01x 9999', phoneAlt: 'not a phone' },
          }),
          job(),
        ),
      );
      const row = await orderRow(orderId);

      expect(result).toEqual({ applied: true, changed: true });
      expect(row).toMatchObject({
        customer_id: null,
        ship_to_phone: null,
        contact_phone_raw: '01x 9999',
        ship_to_phone_alt: null,
      });
      expect(attentionsOf(orderId)).toEqual([
        ['phone_unparseable', 'order'],
        ['phone_unparseable', 'ship_to_phone_alt'],
      ]);
      const allText = (
        await owner<{ text: string }>(`SELECT row_to_json(a)::text AS text FROM audit_entries a`)
      ).rows
        .map((r) => r.text)
        .join('\n');
      expect(allText).not.toContain('01x 9999');
      expect(allText).not.toContain('Sentinel customer note');
    });

    it('sends a packed order back to confirmed with a system job event', async () => {
      const input = channelInput({ storeId: mainStore, channelId: manualChannel });
      const { orderId } = await create(input);
      for (const what of ['confirm', 'pack']) {
        const { updatedAt } = await detail(orderId);
        const reply = await api.call(
          what === 'pack' ? await api.signIn((await api.addPerson(['warehouse'])).email) : support,
          'POST',
          `/api/orders/${orderId}/${what}`,
          { expectedUpdatedAt: updatedAt },
        );
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      }

      await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snapshotOf(input, { shippingChargedAmount: '60.00' }),
          job(),
        ),
      );
      const events = await eventsOf(orderId);

      expect((await detail(orderId)).fulfillmentState).toBe('confirmed');
      expect(events.at(-1)).toMatchObject({
        machine: 'fulfillment',
        from_state: 'packed',
        to_state: 'confirmed',
        actor_type: 'system_job',
        reason_code: 'channel_edit',
      });
    });
  });

  describe('channel cancel (AC-14)', () => {
    it('cancels a confirmed order by system_job with a channel. reason', async () => {
      const input = channelInput({ storeId: mainStore, channelId: manualChannel });
      const { orderId } = await create(input);
      const { updatedAt } = await detail(orderId);
      await api.call(support, 'POST', `/api/orders/${orderId}/confirm`, {
        expectedUpdatedAt: updatedAt,
      });

      const result = await run((tx) =>
        intake().cancelFromChannel(tx, orderId, 'channel.customer', job()),
      );
      const page = await detail(orderId);
      const events = await eventsOf(orderId);

      expect(result).toEqual({ applied: true });
      expect(page).toMatchObject({
        fulfillmentState: 'cancelled',
        cashState: 'nothing_to_collect',
      });
      expect(events.find((e) => e.to_state === 'cancelled')).toMatchObject({
        actor_type: 'system_job',
        reason_code: 'channel.customer',
      });
      const other = await create(channelInput());
      await expect(
        run((tx) => intake().cancelFromChannel(tx, other.orderId, 'customer', job())),
      ).rejects.toBeInstanceOf(InvalidTransition);
    });

    it('changes nothing on an order already returned, and raises channel_cancel_after_pickup on a delivered one', async () => {
      const returned = await create(
        channelInput({
          firstStates: { fulfillment: 'returned_to_origin', cash: 'nothing_to_collect' },
        }),
        importRun(),
      );
      const delivered = await create(
        channelInput({ firstStates: { fulfillment: 'delivered', cash: 'collected_by_carrier' } }),
        importRun(),
      );

      const echo = await run((tx) =>
        intake().cancelFromChannel(tx, returned.orderId, 'channel.customer', job()),
      );
      const late = await run((tx) =>
        intake().cancelFromChannel(tx, delivered.orderId, 'channel.customer', job()),
      );

      expect(echo).toEqual({ applied: false, why: 'already_final' });
      expect(attentionsOf(returned.orderId)).toEqual([]);
      expect((await detail(returned.orderId)).fulfillmentState).toBe('returned_to_origin');
      expect(late).toEqual({ applied: false, why: 'after_pickup' });
      expect(attentionsOf(delivered.orderId)).toEqual([['channel_cancel_after_pickup', 'order']]);
      expect((await detail(delivered.orderId)).fulfillmentState).toBe('delivered');
    });
  });

  describe("feature 13's calls (AC-25, AC-23)", () => {
    it('starts a go live import confirmed with one go_live_import event, the first cash event, and no audit entry', async () => {
      const input = channelInput({
        firstStates: { fulfillment: 'confirmed', reasonCode: 'go_live_import' },
      });

      const { orderId } = await create(input);
      const events = await eventsOf(orderId);
      const row = await orderRow(orderId);

      expect(events).toEqual([
        {
          machine: 'fulfillment',
          from_state: null,
          to_state: 'confirmed',
          actor_type: 'system_job',
          reason_code: 'go_live_import',
        },
        {
          machine: 'cash',
          from_state: null,
          to_state: 'unpaid',
          actor_type: 'system_job',
          reason_code: null,
        },
      ]);
      expect(row?.confirmed_at).toBe(row?.placed_at);
      expect(row?.confirmed_by).toBeNull();
      expect(await auditOf(orderId)).toEqual([]);
      await expect(
        create(
          channelInput({ firstStates: { fulfillment: 'confirmed', reasonCode: 'go_live_import' } }),
          importRun(),
        ),
      ).rejects.toBeInstanceOf(InvalidOrderInput);
      await expect(
        create(channelInput({ firstStates: { fulfillment: 'delivered', cash: 'unpaid' } }), job()),
      ).rejects.toBeInstanceOf(InvalidOrderInput);
    });

    it('links an unmapped line: variant set, no edit, no audit; a mapped line refuses; a delivered order raises shipped_with_unmapped_lines', async () => {
      const unmapped = line({ variantId: null, title: 'Mystery tee' });
      const input = channelInput({
        firstStates: { fulfillment: 'confirmed', reasonCode: 'go_live_import' },
        lines: [unmapped],
      });
      const { orderId } = await create(input);
      const before = await orderRow(orderId);

      const linked = await run((tx) =>
        intake().linkChannelLineVariant(tx, orderId, unmapped.channelLineId, skuM),
      );
      const again = await failureOf(
        run((tx) => intake().linkChannelLineVariant(tx, orderId, unmapped.channelLineId, skuL)),
      );
      const shippedLine = line({ variantId: null, title: 'Late tee' });
      const shipped = await create(
        channelInput({
          firstStates: { fulfillment: 'delivered', cash: 'collected_by_carrier' },
          lines: [shippedLine],
        }),
        importRun(),
      );
      const late = await run((tx) =>
        intake().linkChannelLineVariant(tx, shipped.orderId, shippedLine.channelLineId, skuM),
      );

      expect(linked).toMatchObject({ reserved: true });
      expect((await detail(orderId)).lines[0]?.variantId).toBe(skuM);
      expect((await orderRow(orderId))?.updated_at).toBe(before?.updated_at);
      expect(edited.filter((e) => e.orderId === orderId)).toEqual([]);
      expect(await auditOf(orderId)).toEqual([]);
      expect(again).toBeInstanceOf(LineAlreadyMapped);
      expect(late).toMatchObject({ reserved: false });
      expect(attentionsOf(shipped.orderId)).toEqual([
        ['shipped_with_unmapped_lines', 'order_line'],
      ]);
    });

    it('rederives a prepaid gateway order to cod: prepaid to unpaid, COD expected the total, audited; locked after a collection or a delivery', async () => {
      const input = channelInput({
        paymentMethod: 'gateway',
        prepaidAmount: '1020.00',
        prepaidMethod: 'gateway',
      });
      const { orderId } = await create(input);
      expect((await detail(orderId)).cashState).toBe('prepaid');

      const result = await run((tx) =>
        intake().rederivePaymentMethod(
          tx,
          orderId,
          { paymentMethod: 'cod', prepaidAmount: '0.00', prepaidMethod: null },
          job(),
        ),
      );
      const page = await detail(orderId);
      const events = await eventsOf(orderId);

      expect(result).toEqual({ changed: true });
      expect(page).toMatchObject({ cashState: 'unpaid' });
      expect(page.money).toMatchObject({
        paymentMethod: 'cod',
        prepaidAmount: '0.00',
        prepaidMethod: null,
        codExpectedAmount: '1020.00',
        codDueAmount: '1020.00',
      });
      expect(events.at(-1)).toMatchObject({
        machine: 'cash',
        from_state: 'prepaid',
        to_state: 'unpaid',
        actor_type: 'system_job',
        reason_code: 'payment_method_rederived',
      });
      expect((await auditOf(orderId)).map((e) => [e.action, e.reason, e.actor_kind])).toEqual([
        ['order.payment_method_rederived', 'gateway_mapping_changed', 'system_job'],
      ]);
      expect(
        replayStates(
          events.map((e) => ({ machine: e.machine, fromState: e.from_state, toState: e.to_state })),
        ),
      ).toEqual({
        fulfillment: 'new',
        cash: 'unpaid',
      });

      // A collection, planted as the owner until milestone 5's recordCollection.
      await owner(`UPDATE orders SET cod_collected_amount = 100 WHERE id = $1::uuid`, [orderId]);
      await expect(
        run((tx) =>
          intake().rederivePaymentMethod(
            tx,
            orderId,
            { paymentMethod: 'gateway', prepaidAmount: '1020.00', prepaidMethod: 'gateway' },
            job(),
          ),
        ),
      ).rejects.toBeInstanceOf(PaymentMethodLocked);
      const frozen = await create(channelInput());
      await recordDelivery(frozen.orderId, 'carrier_delivery');
      await expect(
        run((tx) =>
          intake().rederivePaymentMethod(
            tx,
            frozen.orderId,
            { paymentMethod: 'gateway', prepaidAmount: '1020.00', prepaidMethod: 'gateway' },
            job(),
          ),
        ),
      ).rejects.toBeInstanceOf(PaymentMethodLocked);
    });

    it('takes replacement_for from the channel for a delivered original, and refuses a confirmed one', async () => {
      const original = await create(
        channelInput({ firstStates: { fulfillment: 'delivered', cash: 'collected_by_carrier' } }),
        importRun(),
      );
      const open = await create(channelInput());

      const replacement = await create(
        channelInput({ relatedOrder: { orderId: original.orderId, relation: 'replacement_for' } }),
      );
      const page = await detail(replacement.orderId);

      expect(page.type).toBe('exchange_replacement');
      expect(page.relatedOrder).toMatchObject({
        id: original.orderId,
        relation: 'replacement_for',
      });
      await expect(
        create(
          channelInput({ relatedOrder: { orderId: open.orderId, relation: 'replacement_for' } }),
        ),
      ).rejects.toBeInstanceOf(RelatedOrderState);
    });
  });

  describe('closed order import (AC-14; reservations are milestone 4, the shipment job milestone 5)', () => {
    it('creates a delivered and reconciled order in its found states: one event per machine, nothing held, no shipment job', async () => {
      const { orderId } = await create(
        channelInput({
          firstStates: {
            fulfillment: 'delivered',
            cash: 'reconciled',
            carrierDeliveryCreatedAt: '2026-10-02T09:00:00.000Z',
          },
        }),
        importRun(),
      );
      const page = await detail(orderId);
      const events = await eventsOf(orderId);
      const jobs = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM pgboss.job WHERE name = 'orders.post_shipment'`,
      );

      expect(events).toEqual([
        {
          machine: 'fulfillment',
          from_state: null,
          to_state: 'delivered',
          actor_type: 'import',
          reason_code: null,
        },
        {
          machine: 'cash',
          from_state: null,
          to_state: 'reconciled',
          actor_type: 'import',
          reason_code: null,
        },
      ]);
      expect(page.lines.map((x) => [x.lineState, x.shortQuantity])).toEqual([
        ['delivered', 0],
        ['delivered', 0],
      ]);
      expect(page.carrierDeliveryCreatedAt).toBe('2026-10-02T09:00:00.000000Z');
      expect(page.money).toMatchObject({
        codCollectedAmount: '1020.00',
        remittedAmount: '1020.00',
      });
      expect(jobs.rows[0]?.count).toBe('0');
    });

    it('creates a found new order as usual', async () => {
      const { orderId } = await create(
        channelInput({ firstStates: { fulfillment: 'new', cash: 'unpaid' } }),
        importRun(),
      );

      expect(await detail(orderId)).toMatchObject({ fulfillmentState: 'new', cashState: 'unpaid' });
      expect((await detail(orderId)).lines.every((x) => x.lineState === 'open')).toBe(true);
    });
  });

  describe('B1: the store beside every number (AC-3, AC-14)', () => {
    it('holds #1001 in two stores, finds both, refuses a second #1001 in ESS, and labels the audit ESS/#1001', async () => {
      const ess = channelInput({ orderNumber: '#1001' });
      const main = channelInput({
        orderNumber: '#1001',
        storeId: mainStore,
        channelId: manualChannel,
      });

      const inEss = await create(ess);
      await create(main);
      const list = await api.call(support, 'GET', '/api/orders?q=1001');
      const taken = await failureOf(create(channelInput({ orderNumber: '#1001' })));
      await run((tx) =>
        intake().applyChannelEdit(
          tx,
          inEss.orderId,
          snapshotOf(ess, { shippingChargedAmount: '55.00' }),
          job(),
        ),
      );

      expect(list.status).toBe(200);
      expect(
        OrderListResponse.parse(list.body)
          .items.map((item) => `${item.storeCode}/${item.orderNumber}`)
          .sort(),
      ).toEqual(['ESS/#1001', 'MAIN/#1001']);
      expect(taken).toBeInstanceOf(OrderNumberTaken);
      expect((await auditOf(inEss.orderId)).map((e) => e.record_label)).toEqual(['ESS/#1001']);
    });
  });

  it('keeps the manual path unchanged beside the channel one (a smoke check)', async () => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Sentinel Name', phone: phone(), address: 'x' },
      lines: [{ variantId: skuM, quantity: 1, unitPrice: '570.00' }],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });

    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(CreatedOrder.parse(reply.body).storeCode).toBe('MAIN');
  });
});
