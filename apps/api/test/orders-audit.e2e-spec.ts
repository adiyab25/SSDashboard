import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, CreatedOrder, SkuDetail } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0013 AC-11 and the Audit table: the orders audit entries and their privacy. Milestone 1
// proves `order.created_manually`; the other four codes are written by the moves of milestones 2,
// 3, and 5 and are listed as todo until then, so this file stays the one proof the registry names.
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

  // Written by the moves that follow (spec 0013 milestones 2, 3, and 5).
  it.todo('order.edited writes one entry per edit with redacted ship to values (milestone 2)');
  it.todo('order.payment_method_rederived (milestone 3)');
  it.todo('order.partial_delivery_split (milestone 5)');
  it.todo('order.collection_recorded_manually (milestone 5)');
});
