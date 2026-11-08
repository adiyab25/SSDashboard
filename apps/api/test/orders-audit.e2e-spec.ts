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
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0013 AC-11 and the Audit table: the orders audit entries and their privacy. Milestone 1
// proves `order.created_manually`, milestone 2 `order.edited`, and milestone 3
// `order.payment_method_rederived`; the other two codes are written by the moves of milestone 5
// and are listed as todo until then, so this file stays the one proof the registry names.
describe('orders audit', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let variant = '';
  let mainStore = '';
  let manualChannel = '';

  beforeAll(async () => {
    api = await startInProcessApi();
    support = await api.signIn((await api.addPerson(['support'])).email);
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

  it('registers the five order codes on the order record type', () => {
    const codes = Object.keys(AUDIT_ACTIONS).filter((code) => code.startsWith('order.'));

    expect(codes).toEqual([
      'order.created_manually',
      'order.edited',
      'order.partial_delivery_split',
      'order.collection_recorded_manually',
      'order.payment_method_rederived',
    ]);
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

  // Written by the moves that follow (spec 0013 milestone 5).
  it.todo('order.partial_delivery_split (milestone 5)');
  it.todo('order.collection_recorded_manually (milestone 5)');
});
