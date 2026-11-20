import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  ChannelOrderInput,
  CreatedOrder,
  OrderDetail,
  SkuDetail,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderIntake } from '../src/orders/intake/order-intake.service.js';
import { OrderTransactions } from '../src/orders/order-transactions.js';
import { OrderTransitions } from '../src/orders/transitions/order-transitions.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0013 AC-11 and the Audit table: the orders audit entries and their privacy. Milestone 1
// proves `order.created_manually`, milestone 2 `order.edited`, and milestone 3
// `order.payment_method_rederived`, and milestone 5 (task 14) `order.partial_delivery_split` and
// `order.collection_recorded_manually`, so this file stays the one proof the registry names.
describe('orders audit', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let supportId = '';
  let variant = '';
  let mainStore = '';
  let manualChannel = '';

  beforeAll(async () => {
    api = await startInProcessApi();
    const supportPerson = await api.addPerson(['support']);
    supportId = supportPerson.id;
    support = await api.signIn(supportPerson.email);
    const manager = await api.signIn((await api.addPerson(['manager'])).email);
    mainStore = (
      await api.owner.pool.query<{ id: string }>(`SELECT id FROM stores WHERE code = 'MAIN'`)
    ).rows[0]?.id as string;
    manualChannel = (
      await api.owner.pool.query<{ id: string }>(`SELECT id FROM channels WHERE code = 'manual'`)
    ).rows[0]?.id as string;
    const sku = await api.call(manager, 'POST', '/api/products', {
      name: { en: 'Audit tee' },
      variants: [{ sku: 'AUD-M', price: '100.00' }],
    });
    variant = SkuDetail.parse(sku.body).id;
  });

  afterAll(async () => {
    await api?.close();
  });

  it('writes one order.created_manually entry with the store label and no personal data', async () => {
    const sentinel = {
      name: 'Sentinel Customer Name',
      phone: '01009998877',
      address: '99 Sentinel Avenue',
      note: 'Sentinel courier note',
    };
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: {
        name: sentinel.name,
        phone: sentinel.phone,
        address: sentinel.address,
        courierNote: sentinel.note,
      },
      lines: [{ variantId: variant, quantity: 1, unitPrice: '100.00' }],
      shippingChargedAmount: '20.00',
      paymentMethod: 'cod',
    });
    const made = CreatedOrder.parse(reply.body);
    const { rows } = await api.owner.pool.query(
      `SELECT action, record_type, record_id, record_label, reason, actor_kind, after::text AS after_text
       FROM audit_entries WHERE record_id = $1::uuid`,
      [made.id],
    );
    const everything = await api.owner.pool.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a`,
    );
    const allText = everything.rows.map((r) => r.text).join('\n');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'order.created_manually',
      record_type: 'order',
      record_label: `MAIN/${made.orderNumber}`,
      reason: 'phone_order',
      actor_kind: 'person',
    });
    for (const text of Object.values(sentinel)) expect(allText).not.toContain(text);
    expect(allText).not.toContain('+2010099988');
  });

  it('registers the order codes on the order record type, task 15 five included', () => {
    const codes = Object.keys(AUDIT_ACTIONS).filter((code) => code.startsWith('order.'));

    expect(codes).toEqual([
      'order.created_manually',
      'order.edited',
      'order.partial_delivery_split',
      'order.collection_recorded_manually',
      'order.payment_method_rederived',
      // Spec 0013 task 15 (AC-27), proven in orders-stock-out.e2e-spec.ts.
      'order.awaiting_restock_closed',
      'order.awaiting_restock_close_requested',
      'order.awaiting_restocked',
      'order.channel_fulfillment_posted',
      'order.carrier_delivery_cleared',
    ]);
    const types = Object.entries(AUDIT_ACTIONS)
      .filter(([code]) => code.startsWith('order.'))
      .map(([, action]) => action.recordType);
    expect(new Set(types)).toEqual(new Set(['order']));
  });

  it('writes one order.edited entry per edit with the ship to values redacted and listed as personal', async () => {
    const old = {
      name: 'Sentinel Before Name',
      phone: '01009998866',
      address: '11 Sentinel Before Street',
      note: 'Sentinel before courier note',
      phoneAlt: '01009998844',
      governorate: 'SENTGOVB',
      city: 'SENTCITYB',
      zone: 'SENTZONEB',
    };
    const fresh = {
      name: 'Sentinel After Name',
      phone: '01009998855',
      address: '22 Sentinel After Street',
      note: 'Sentinel after courier note',
      phoneAlt: '01009998833',
      governorate: 'SENTGOVA',
      city: 'SENTCITYA',
      zone: 'SENTZONEA',
    };
    const areaOf = (from: typeof old) => ({
      list: 'bosta',
      governorateCode: from.governorate,
      cityCode: from.city,
      zoneCode: from.zone,
    });
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: {
        name: old.name,
        phone: old.phone,
        phoneAlt: old.phoneAlt,
        address: old.address,
        courierNote: old.note,
        area: areaOf(old),
      },
      lines: [{ variantId: variant, quantity: 1, unitPrice: '100.00' }],
      shippingChargedAmount: '20.00',
      paymentMethod: 'cod',
    });
    const made = CreatedOrder.parse(reply.body);
    const page = OrderDetail.parse((await api.call(support, 'GET', `/api/orders/${made.id}`)).body);

    const edit = await api.call(support, 'POST', `/api/orders/${made.id}/edits`, {
      expectedUpdatedAt: page.updatedAt,
      reasonCode: 'address_fix',
      operations: [
        {
          kind: 'ship_to',
          name: fresh.name,
          phone: fresh.phone,
          address: fresh.address,
          courierNote: fresh.note,
          phoneAlt: fresh.phoneAlt,
          area: areaOf(fresh),
        },
        { kind: 'shipping', shippingChargedAmount: '30.00' },
      ],
    });
    const { rows } = await api.owner.pool.query<{
      record_label: string;
      reason: string;
      actor_kind: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      personal_fields: string[];
    }>(
      `SELECT record_label, reason, actor_kind, before, after, personal_fields
       FROM audit_entries WHERE record_id = $1::uuid AND action = 'order.edited'`,
      [made.id],
    );
    const everything = await api.owner.pool.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a`,
    );
    const allText = everything.rows.map((r) => r.text).join('\n');

    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_label: `MAIN/${made.orderNumber}`,
      reason: 'address_fix',
      actor_kind: 'person',
      before: {
        shipToName: '[REDACTED]',
        shipToPhone: '[REDACTED]',
        shipToAddress: '[REDACTED]',
        courierNote: '[REDACTED]',
        shippingChargedAmount: '20.00',
        totalAmount: '120.00',
      },
      after: {
        origin: 'person',
        shipToName: '[REDACTED]',
        shipToPhone: '[REDACTED]',
        shipToAddress: '[REDACTED]',
        courierNote: '[REDACTED]',
        shippingChargedAmount: '30.00',
        totalAmount: '130.00',
      },
    });
    // The trail lists each masked field once, by its path inside `before` and `after`.
    expect([...(rows[0]?.personal_fields ?? [])].sort()).toEqual([
      'courierNote',
      'shipToAddress',
      'shipToCityCode',
      'shipToGovernorateCode',
      'shipToName',
      'shipToPhone',
      'shipToPhoneAlt',
      'shipToZoneCode',
    ]);
    for (const text of [...Object.values(old), ...Object.values(fresh)]) {
      expect(allText).not.toContain(text);
    }
    expect(allText).not.toContain('+2010099988');
  });

  it('writes one order.payment_method_rederived entry by a system job with the payment before and after, and no personal data', async () => {
    const sentinel = {
      name: 'Sentinel Rederive Name',
      phone: '01009998811',
      address: '33 Sentinel Rederive Road',
      note: 'Sentinel rederive note',
    };
    const intake = api.app.get(OrderIntake);
    // A channel order arrives on a channel bound to its store, never a manual entry one.
    const landingPage = (
      await api.owner.pool.query<{ id: string }>(
        `INSERT INTO channels (code, name, kind, default_store_id)
         VALUES ('AUDLP', '{"en":"Landing page"}', 'landing_page', $1::uuid) RETURNING id`,
        [mainStore],
      )
    ).rows[0]?.id as string;
    const input = ChannelOrderInput.parse({
      storeId: mainStore,
      channelId: landingPage,
      channelOrderRef: `gid-${randomUUID()}`,
      orderNumber: '#9001',
      placedAt: new Date().toISOString(),
      type: 'sale',
      paymentMethod: 'gateway',
      prepaidAmount: '120.00',
      prepaidMethod: 'gateway',
      shippingChargedAmount: '20.00',
      customerNote: sentinel.note,
      channelCustomer: null,
      shipTo: { name: sentinel.name, phone: sentinel.phone, address: sentinel.address },
      lines: [
        {
          channelLineId: 'cl-1',
          variantId: variant,
          title: 'Audit tee',
          quantity: 1,
          unitPrice: '100.00',
          taxRate: '14.00',
        },
      ],
    });
    const job = { type: 'system_job' as const, job: 'shopify.mapping', jobId: randomUUID() };
    const transactions = api.app.get(OrderTransactions);
    const { orderId } = await transactions.run((tx) => intake.createFromChannel(tx, input, job));

    await transactions.run((tx) =>
      intake.rederivePaymentMethod(
        tx,
        orderId,
        { paymentMethod: 'cod', prepaidAmount: '0.00', prepaidMethod: null },
        job,
      ),
    );
    const { rows } = await api.owner.pool.query<{
      action: string;
      record_label: string;
      reason: string;
      actor_kind: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(
      `SELECT action, record_label, reason, actor_kind, before, after
       FROM audit_entries WHERE record_id = $1::uuid`,
      [orderId],
    );
    const everything = await api.owner.pool.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a`,
    );
    const allText = everything.rows.map((r) => r.text).join('\n');

    expect(rows).toEqual([
      {
        action: 'order.payment_method_rederived',
        record_label: 'MAIN/#9001',
        reason: 'gateway_mapping_changed',
        actor_kind: 'system_job',
        before: {
          paymentMethod: 'gateway',
          prepaidAmount: '120.00',
          prepaidMethod: 'gateway',
          codExpectedAmount: '0.00',
        },
        after: {
          paymentMethod: 'cod',
          prepaidAmount: '0.00',
          prepaidMethod: null,
          codExpectedAmount: '120.00',
        },
      },
    ]);
    for (const text of Object.values(sentinel)) expect(allText).not.toContain(text);
  });

  /** A COD order of three pieces the courier picked up, with sentinel ship to values. */
  const shippedOrder = async (sentinel: Record<string, string>) => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: sentinel.name, phone: sentinel.phone, address: sentinel.address },
      lines: [{ variantId: variant, quantity: 3, unitPrice: '100.00' }],
      shippingChargedAmount: '20.00',
      paymentMethod: 'cod',
    });
    const made = CreatedOrder.parse(reply.body);
    const moves = api.app.get(OrderTransitions);
    await api.app.get(OrderTransactions).run(async (tx) => {
      await moves.confirm(tx, made.id, { type: 'person', userId: supportId, hat: 'support' });
      await moves.recordShipmentFact(
        tx,
        made.id,
        { to: 'shipped', occurredAt: new Date(), source: { type: 'test', id: randomUUID() } },
        { type: 'carrier', connectionId: randomUUID() },
      );
    });
    return made;
  };

  it('writes one order.partial_delivery_split entry with the split lines and no personal data', async () => {
    const sentinel = {
      name: 'Sentinel Split Name',
      phone: '01009998811',
      address: '33 Sentinel Split Road',
    };
    const made = await shippedOrder(sentinel);
    const { rows: lines } = await api.owner.pool.query<{ id: string }>(
      `SELECT id FROM order_lines WHERE order_id = $1::uuid`,
      [made.id],
    );
    const lineId = lines[0]?.id as string;

    await api.app.get(OrderTransactions).run((tx) =>
      api.app.get(OrderTransitions).recordPartialDelivery(
        tx,
        made.id,
        {
          lines: [{ lineId, deliveredQuantity: 2 }],
          occurredAt: new Date(),
          source: { type: 'courier_note', id: randomUUID() },
          reasonCode: 'courier_note',
        },
        { type: 'person', userId: supportId, hat: 'support' },
      ),
    );
    const { rows } = await api.owner.pool.query(
      `SELECT action, record_label, reason, actor_kind, before, after
       FROM audit_entries WHERE record_id = $1::uuid AND action = 'order.partial_delivery_split'`,
      [made.id],
    );
    const everything = await api.owner.pool.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a`,
    );
    const allText = everything.rows.map((r) => r.text).join('\n');

    expect(rows).toEqual([
      {
        action: 'order.partial_delivery_split',
        record_label: `MAIN/${made.orderNumber}`,
        reason: 'courier_note',
        actor_kind: 'person',
        before: {
          codDueAmount: '320.00',
          lines: [{ lineId, quantity: 3, grossAmount: '300.00', lineState: 'open' }],
        },
        after: {
          codDueAmount: '220.00',
          deliveredAmount: '200.00',
          lines: [
            { lineId, quantity: 2, grossAmount: '200.00', lineState: 'delivered' },
            {
              lineId: expect.any(String) as string,
              splitFromLineId: lineId,
              quantity: 1,
              grossAmount: '100.00',
              lineState: 'returned_to_origin',
            },
          ],
        },
      },
    ]);
    for (const text of Object.values(sentinel)) expect(allText).not.toContain(text);
  });

  it('writes one order.collection_recorded_manually entry per cash entry by hand, with its reason', async () => {
    const sentinel = {
      name: 'Sentinel Cash Name',
      phone: '01009998822',
      address: '44 Sentinel Cash Road',
    };
    const made = await shippedOrder(sentinel);
    const person = { type: 'person' as const, userId: supportId, hat: 'support' };
    const source = { type: 'courier_note', id: randomUUID() };

    await api.app.get(OrderTransactions).run(async (tx) => {
      const moves = api.app.get(OrderTransitions);
      await moves.recordShipmentFact(
        tx,
        made.id,
        { to: 'delivered', occurredAt: new Date(), source },
        { type: 'carrier', connectionId: randomUUID() },
      );
      await moves.recordCollection(
        tx,
        made.id,
        { amount: '320.00', occurredAt: new Date(), source, reasonCode: 'carrier_missing_report' },
        person,
      );
      await moves.reverseCollection(
        tx,
        made.id,
        { occurredAt: new Date(), source, reasonCode: 'correction' },
        person,
      );
    });
    const { rows } = await api.owner.pool.query(
      `SELECT record_label, reason, actor_kind, before, after
       FROM audit_entries WHERE record_id = $1::uuid AND action = 'order.collection_recorded_manually'
       ORDER BY recorded_at, id`,
      [made.id],
    );
    const everything = await api.owner.pool.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a`,
    );
    const allText = everything.rows.map((r) => r.text).join('\n');

    expect(rows).toEqual([
      {
        record_label: `MAIN/${made.orderNumber}`,
        reason: 'carrier_missing_report',
        actor_kind: 'person',
        before: { cashState: 'unpaid', codCollectedAmount: '0.00' },
        after: { cashState: 'collected_by_carrier', codCollectedAmount: '320.00' },
      },
      {
        record_label: `MAIN/${made.orderNumber}`,
        reason: 'correction',
        actor_kind: 'person',
        before: { cashState: 'collected_by_carrier', codCollectedAmount: '320.00' },
        after: { cashState: 'unpaid', codCollectedAmount: '0.00' },
      },
    ]);
    for (const text of Object.values(sentinel)) expect(allText).not.toContain(text);
  });
});
