import { createHmac, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { CustomersService } from '../src/customers/customers.service.js';
import { OrderTransitions } from '../src/orders/transitions/order-transitions.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import {
  readShopifyFixture,
  remainingShopifyExchanges,
  useShopifyScenarios,
} from './shopify-fixture-fetch.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0015 tasks 9 and 11 (AC-9, AC-10, AC-11, AC-13, AC-14, AC-15; *Critical test scenarios*
// "Orders", "Gifted", "Cancel and fulfillment", "Ownership" (the held edit), "Customers", "Inbox
// privacy"). Signed webhooks reach the real api in process; the real worker's inbox job reads the
// order or customer back from the synthetic fixtures (to be replaced by recordings) through the
// refusing fetch and applies it through the real orders and customers modules. Each test plants
// its own store, so the fixtures' order names never collide.

// Load the root .env before the api saves the environment (the worker reads it after).
devDatabaseUrl();

/** The webhook secret of every connection here (a test value, never a real one). */
const SECRET = `orders-in-full-secret-${randomUUID()}`;

/** Personal fixture values that must never reach an inbox payload. */
const PERSONAL = [
  'مها تجريبية',
  'سارة',
  'ليلى',
  '12 شارع الاختبار',
  '30 شارع التعديل',
  'maha.fixture',
  'fixture note',
];

/** The config of every planted connection: the fixtures' gateways mapped as a manager would. */
const CONFIG = JSON.stringify({
  appOwner: 'organization',
  altPhoneAttribute: 'alt_phone',
  gatewayMethods: { 'Cash on Delivery (COD)': 'cod', 'Fixture Card Gateway': 'instapay' },
});

interface Planted {
  id: string;
  shopDomain: string;
  storeId: string;
}

interface EventRow {
  id: string;
  status: string;
  outcome: string | null;
  failure_code: string | null;
  subject_label: string | null;
}

const restId = (gid: string) => Number(gid.split('/').pop());

