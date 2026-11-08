import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  OrderDetail,
  OrderListResponse,
  SkuDetail,
  replayStates,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OutboundCommandFailed,
  OutboundCommandQueued,
  OutboundCommandSynced,
} from '../src/connectors/connectors.events.js';
import { DATABASE } from '../src/database/database.module.js';
import type { Transaction } from '../src/database/sql.js';
import { OrderTransactions } from '../src/orders/order-transactions.js';
import {
  OrderAttentionRaised,
  OrderCancelled,
  OrderEdited,
  OrderStateChanged,
} from '../src/orders/orders.events.js';
import { OrderTransitions } from '../src/orders/transitions/order-transitions.service.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0013 milestone 2 (AC-2, AC-7 to AC-10, AC-12, AC-18, AC-19): editing, confirming,
// cancelling, packing, and the write back hold, through the real routes as the application role.
// A fixture connector stands in for spec 0015's command writer: on `OrderEdited` (when switched
// on) it inserts an `outbound_commands` row and publishes `OutboundCommandQueued` in the edit's
// own transaction, and `syncCommand` settles one in a transaction of its own, as an executor will.
describe(
  'orders, milestone 2: edit, confirm, cancel, pack, and the hold',
  { timeout: 240_000 },
  () => {
    let api: InProcessApi;
    let manager = '';
    let support = '';
    let warehouse = '';
    let mainStore = '';
    let manualChannel = '';
    let shopifyStore = '';
    let shopifyChannel = '';
    let connection = '';
    let skuM = '';
    let skuL = '';
    let skuXl = '';
    let n = 0;
    let queueOnEdit = false;
    let supportId = '';
    const stateChanges: OrderStateChanged[] = [];
    const edited: OrderEdited[] = [];
    const cancelled: OrderCancelled[] = [];
    const attentions: OrderAttentionRaised[] = [];

    const phone = () => {
      n += 1;
      return `0101${String(1_000_000 + n)}`;
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

    const create = async (over: Record<string, unknown> = {}) => {
      const reply = await api.call(support, 'POST', '/api/orders', body(over));
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return CreatedOrder.parse(reply.body).id;
    };

    const detail = async (id: string) => {
      const reply = await api.call(support, 'GET', `/api/orders/${id}`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return OrderDetail.parse(reply.body);
    };

    /** Calls a move with the order's current `updatedAt` unless the body names another. */
    const move = async (
      id: string,
      what: 'edits' | 'confirm' | 'cancel' | 'pack' | 'unpack',
      extra: Record<string, unknown> = {},
      cookie = support,
    ) => {
      const { updatedAt } = await detail(id);
      return api.call(cookie, 'POST', `/api/orders/${id}/${what}`, {
        expectedUpdatedAt: updatedAt,
        ...extra,
      });
    };

    const ok = (reply: { status: number; body: unknown }) => {
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return OrderDetail.parse(reply.body);
    };

    const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) => api.owner.pool.query<T>(text, params);

    /** Moves an order into the Shopify store, as feature 13's intake will place one. */
    const intoShopify = (id: string) =>
      owner(`UPDATE orders SET store_id = $2::uuid, channel_id = $3::uuid WHERE id = $1::uuid`, [
        id,
        shopifyStore,
        shopifyChannel,
      ]);

    const recordDelivery = (id: string) =>
      api.app
        .get(OrderTransactions)
        .run((tx) =>
          api.app
            .get(OrderTransitions)
            .recordCarrierDelivery(
              tx,
              id,
              { at: new Date(), source: { type: 'carrier_delivery', id: randomUUID() } },
              { type: 'system_job', job: 'orders-edit-e2e', jobId: randomUUID() },
            ),
        );

    /** Settles a command the way an executor will: its row and its event in one transaction. */
    const settleCommand = async (commandId: string, to: 'synced' | 'failed') => {
      const connectionPool = api.app.get<DatabaseConnection>(DATABASE);
      await connectionPool.db.transaction((tx) => settleIn(tx, commandId, to));
    };

    /** The row change and the event of one settled command, in the caller's transaction. */
    const settleIn = async (tx: Transaction, commandId: string, to: 'synced' | 'failed') => {
      const events = api.app.get(DomainEvents);
      const { rows } = await tx.execute<{ linked_id: string; kind: string }>(sql`
        UPDATE outbound_commands
        SET sync_state = ${to}::outbound_sync_state,
            failure_reason = ${to === 'failed' ? 'STEP_OFF' : null},
            synced_at = ${to === 'synced' ? sql`now()` : null}
        WHERE id = ${commandId}::uuid RETURNING linked_id, kind`);
      const row = rows[0];
      if (!row) throw new Error('No such command');
      const event =
        to === 'synced'
          ? new OutboundCommandSynced(commandId, connection, row.kind, 'order', row.linked_id)
          : new OutboundCommandFailed(
              commandId,
              connection,
              row.kind,
              'order',
              row.linked_id,
              'STEP_OFF',
            );
      await events.publish(tx, event);
    };

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
      shopifyStore = await one(
        `INSERT INTO stores (code, name, public_name, kind)
       VALUES ('ESS', '{"en":"Essentials"}', '{"en":"Essentials"}', 'shopify') RETURNING id`,
      );
      shopifyChannel = await one(
        `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('ESS', '{"en":"Essentials"}', 'shopify', '${shopifyStore}') RETURNING id`,
      );
      connection = await one(
        `INSERT INTO connections (provider, label, store_id, shop_domain)
       VALUES ('shopify', 'Essentials', '${shopifyStore}', 'ess.myshopify.com') RETURNING id`,
      );
      const sku = async (code: string) => {
        const reply = await api.call(manager, 'POST', '/api/products', {
          name: { en: `Tee ${code}` },
          variants: [{ sku: code, price: '570.00' }],
        });
        expect(reply.status, JSON.stringify(reply.body)).toBe(201);
        return SkuDetail.parse(reply.body).id;
      };
      skuM = await sku('ED-M');
      skuL = await sku('ED-L');
      skuXl = await sku('ED-XL');
      const events = api.app.get(DomainEvents);
      events.on(OrderEdited, (_tx, event) => void edited.push(event), 'orders-edit-e2e');
      events.on(OrderCancelled, (_tx, event) => void cancelled.push(event), 'orders-edit-e2e');
      events.on(
        OrderStateChanged,
        (_tx, event) => void stateChanges.push(event),
        'orders-edit-e2e',
      );
      events.on(
        OrderAttentionRaised,
        (_tx, event) => void attentions.push(event),
        'orders-edit-e2e',
      );
      // The fixture connector: a person's edit queues one write back command in its transaction.
      events.on(
        OrderEdited,
        async (tx, event) => {
          if (!queueOnEdit || event.origin !== 'person') return;
          const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO outbound_commands (connection_id, kind, linked_type, linked_id, payload, idempotency_key)
          VALUES (${connection}::uuid, 'shopify.order_edit', 'order', ${event.orderId}::uuid, '{}'::jsonb,
                  ${`fixture:${randomUUID()}`})
          RETURNING id`);
          const id = rows[0]?.id as string;
          await events.publish(
            tx,
            new OutboundCommandQueued(id, connection, 'shopify.order_edit', 'order', event.orderId),
          );
        },
        'fixture-connector',
      );
    });

    afterAll(async () => {
      await api?.close();
    });

    describe('edits (AC-9, AC-11)', () => {
      it('replaces a line and fixes the address in one call, recomputing the money', async () => {
        const id = await create();
        const before = await detail(id);
        const lineM = before.lines.find((line) => line.position === 1)?.id as string;

        const after = ok(
          await move(id, 'edits', {
            reasonCode: 'size_change',
            operations: [
              {
                kind: 'replace_line',
                lineId: lineM,
                variantId: skuXl,
                quantity: 2,
                unitPrice: '600.00',
              },
              { kind: 'ship_to', address: '77 New Sentinel Road' },
            ],
          }),
        );

        expect(
          after.lines.map((l) => [l.position, l.skuCode, l.lineState, l.cancelReasonCode]),
        ).toEqual([
          [1, 'ED-M', 'cancelled', 'edit_removal'],
          [2, 'ED-L', 'open', null],
          [3, 'ED-XL', 'open', null],
        ]);
        expect(after.money).toMatchObject({
          linesGrossAmount: '1600.00',
          totalAmount: '1650.00',
          codExpectedAmount: '1650.00',
          codDueAmount: '1650.00',
        });
        expect(after.shipTo.address).toBe('77 New Sentinel Road');
        expect(after.fulfillmentState).toBe('new');
        expect(after.updatedAt).not.toBe(before.updatedAt);
        const entries = await owner(
          `SELECT reason FROM audit_entries WHERE action = 'order.edited' AND record_id = $1::uuid`,
          [id],
        );
        expect(entries.rows).toEqual([{ reason: 'size_change' }]);
        const event = edited.find((e) => e.orderId === id);
        expect(event).toMatchObject({
          origin: 'person',
          cancelledLineIds: [lineM],
          changedShipToFields: ['address'],
          shippingChanged: false,
        });
        expect(event?.addedLineIds).toEqual([after.lines[2]?.id]);
        expect(JSON.stringify(event)).not.toContain('Sentinel');
      });

      it('changes the shipping charge and writes nothing for an edit that changes nothing', async () => {
        const id = await create();
        const shipping = ok(
          await move(id, 'edits', {
            operations: [{ kind: 'shipping', shippingChargedAmount: '0' }],
          }),
        );
        const same = ok(
          await move(id, 'edits', {
            operations: [{ kind: 'shipping', shippingChargedAmount: '0.00' }],
          }),
        );
        const entries = await owner(
          `SELECT count(*)::int AS count FROM audit_entries WHERE action = 'order.edited' AND record_id = $1::uuid`,
          [id],
        );

        expect(shipping.money.totalAmount).toBe('1540.00');
        expect(same.updatedAt).toBe(shipping.updatedAt);
        expect(entries.rows[0]).toEqual({ count: 1 });
      });

      it('links the customer and clears the phone kept as typed when an edit fixes it', async () => {
        const id = await create({
          shipTo: { name: 'Sentinel Name', phone: '01x 2345', address: 'x' },
        });
        const before = await detail(id);

        const after = ok(
          await move(id, 'edits', { operations: [{ kind: 'ship_to', phone: phone() }] }),
        );

        expect(before.customer).toBeNull();
        expect(before.shipTo.contactPhoneRaw).toBe('01x 2345');
        expect(after.customer).not.toBeNull();
        expect(after.shipTo.contactPhoneRaw).toBeNull();
        expect(after.shipTo.phone).toMatch(/^\+2010/);
      });
    });

    describe('edit refusals (AC-8, AC-9, AC-10)', () => {
      it('answers 409 ORDER_STALE for an old token and changes nothing', async () => {
        const id = await create();
        const { updatedAt } = await detail(id);
        ok(await move(id, 'edits', { operations: [{ kind: 'ship_to', address: 'First' }] }));

        const stale = await api.call(support, 'POST', `/api/orders/${id}/edits`, {
          expectedUpdatedAt: updatedAt,
          operations: [{ kind: 'ship_to', address: 'Second' }],
        });

        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: 'ORDER_STALE' });
        expect((await detail(id)).shipTo.address).toBe('First');
      });

      it('refuses to leave no open line, to change how it is paid, and to overpay', async () => {
        const single = await create({
          lines: [{ variantId: skuM, quantity: 1, unitPrice: '570.00' }],
        });
        const lastLine = (await detail(single)).lines[0]?.id;
        const prepaid = await create({ paymentMethod: 'instapay', prepaidAmount: '1590.00' });
        const big = await create({
          lines: [
            { variantId: skuM, quantity: 1, unitPrice: '1000.00' },
            { variantId: skuL, quantity: 1, unitPrice: '1000.00' },
          ],
          shippingChargedAmount: '0',
          paymentMethod: 'instapay',
          prepaidAmount: '2000.00',
        });
        const bigLine = (await detail(big)).lines[1]?.id;

        const noLine = await move(single, 'edits', {
          operations: [
            { kind: 'remove_line', lineId: lastLine, cancelReasonCode: 'customer_cancelled' },
          ],
        });
        const payment = await move(prepaid, 'edits', {
          operations: [{ kind: 'add_line', variantId: skuXl, quantity: 1, unitPrice: '100.00' }],
        });
        const overpaid = await move(big, 'edits', {
          operations: [
            { kind: 'remove_line', lineId: bigLine, cancelReasonCode: 'customer_cancelled' },
          ],
        });

        expect([noLine.status, payment.status, overpaid.status]).toEqual([422, 422, 422]);
        expect(noLine.body).toMatchObject({ code: 'ORDER_NEEDS_A_LINE' });
        expect(payment.body).toMatchObject({ code: 'EDIT_CHANGES_PAYMENT' });
        expect(overpaid.body).toMatchObject({ code: 'EDIT_OVERPAID' });
        expect((await detail(big)).money.totalAmount).toBe('2000.00');
      });

      it('sends a Shopify store order to Shopify while its write back is unavailable', async () => {
        const id = await create();
        await intoShopify(id);

        const reply = await move(id, 'edits', { operations: [{ kind: 'ship_to', address: 'x' }] });

        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'EDIT_IN_SHOPIFY' });
      });

      it('locks every edit once the carrier delivery exists and keeps the money frozen', async () => {
        const id = await create();
        await recordDelivery(id);
        const again = await recordDelivery(id);

        const reply = await move(id, 'edits', {
          operations: [{ kind: 'shipping', shippingChargedAmount: '0' }],
        });
        const after = await detail(id);

        expect(again).toEqual({ applied: false });
        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'ORDER_LOCKED' });
        expect(after.carrierDeliveryCreatedAt).not.toBeNull();
        expect(after.money.codExpectedAmount).toBe('1590.00');
      });

      it('answers 422 REASON_INVALID for an unknown reason and INVALID_BODY for a bad operation', async () => {
        const id = await create();

        const reason = await move(id, 'edits', {
          reasonCode: 'whim',
          operations: [{ kind: 'ship_to', address: 'x' }],
        });
        const bad = await move(id, 'edits', { operations: [{ kind: 'ship_to' }] });
        const unknown = await move(id, 'edits', {
          operations: [
            { kind: 'add_line', variantId: randomUUID(), quantity: 1, unitPrice: '1.00' },
          ],
        });

        expect(reason.status).toBe(422);
        expect(reason.body).toMatchObject({ code: 'REASON_INVALID' });
        expect(bad.body).toMatchObject({ code: 'INVALID_BODY' });
        expect(unknown.body).toMatchObject({ code: 'VARIANT_UNKNOWN' });
      });
    });

    describe('gifted edit rules (AC-2)', () => {
      it('lets support fix the address but not the lines, and keeps every line free', async () => {
        const reply = await api.call(manager, 'POST', '/api/orders/gifted', {
          clientRef: randomUUID(),
          storeId: mainStore,
          channelId: manualChannel,
          shipTo: { name: 'Sentinel Name', phone: phone(), address: 'x' },
          lines: [{ variantId: skuM, quantity: 1, unitPrice: '500.00', discountAmount: '500.00' }],
          giftReasonCode: 'influencer',
        });
        const id = CreatedOrder.parse(reply.body).id;
        const free = {
          kind: 'add_line',
          variantId: skuL,
          quantity: 1,
          unitPrice: '300.00',
          discountAmount: '300.00',
        };

        const address = await move(id, 'edits', {
          operations: [{ kind: 'ship_to', address: 'Influencer St' }],
        });
        const lineBySupport = await move(id, 'edits', { operations: [free] });
        const priced = await move(
          id,
          'edits',
          { operations: [{ kind: 'add_line', variantId: skuL, quantity: 1, unitPrice: '300.00' }] },
          manager,
        );
        const shipping = await move(
          id,
          'edits',
          { operations: [{ kind: 'shipping', shippingChargedAmount: '30.00' }] },
          manager,
        );
        const freeLine = await move(id, 'edits', { operations: [free] }, manager);

        expect(ok(address).shipTo.address).toBe('Influencer St');
        expect(lineBySupport.status).toBe(403);
        expect(lineBySupport.body).toMatchObject({ code: 'GIFT_NOT_ALLOWED' });
        expect(priced.body).toMatchObject({ code: 'GIFT_MUST_STAY_FREE' });
        expect(shipping.body).toMatchObject({ code: 'GIFT_MUST_STAY_FREE' });
        expect(ok(freeLine).lines).toHaveLength(2);
        expect(ok(freeLine).money.totalAmount).toBe('0.00');
      });
    });

    describe('the write back hold and the packed guard (AC-7, AC-12)', () => {
      it('holds packing while the edit command is open, whatever write_back_state says, until it syncs', async () => {
        const id = await create();
        ok(await move(id, 'confirm'));
        queueOnEdit = true;
        const queued = await move(id, 'edits', {
          operations: [{ kind: 'ship_to', address: 'Held St' }],
        });
        queueOnEdit = false;
        const held = ok(queued);
        const commandId = held.writeBackCommands?.[0]?.id as string;
        const list = OrderListResponse.parse(
          (await api.call(support, 'GET', `/api/orders?hold=true&limit=100`)).body,
        );

        const refused = await move(id, 'pack', {}, warehouse);
        await owner(`UPDATE orders SET write_back_state = 'none' WHERE id = $1::uuid`, [id]);
        const stillRefused = await move(id, 'pack', {}, warehouse);
        await settleCommand(commandId, 'synced');
        const synced = await detail(id);
        const packed = ok(await move(id, 'pack', {}, warehouse));

        expect(held.writeBackState).toBe('waiting');
        expect(held.writeBackCommands).toEqual([
          expect.objectContaining({
            kind: 'shopify.order_edit',
            syncState: 'waiting',
            failureReason: null,
          }),
        ]);
        expect(list.items.find((item) => item.id === id)?.hold).toBe(true);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'WRITE_BACK_OPEN' });
        expect(stillRefused.body).toMatchObject({ code: 'WRITE_BACK_OPEN' });
        expect(synced.writeBackState).toBe('none');
        expect(synced.writeBackCommands).toEqual([]);
        expect(packed.fulfillmentState).toBe('packed');
      });

      it('shows a failed command as failed with its code, and moves a packed order back on edit', async () => {
        const id = await create();
        ok(await move(id, 'confirm'));
        ok(await move(id, 'pack', {}, warehouse));
        queueOnEdit = true;
        const edit = ok(
          await move(id, 'edits', { operations: [{ kind: 'ship_to', address: 'Back St' }] }),
        );
        queueOnEdit = false;
        await settleCommand(edit.writeBackCommands?.[0]?.id as string, 'failed');
        const failed = await detail(id);

        expect(edit.fulfillmentState).toBe('confirmed');
        expect(edit.events.slice(-1).map((e) => [e.fromState, e.toState, e.actorType])).toEqual([
          ['packed', 'confirmed', 'person'],
        ]);
        expect(failed.writeBackState).toBe('failed');
        expect(failed.writeBackCommands?.[0]).toMatchObject({
          syncState: 'failed',
          failureReason: 'STEP_OFF',
        });
      });
    });

    describe('cancel (AC-7, AC-8)', () => {
      it('cancels a confirmed duplicate: lines and totals kept, nothing due, nothing to collect, linked', async () => {
        const target = await create();
        const id = await create();
        ok(await move(id, 'confirm'));

        const after = ok(
          await move(id, 'cancel', { reasonCode: 'duplicate', duplicateOfOrderId: target }),
        );

        expect(after).toMatchObject({
          fulfillmentState: 'cancelled',
          cashState: 'nothing_to_collect',
          outcome: 'cancelled_before_shipping',
          cancelReasonCode: 'duplicate',
          relatedOrder: { id: target, relation: 'duplicate_of' },
        });
        expect(after.cancelledAt).not.toBeNull();
        expect(after.lines.every((line) => line.lineState === 'open')).toBe(true);
        expect(after.money).toMatchObject({
          totalAmount: '1590.00',
          codExpectedAmount: '1590.00',
          codDueAmount: '0.00',
        });
        expect(
          after.events.slice(-2).map((e) => [e.machine, e.fromState, e.toState, e.actorType]),
        ).toEqual([
          ['fulfillment', 'confirmed', 'cancelled', 'person'],
          ['cash', 'unpaid', 'nothing_to_collect', 'system_job'],
        ]);
        expect(cancelled.find((e) => e.orderId === id)).toMatchObject({
          origin: 'person',
          reasonCode: 'duplicate',
          duplicateOfOrderId: target,
          carrierDeliveryExisted: false,
        });
        const replay = replayStates(after.events.map((e) => ({ ...e, fromState: e.fromState })));
        expect(replay).toEqual({ fulfillment: 'cancelled', cash: 'nothing_to_collect' });
      });

      it('needs a duplicate target, refuses an unknown reason, and sends a Shopify order to Shopify', async () => {
        const id = await create();
        const shopify = await create();
        await intoShopify(shopify);

        const noTarget = await move(id, 'cancel', { reasonCode: 'duplicate' });
        const self = await move(id, 'cancel', { reasonCode: 'duplicate', duplicateOfOrderId: id });
        const reason = await move(id, 'cancel', { reasonCode: 'bored' });
        const inShopify = await move(shopify, 'cancel', { reasonCode: 'fake' });

        expect(noTarget.status).toBe(422);
        expect(noTarget.body).toMatchObject({ code: 'DUPLICATE_TARGET_REQUIRED' });
        expect(self.body).toMatchObject({ code: 'DUPLICATE_TARGET_REQUIRED' });
        expect(reason.body).toMatchObject({ code: 'REASON_INVALID' });
        expect(inShopify.status).toBe(409);
        expect(inShopify.body).toMatchObject({ code: 'CANCEL_IN_SHOPIFY' });
        expect((await detail(id)).fulfillmentState).toBe('new');
      });

      it('asks the warehouse to unpack a cancelled packed order', async () => {
        const id = await create();
        ok(await move(id, 'confirm'));
        ok(await move(id, 'pack', {}, warehouse));

        ok(await move(id, 'cancel', { reasonCode: 'customer_cancelled' }));

        expect(attentions.filter((a) => a.orderId === id).map((a) => a.kind)).toEqual([
          'unpack_cancelled_order',
        ]);
      });
    });

    describe('cancel before pickup (AC-8, review X1)', () => {
      it('cancels after the carrier delivery exists, raising terminate_carrier_delivery, money frozen', async () => {
        const id = await create();
        ok(await move(id, 'confirm'));
        await recordDelivery(id);

        const after = ok(await move(id, 'cancel', { reasonCode: 'no_answer' }));

        expect(after).toMatchObject({
          fulfillmentState: 'cancelled',
          cashState: 'nothing_to_collect',
        });
        expect(after.money.codExpectedAmount).toBe('1590.00');
        expect(attentions.filter((a) => a.orderId === id).map((a) => a.kind)).toEqual([
          'terminate_carrier_delivery',
        ]);
        expect(cancelled.find((e) => e.orderId === id)?.carrierDeliveryExisted).toBe(true);
      });

      it('refuses to unpack once the delivery exists, and to cancel after pickup', async () => {
        const packed = await create();
        ok(await move(packed, 'confirm'));
        ok(await move(packed, 'pack', {}, warehouse));
        await recordDelivery(packed);
        const shipped = await create();
        await recordDelivery(shipped);
        await owner(`UPDATE orders SET fulfillment_state = 'shipped' WHERE id = $1::uuid`, [
          shipped,
        ]);

        const unpack = await move(packed, 'unpack', {}, warehouse);
        const cancel = await move(shipped, 'cancel', { reasonCode: 'customer_cancelled' });

        expect(unpack.status).toBe(409);
        expect(unpack.body).toMatchObject({ code: 'ORDER_LOCKED' });
        expect(cancel.status).toBe(409);
        expect(cancel.body).toMatchObject({
          code: 'INVALID_TRANSITION',
          from: 'shipped',
          to: 'cancelled',
        });
      });
    });

    describe('fix round 1 (security L1, L3; review R1, low 9)', () => {
      it('refuses an edit that sets a phone that does not parse or a free sale line, and edits of a cancelled order', async () => {
        const id = await create();
        const cancelledOrder = await create();
        ok(await move(cancelledOrder, 'cancel', { reasonCode: 'fake' }));

        const badPhone = await move(id, 'edits', {
          operations: [{ kind: 'ship_to', phone: '01x 777' }],
        });
        const free = await move(id, 'edits', {
          operations: [
            {
              kind: 'add_line',
              variantId: skuXl,
              quantity: 1,
              unitPrice: '100.00',
              discountAmount: '100.00',
            },
          ],
        });
        const locked = await move(cancelledOrder, 'edits', {
          operations: [{ kind: 'ship_to', address: 'x' }],
        });

        expect(badPhone.status).toBe(422);
        expect(badPhone.body).toMatchObject({ code: 'INVALID_PHONE' });
        expect(JSON.stringify(badPhone.body)).not.toContain('01x 777');
        expect(free.body).toMatchObject({ code: 'LINE_FULLY_DISCOUNTED' });
        expect(locked.status).toBe(409);
        expect(locked.body).toMatchObject({ code: 'ORDER_LOCKED' });
      });

      it('records who confirmed, and writes one OrderStateChanged for the packed to confirmed edit', async () => {
        const id = await create();
        ok(await move(id, 'confirm'));
        ok(await move(id, 'pack', {}, warehouse));
        stateChanges.length = 0;

        ok(await move(id, 'edits', { operations: [{ kind: 'ship_to', address: 'Back again' }] }));
        const confirmedBy = await owner<{ confirmed_by: string }>(
          `SELECT confirmed_by FROM orders WHERE id = $1::uuid`,
          [id],
        );

        expect(confirmedBy.rows[0]?.confirmed_by).toBe(supportId);
        expect(
          stateChanges.filter((e) => e.orderId === id).map((e) => [e.machine, e.from, e.to]),
        ).toEqual([['fulfillment', 'packed', 'confirmed']]);
      });

      it('lets exactly one of two parallel edits with one token through', async () => {
        const id = await create();
        const { updatedAt } = await detail(id);
        const edit = (address: string) =>
          api.call(support, 'POST', `/api/orders/${id}/edits`, {
            expectedUpdatedAt: updatedAt,
            operations: [{ kind: 'ship_to', address }],
          });

        const replies = await Promise.all([edit('Parallel One'), edit('Parallel Two')]);

        expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(replies.find((r) => r.status === 409)?.body).toMatchObject({ code: 'ORDER_STALE' });
      });

      it('raises delivery_created_before_edit_synced when the delivery arrives while an edit waits', async () => {
        const id = await create();
        queueOnEdit = true;
        ok(await move(id, 'edits', { operations: [{ kind: 'ship_to', address: 'Waiting St' }] }));
        queueOnEdit = false;

        await recordDelivery(id);

        expect(attentions.filter((a) => a.orderId === id).map((a) => a.kind)).toEqual([
          'delivery_created_before_edit_synced',
        ]);
      });

      it('refuses a duplicate of a cancelled order, and a duplicate of its own duplicate', async () => {
        const gone = await create();
        ok(await move(gone, 'cancel', { reasonCode: 'fake' }));
        const id = await create();
        const first = await create();
        const second = await create();
        ok(await move(first, 'cancel', { reasonCode: 'duplicate', duplicateOfOrderId: second }));

        const ofCancelled = await move(id, 'cancel', {
          reasonCode: 'duplicate',
          duplicateOfOrderId: gone,
        });
        const cycle = await move(second, 'cancel', {
          reasonCode: 'duplicate',
          duplicateOfOrderId: first,
        });

        expect(ofCancelled.status).toBe(422);
        expect(ofCancelled.body).toMatchObject({ code: 'INVALID_BODY' });
        expect(cycle.status).toBe(422);
        expect(cycle.body).toMatchObject({ code: 'INVALID_BODY' });
        expect((await detail(second)).fulfillmentState).toBe('new');
      });

      it('ends at none when two commands of one order settle in parallel (the projection locks first)', async () => {
        const id = await create();
        const command = async () =>
          (
            await owner<{ id: string }>(
              `INSERT INTO outbound_commands (connection_id, kind, linked_type, linked_id, payload, idempotency_key)
               VALUES ($1::uuid, 'shopify.order_edit', 'order', $2::uuid, '{}'::jsonb, $3) RETURNING id`,
              [connection, id, `fixture:${randomUUID()}`],
            )
          ).rows[0]?.id as string;
        const one = await command();
        const two = await command();
        await owner(`UPDATE orders SET write_back_state = 'waiting' WHERE id = $1::uuid`, [id]);
        const db = api.app.get<DatabaseConnection>(DATABASE).db;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let holding: () => void = () => undefined;
        const held = new Promise<void>((resolve) => (holding = resolve));

        // A settles the first command and keeps its transaction (and the order row lock) open.
        const first = db.transaction(async (tx) => {
          await settleIn(tx, one, 'synced');
          holding();
          await gate;
        });
        await held;
        // B settles the second command; its projection waits on A's order row lock.
        const second = db.transaction((tx) => settleIn(tx, two, 'synced'));
        for (let tries = 0; tries < 100; tries += 1) {
          const waiting = await owner<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        release();
        await Promise.all([first, second]);

        expect((await detail(id)).writeBackState).toBe('none');
      });
    });

    describe('the transition table (AC-6, AC-7)', () => {
      it('refuses moves the table does not list with 409 INVALID_TRANSITION and writes nothing', async () => {
        const id = await create();
        const pack = await move(id, 'pack', {}, warehouse);
        const unpack = await move(id, 'unpack', {}, warehouse);
        ok(await move(id, 'confirm'));
        const confirmAgain = await move(id, 'confirm');
        const after = await detail(id);

        expect([pack.status, unpack.status, confirmAgain.status]).toEqual([409, 409, 409]);
        expect(pack.body).toMatchObject({ code: 'INVALID_TRANSITION', from: 'new', to: 'packed' });
        expect(after.events.map((e) => [e.machine, e.toState])).toEqual([
          ['fulfillment', 'new'],
          ['cash', 'unpaid'],
          ['fulfillment', 'confirmed'],
        ]);
        expect(after.confirmedAt).not.toBeNull();
      });

      it('confirms, packs, and unpacks with one event each, replaying to the stored states', async () => {
        const id = await create();
        ok(await move(id, 'confirm'));
        ok(await move(id, 'pack', {}, warehouse));
        const after = ok(await move(id, 'unpack', {}, warehouse));

        expect(after.events.slice(2).map((e) => [e.fromState, e.toState])).toEqual([
          ['new', 'confirmed'],
          ['confirmed', 'packed'],
          ['packed', 'confirmed'],
        ]);
        expect(replayStates(after.events)).toEqual({ fulfillment: 'confirmed', cash: 'unpaid' });
      });

      it('answers 404 ORDER_NOT_FOUND for an unknown order and 403 to a person without the permission', async () => {
        const id = await create();
        const at = (await detail(id)).updatedAt;

        const unknown = await api.call(support, 'POST', `/api/orders/${randomUUID()}/confirm`, {
          expectedUpdatedAt: at,
        });
        const warehouseEdit = await api.call(warehouse, 'POST', `/api/orders/${id}/edits`, {
          expectedUpdatedAt: at,
          operations: [{ kind: 'ship_to', address: 'x' }],
        });
        const supportPack = await api.call(support, 'POST', `/api/orders/${id}/pack`, {
          expectedUpdatedAt: at,
        });

        expect(unknown.status).toBe(404);
        expect(unknown.body).toMatchObject({ code: 'ORDER_NOT_FOUND' });
        expect(warehouseEdit.status).toBe(403);
        expect(supportPack.status).toBe(403);
      });
    });
  },
);