describe(
  'Shopify orders in full and customer webhooks (spec 0015 tasks 9 and 11)',
  { timeout: 300_000 },
  () => {
    let api: InProcessApi;
    let worker: TestingModule;
    let refusingFetch: typeof fetch;
    const planted: string[] = [];

    /** Plants a Shopify store, its own channel, and an active connection sealed with `SECRET`. */
    const plant = async (): Promise<Planted> => {
      const t = randomUUID().slice(0, 8);
      const storeCode = `OF${t.toUpperCase()}`;
      const shopDomain = `ordersfx-${t}.myshopify.com`;
      const id = randomUUID();
      const store = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO stores (code, name, public_name, kind)
       VALUES ($1, '{"en":"Orders store"}', '{"en":"Orders store"}', 'shopify') RETURNING id`,
        [storeCode],
      );
      const storeId = store.rows[0]?.id as string;
      await api.owner.pool.query(
        `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ($1, '{"en":"Orders store"}', 'shopify', $2::uuid)`,
        [storeCode, storeId],
      );
      const sealed = api.app
        .get(ConnectionSecrets)
        .seal(
          { kind: 'client_credentials', clientId: `client-${t}-WXYZ`, clientSecret: SECRET },
          id,
        );
      await api.owner.pool.query(
        `INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                credentials_ciphertext, credentials_key_version, credentials_hint,
                                credentials_updated_at, config, health)
       VALUES ($1::uuid, 'shopify', 'Orders store', $2::uuid, 'active', $3, $4, $5, 'WXYZ', now(),
               $6::jsonb, 'ok')`,
        [id, storeId, shopDomain, sealed.ciphertext, sealed.keyVersion, CONFIG],
      );
      planted.push(id);
      return { id, shopDomain, storeId };
    };

    /** A webhook body as Shopify's REST payload carries it, personal fields included. */
    const body = (gid: string, updatedAt: string) => ({
      id: restId(gid),
      admin_graphql_api_id: gid,
      updated_at: updatedAt,
      name: '#9999',
      first_name: 'سارة',
      phone: '+201000000120',
      note: 'fixture note',
      shipping_address: { name: 'مها تجريبية', address1: '12 شارع الاختبار' },
    });

    /** Sends one signed delivery and answers its webhook id. */
    const deliver = async (c: Planted, topic: string, payload: unknown): Promise<string> => {
      const webhookId = randomUUID();
      const raw = Buffer.from(JSON.stringify(payload), 'utf8');
      const response = await fetch(`${api.base}/api/hooks/shopify/${c.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': topic,
          'x-shopify-webhook-id': webhookId,
          'x-shopify-shop-domain': c.shopDomain,
          'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'),
          'x-shopify-api-version': '2026-10',
        },
        body: new Uint8Array(raw),
      });
      expect(response.status).toBe(200);
      return webhookId;
    };

    /** Waits until the delivery's event left `received`. */
    const settled = (c: Planted, webhookId: string) =>
      eventually(
        async () => {
          const { rows } = await api.owner.pool.query<EventRow>(
            `SELECT id, status, outcome, failure_code, subject_label FROM inbound_events
           WHERE connection_id = $1::uuid AND dedupe_key = $2`,
            [c.id, webhookId],
          );
          const row = rows[0];
          return row && row.status !== 'received' ? row : undefined;
        },
        { timeoutMs: 60_000, what: `event ${webhookId} to settle` },
      );

    /** Delivers and waits for the event's end. */
    const arrive = async (c: Planted, topic: string, gid: string, updatedAt: string) =>
      settled(c, await deliver(c, topic, body(gid, updatedAt)));

    /** The order of a Shopify gid in a store, with the columns the tests read. */
    const orderOf = async (c: Planted, gid: string) =>
      (
        await api.owner.pool.query<{
          id: string;
          type: string;
          gift_reason_code: string | null;
          fulfillment_state: string;
          payment_method: string;
          prepaid_amount: string;
          prepaid_method: string | null;
          carrier_delivery_created_at: Date | null;
          ship_to_address: string | null;
          updated_at: Date;
        }>(
          `SELECT id, type, gift_reason_code, fulfillment_state, payment_method, prepaid_amount,
                prepaid_method, carrier_delivery_created_at, ship_to_address, updated_at
         FROM orders WHERE store_id = $1::uuid AND channel_order_ref = $2`,
          [c.storeId, gid],
        )
      ).rows[0];

    const linesOf = async (orderId: string) =>
      (
        await api.owner.pool.query<{
          channel_line_id: string;
          line_state: string;
          cancel_reason_code: string | null;
        }>(
          `SELECT channel_line_id, line_state, cancel_reason_code FROM order_lines
         WHERE order_id = $1::uuid ORDER BY position`,
          [orderId],
        )
      ).rows.map((row) => [
        row.channel_line_id.split('/').pop(),
        row.line_state,
        row.cancel_reason_code,
      ]);

    const mappingOf = async (c: Planted, gid: string) =>
      (
        await api.owner.pool.query<{ version: Date | null; state: Record<string, unknown> }>(
          `SELECT external_version AS version, state FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
          [c.id, gid],
        )
      ).rows[0];

    beforeAll(async () => {
      api = await startInProcessApi();
      worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      await worker.init();

      // The token exchange is answered from the recorded `connect-ok` grant; every other request
      // goes to the refusing fetch.
      refusingFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/admin/oauth/access_token') {
          const grant = readShopifyFixture('connect-ok/01-access-token.json').response;
          return new Response(JSON.stringify(grant.body), {
            status: grant.status,
            headers: grant.headers,
          });
        }
        return refusingFetch(input, init);
      };

      // AC-10: the brand lists `gift-influencer` as an influencer gift (setting `shopify_gift_tags`).
      const boss = await api.addPerson(['manager']);
      const manager = await api.signIn(boss.email);
      const put = await api.call(manager, 'PUT', '/api/settings/shopify_gift_tags', {
        value: { 'gift-influencer': 'influencer' },
        reason: 'orders in full e2e',
        expectedUpdatedAt: null,
      });
      expect(put.status).toBe(200);
    }, 180_000);

    afterAll(async () => {
      if (refusingFetch) globalThis.fetch = refusingFetch;
      await worker?.close();
      await api?.close();
    });

    it('applies an edit made before any fulfillment through applyChannelEdit: a size swap is a removal and an added line, never a return', async () => {
      useShopifyScenarios('order-edited-size-swap');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000002001';
      expect(await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const created = await orderOf(c, gid);
      expect(created?.ship_to_address).toContain('12 شارع الاختبار');

      // 02: the M line's current quantity is 0, a new L line was added, the address changed.
      expect(await arrive(c, 'orders/edited', gid, '2026-11-02T11:40:09Z')).toMatchObject({
        status: 'processed',
        outcome: null,
        subject_label: '#1002',
      });
      const edited = await orderOf(c, gid);
      expect(await linesOf(edited?.id as string)).toEqual([
        ['6660000002001', 'cancelled', 'edit_removal'],
        ['6660000002002', 'open', null],
        ['6660000002003', 'open', null],
      ]);
      expect(edited?.fulfillment_state).toBe('new');
      expect(edited?.ship_to_address).toContain('30 شارع التعديل');
      const mapping = await mappingOf(c, gid);
      expect(mapping?.version?.toISOString()).toBe('2026-11-02T11:40:09.000Z');
      expect(mapping?.state['appliedLines']).toEqual({
        'gid://shopify/LineItem/6660000002002': 1,
        'gid://shopify/LineItem/6660000002003': 1,
      });

      // 03: the same updatedAt again is stale; 04: newer and identical changes nothing.
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T11:40:09Z')).toMatchObject({
        status: 'ignored',
        outcome: 'stale',
      });
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T11:40:12Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await linesOf(edited?.id as string)).toHaveLength(3);
      expect((await orderOf(c, gid))?.updated_at).toEqual(edited?.updated_at);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('records held_write_back_open while a write back command is open, changing nothing and keeping the version', async () => {
      useShopifyScenarios('order-edited-size-swap');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000002001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      const order = await orderOf(c, gid);
      await api.owner.pool.query(
        `INSERT INTO outbound_commands (connection_id, kind, linked_type, linked_id, payload, idempotency_key)
       VALUES ($1::uuid, 'shopify.order_edit', 'order', $2::uuid, '{}'::jsonb, $3)`,
        [c.id, order?.id, `fixture:${randomUUID()}`],
      );
      const before = await linesOf(order?.id as string);
      const versionBefore = (await mappingOf(c, gid))?.version;

      expect(await arrive(c, 'orders/edited', gid, '2026-11-02T11:40:09Z')).toMatchObject({
        status: 'ignored',
        outcome: 'held_write_back_open',
      });
      expect(await linesOf(order?.id as string)).toEqual(before);
      expect((await orderOf(c, gid))?.ship_to_address).toContain('12 شارع الاختبار');
      expect((await mappingOf(c, gid))?.version).toEqual(versionBefore);
    });

    it('cancels from a Shopify cancel with reason CUSTOMER as channel.customer', async () => {
      useShopifyScenarios('order-cancelled-later');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000016001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      expect(await arrive(c, 'orders/cancelled', gid, '2026-11-02T12:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
        subject_label: '#1016',
      });
      const order = await orderOf(c, gid);
      expect(order?.fulfillment_state).toBe('cancelled');
      const { rows } = await api.owner.pool.query<{ reason_code: string; actor_type: string }>(
        `SELECT reason_code, actor_type FROM order_events
       WHERE order_id = $1::uuid AND machine = 'fulfillment' AND to_state = 'cancelled'`,
        [order?.id],
      );
      expect(rows).toEqual([{ reason_code: 'channel.customer', actor_type: 'system_job' }]);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('sets the carrier delivery time from the first fulfillment with source shopify_fulfillment, then refuses a later ship to edit', async () => {
      useShopifyScenarios('order-fulfilled-later');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000017001';
      const spy = vi.spyOn(worker.get(OrderTransitions), 'recordCarrierDelivery');
      try {
        await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
        expect(await arrive(c, 'orders/updated', gid, '2026-11-03T08:30:05Z')).toMatchObject({
          status: 'processed',
          outcome: null,
        });
        const order = await orderOf(c, gid);
        expect(order?.carrier_delivery_created_at?.toISOString()).toBe('2026-11-03T08:30:00.000Z');
        expect(spy).toHaveBeenCalledTimes(1);
        const fact = spy.mock.calls[0]?.[2];
        expect(fact).toEqual({
          at: new Date('2026-11-03T08:30:00Z'),
          source: { type: 'shopify_fulfillment', id: 'gid://shopify/Fulfillment/9990000017001' },
        });

        // 03: the address changed while the fulfillment is active: orders refuses after the freeze.
        expect(await arrive(c, 'orders/updated', gid, '2026-11-03T10:00:00Z')).toMatchObject({
          status: 'processed',
          outcome: 'edit_not_applied',
        });
        expect((await orderOf(c, gid))?.ship_to_address).toContain('12 شارع الاختبار');
        expect((await orderOf(c, gid))?.carrier_delivery_created_at?.toISOString()).toBe(
          '2026-11-03T08:30:00.000Z',
        );
        expect(remainingShopifyExchanges()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps a COD order cod with nothing prepaid after a later "mark as paid", and prepays a card order', async () => {
      useShopifyScenarios('order-prepaid-gateway');
      const c = await plant();
      const cod = 'gid://shopify/Order/5550000005101';
      await arrive(c, 'orders/create', cod, '2026-11-02T09:15:04Z');
      expect(await arrive(c, 'orders/updated', cod, '2026-11-02T14:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await orderOf(c, cod)).toMatchObject({
        payment_method: 'cod',
        prepaid_amount: '0.00',
        prepaid_method: null,
      });

      const card = 'gid://shopify/Order/5550000005001';
      await arrive(c, 'orders/create', card, '2026-11-02T09:15:04Z');
      expect(await orderOf(c, card)).toMatchObject({
        payment_method: 'instapay',
        prepaid_amount: '860.00',
        prepaid_method: 'instapay',
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('creates a free order with a listed gift tag as gifted, and records the tag on a paid order as gift_tag_not_free', async () => {
      useShopifyScenarios('order-gifted-tag');
      const c = await plant();
      const free = 'gid://shopify/Order/5550000018001';
      expect(await arrive(c, 'orders/create', free, '2026-11-02T09:15:04Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await orderOf(c, free)).toMatchObject({
        type: 'gifted',
        gift_reason_code: 'influencer',
      });
      const paid = 'gid://shopify/Order/5550000018101';
      expect(await arrive(c, 'orders/create', paid, '2026-11-02T09:15:04Z')).toMatchObject({
        status: 'processed',
        outcome: 'gift_tag_not_free',
      });
      expect(await orderOf(c, paid)).toMatchObject({ type: 'sale', gift_reason_code: null });
    });

    it('calls findOrCreate for a customers/update with an Egyptian phone, records no_phone without one, and stale and not_visible as for orders', async () => {
      useShopifyScenarios(
        'customer-updated-phone',
        'customer-updated-no-phone',
        'customer-updated-phone',
        'customer-not-visible',
      );
      const c = await plant();
      const spy = vi.spyOn(worker.get(CustomersService), 'findOrCreate');
      try {
        const withPhone = 'gid://shopify/Customer/8880000020001';
        expect(
          await arrive(c, 'customers/update', withPhone, '2026-11-04T10:00:00Z'),
        ).toMatchObject({ status: 'processed', outcome: null });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[1]).toEqual({
          phone: { e164: '+201000000120', kind: 'mobile' },
          channelCustomer: { kind: 'shopify_customer', connectionId: c.id, externalId: withPhone },
          name: 'سارة تجريبية',
          seenAt: new Date('2026-11-04T10:00:00Z'),
        });
        const linked = await api.owner.pool.query<{ e164: string }>(
          `SELECT p.phone_e164 AS e164 FROM customer_external_ids x
         JOIN customer_phones p ON p.customer_id = x.customer_id
         WHERE x.connection_id = $1::uuid AND x.external_id = $2`,
          [c.id, withPhone],
        );
        expect(linked.rows).toEqual([{ e164: '+201000000120' }]);

        const noPhone = 'gid://shopify/Customer/8880000021001';
        expect(await arrive(c, 'customers/create', noPhone, '2026-11-04T10:05:00Z')).toMatchObject({
          status: 'processed',
          outcome: 'no_phone',
        });
        expect(spy).toHaveBeenCalledTimes(1);
        const none = await api.owner.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM customer_external_ids WHERE external_id = $1`,
          [noPhone],
        );
        expect(none.rows[0]?.n).toBe('0');

        // The same customer read back again at the version already applied: stale, nothing called.
        expect(
          await arrive(c, 'customers/update', withPhone, '2026-11-04T10:00:00Z'),
        ).toMatchObject({ status: 'ignored', outcome: 'stale' });
        expect(spy).toHaveBeenCalledTimes(1);

        // A customer the app cannot see any more.
        expect(
          await arrive(
            c,
            'customers/update',
            'gid://shopify/Customer/8880000022001',
            '2026-11-04T11:00:00Z',
          ),
        ).toMatchObject({ status: 'ignored', outcome: 'not_visible' });
        expect(remainingShopifyExchanges()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps every inbox payload of these connections free of a phone, a name, or an address (AC-6)', async () => {
      const { rows } = await api.owner.pool.query<{ text: string }>(
        `SELECT payload::text AS text FROM inbound_events WHERE connection_id = ANY($1::uuid[])`,
        [planted],
      );
      expect(rows.length).toBeGreaterThan(15);
      const inbox = rows.map((row) => row.text).join('\n');
      expect(inbox).not.toMatch(/(\+?20|0)1[0-9]{9}/);
      for (const personal of PERSONAL) expect(inbox.includes(personal), personal).toBe(false);
      const subjects = await api.owner.pool.query<{ topic: string }>(
        `SELECT DISTINCT payload->>'topic' AS topic FROM inbound_events
       WHERE connection_id = ANY($1::uuid[]) ORDER BY 1`,
        [planted],
      );
      expect(subjects.rows.map((row) => row.topic)).toEqual([
        'customers/create',
        'customers/update',
        'orders/cancelled',
        'orders/create',
        'orders/edited',
        'orders/updated',
      ]);
    });
  },
);
