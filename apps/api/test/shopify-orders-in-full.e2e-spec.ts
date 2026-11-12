import { createHmac, randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { SkuDetail } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboundEventFailed } from '../src/connectors/connectors.events.js';
import { InboxJob } from '../src/connectors/shopify/inbox.job.js';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { CustomersService } from '../src/customers/customers.service.js';
import { OrderIntake } from '../src/orders/intake/order-intake.service.js';
import { OrderTransitions } from '../src/orders/transitions/order-transitions.service.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
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

/** Every log line either process writes while the suite runs (security review L6). */
const logLines: string[] = [];
const capture: LoggerService = {
  log: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  error: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  debug: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  verbose: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
};

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
    /** Every `InboundEventFailed` the worker published, as JSON (security review L6). */
    const failedEvents: string[] = [];
    let manager = '';

    /** Plants a Shopify store, its own channel, and an active connection sealed with `SECRET`. */
    const plant = async (config: string = CONFIG): Promise<Planted> => {
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
        [id, storeId, shopDomain, sealed.ciphertext, sealed.keyVersion, config],
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
      api.app.useLogger(capture);
      worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      worker.useLogger(capture);
      worker
        .get(DomainEvents)
        .on(
          InboundEventFailed,
          (_tx, event) => void failedEvents.push(JSON.stringify(event)),
          'orders-in-full-e2e',
        );
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
      manager = await api.signIn(boss.email);
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
          phoneVerified: false,
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

    it('records unverified_phone for a customer webhook whose phone another customer holds and whose Shopify id is unknown: no channel id attached, nothing created (owner ruling L1)', async () => {
      useShopifyScenarios('customer-updated-phone');
      const c = await plant();
      const gid = 'gid://shopify/Customer/8880000020001';
      const holder = await api.owner.pool.query<{ customer_id: string }>(
        `SELECT customer_id FROM customer_phones WHERE phone_e164 = '+201000000120'`,
      );
      if (holder.rows[0] === undefined) {
        const holderId = (
          await api.owner.pool.query<{ id: string }>(
            `INSERT INTO customers (name) VALUES ('Held phone') RETURNING id`,
          )
        ).rows[0]?.id;
        await api.owner.pool.query(
          `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
           VALUES ($1::uuid, '+201000000120', 'mobile', true)`,
          [holderId],
        );
      }
      const before = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM customers`,
      );

      expect(await arrive(c, 'customers/update', gid, '2026-11-04T10:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: 'unverified_phone',
      });

      const attached = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM customer_external_ids WHERE connection_id = $1::uuid`,
        [c.id],
      );
      expect(attached.rows[0]?.n).toBe('0');
      const after = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM customers`,
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('attaches no phone when a known Shopify id arrives with a new phone, and records unverified_phone (owner ruling L1)', async () => {
      useShopifyScenarios('customer-updated-new-phone');
      const c = await plant();
      const gid = 'gid://shopify/Customer/8880000020003';
      const customerId = (
        await api.owner.pool.query<{ id: string }>(
          `INSERT INTO customers (name) VALUES ('Known id') RETURNING id`,
        )
      ).rows[0]?.id as string;
      await api.owner.pool.query(
        `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
         VALUES ($1::uuid, '+201000000199', 'mobile', true)`,
        [customerId],
      );
      await api.owner.pool.query(
        `INSERT INTO customer_external_ids (customer_id, kind, connection_id, external_id)
         VALUES ($1::uuid, 'shopify_customer', $2::uuid, $3)`,
        [customerId, c.id, gid],
      );

      expect(await arrive(c, 'customers/update', gid, '2026-11-04T12:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: 'unverified_phone',
      });

      const phones = await api.owner.pool.query<{ phone_e164: string }>(
        `SELECT phone_e164 FROM customer_phones WHERE customer_id = $1::uuid`,
        [customerId],
      );
      expect(phones.rows).toEqual([{ phone_e164: '+201000000199' }]);
      const stray = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM customer_phones WHERE phone_e164 = '+201000000123'`,
      );
      expect(stray.rows[0]?.n).toBe('0');
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    /** Row counts of the tables inbound processing must never write for these tests (AC-14). */
    const ownedCounts = async (orderId: string) => {
      const count = async (text: string, args: unknown[] = []) =>
        Number((await api.owner.pool.query<{ n: string }>(text, args)).rows[0]?.n);
      return {
        movements: await count('SELECT count(*) AS n FROM stock_movements'),
        credit: await count('SELECT count(*) AS n FROM credit_entries'),
        cashEvents: await count(
          `SELECT count(*) AS n FROM order_events WHERE order_id = $1::uuid AND machine = 'cash'`,
          [orderId],
        ),
      };
    };

    it('takes a cancel that arrives after a fulfillment as the cancel alone, writing no stock, credit, or cash row (AC-13, AC-14)', async () => {
      useShopifyScenarios('order-fulfilled-then-cancelled');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000017001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      const order = await orderOf(c, gid);
      const before = await ownedCounts(order?.id as string);
      expect(await arrive(c, 'orders/updated', gid, '2026-11-03T08:30:05Z')).toMatchObject({
        status: 'processed',
      });
      expect(await ownedCounts(order?.id as string)).toEqual(before);
      expect((await orderOf(c, gid))?.carrier_delivery_created_at).not.toBeNull();
      expect(await arrive(c, 'orders/cancelled', gid, '2026-11-03T12:00:00Z')).toMatchObject({
        status: 'processed',
      });
      // The cancel is the orders module's own rule: an unpaid order moves to nothing to collect, and nothing else.
      const after = await ownedCounts(order?.id as string);
      expect(after).toEqual({ ...before, cashEvents: before.cashEvents + 1 });
      const cash = await api.owner.pool.query<{ to_state: string }>(
        `SELECT to_state FROM order_events WHERE order_id = $1::uuid AND machine = 'cash' ORDER BY recorded_at DESC LIMIT 1`,
        [order?.id],
      );
      expect(cash.rows[0]?.to_state).toBe('nothing_to_collect');
      const { rows } = await api.owner.pool.query<{ cod: string }>(
        `SELECT cod_collected_amount AS cod FROM orders WHERE id = $1::uuid`,
        [order?.id],
      );
      expect(rows[0]?.cod).toBe('0.00');
    });

    it('answers a second Shopify cancel of an already cancelled order with processed cancel_not_applied and no new event (AC-13)', async () => {
      useShopifyScenarios('order-cancelled-twice');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000016001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      await arrive(c, 'orders/cancelled', gid, '2026-11-02T12:00:00Z');
      const order = await orderOf(c, gid);
      const events = async () =>
        Number(
          (
            await api.owner.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM order_events WHERE order_id = $1::uuid`,
              [order?.id],
            )
          ).rows[0]?.n,
        );
      const before = await events();
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T12:30:00Z')).toMatchObject({
        status: 'processed',
        outcome: 'cancel_not_applied',
      });
      expect(await events()).toBe(before);
      expect((await orderOf(c, gid))?.fulfillment_state).toBe('cancelled');
      expect((await mappingOf(c, gid))?.version?.toISOString()).toBe('2026-11-02T12:30:00.000Z');
    });

    it('applies only the cancel when one read back holds both a cancel and an edit (AC-13)', async () => {
      useShopifyScenarios('order-cancelled-with-edit');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000002001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      expect(await arrive(c, 'orders/cancelled', gid, '2026-11-02T13:00:00Z')).toMatchObject({
        status: 'processed',
      });
      const order = await orderOf(c, gid);
      expect(order?.fulfillment_state).toBe('cancelled');
      expect(order?.ship_to_address).toContain('12 شارع الاختبار');
      const { rows } = await api.owner.pool.query<{ reason_code: string }>(
        `SELECT reason_code FROM order_events
         WHERE order_id = $1::uuid AND machine = 'fulfillment' AND to_state = 'cancelled'`,
        [order?.id],
      );
      expect(rows).toEqual([{ reason_code: 'channel.inventory' }]);
    });

    it('coalesces two customer webhooks of one customer into one read back and one findOrCreate (AC-7, AC-15)', async () => {
      useShopifyScenarios('customer-updated-phone');
      const c = await plant();
      const gid = 'gid://shopify/Customer/8880000020001';
      await api.owner.pool.query(`UPDATE connections SET status = 'paused' WHERE id = $1::uuid`, [
        c.id,
      ]);
      const first = await deliver(c, 'customers/create', body(gid, '2026-11-04T10:00:00Z'));
      const second = await deliver(c, 'customers/update', body(gid, '2026-11-04T10:00:00Z'));
      const idOf = async (webhookId: string) =>
        (
          await api.owner.pool.query<{ id: string }>(
            `SELECT id FROM inbound_events WHERE connection_id = $1::uuid AND dedupe_key = $2`,
            [c.id, webhookId],
          )
        ).rows[0]?.id as string;
      const firstId = await idOf(first);
      const secondId = await idOf(second);
      await eventually(
        async () =>
          (
            await api.owner.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM pgboss.job WHERE name = 'connector-shopify'
               AND data->>'eventId' = ANY($1) AND state = 'completed'`,
              [[firstId, secondId]],
            )
          ).rows[0]?.n === '2'
            ? true
            : undefined,
        { timeoutMs: 60_000, what: 'the paused jobs to complete' },
      );
      await api.owner.pool.query(`UPDATE connections SET status = 'active' WHERE id = $1::uuid`, [
        c.id,
      ]);
      const phoneHeld =
        (
          await api.owner.pool.query(
            `SELECT 1 FROM customer_phones WHERE phone_e164 = '+201000000120'`,
          )
        ).rows.length > 0;
      const spy = vi.spyOn(worker.get(CustomersService), 'findOrCreate');
      try {
        const out = await worker
          .get(InboxJob)
          .run({ connectionId: c.id, eventId: firstId }, 'customer-coalesce');
        // An earlier test of this file may already hold the fixture phone: then (owner ruling L1) the
        // unknown Shopify id links nothing and the event records unverified_phone.
        const outcome = phoneHeld ? 'unverified_phone' : null;
        expect(out).toEqual({ status: 'processed', code: outcome });
        expect(spy).toHaveBeenCalledTimes(1);
        const rows = await api.owner.pool.query<{ status: string; outcome: string | null }>(
          `SELECT status, outcome FROM inbound_events WHERE connection_id = $1::uuid
           ORDER BY topic`,
          [c.id],
        );
        expect(rows.rows).toEqual([
          { status: 'processed', outcome },
          { status: 'processed', outcome: 'coalesced' },
        ]);
        expect(remainingShopifyExchanges()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('records payment_method_locked and keeps the cash state when a gateway mapping changes after the cash state moved (AC-14)', async () => {
      useShopifyScenarios('order-prepaid-gateway');
      const c = await plant();
      const cod = 'gid://shopify/Order/5550000005101';
      await arrive(c, 'orders/create', cod, '2026-11-02T09:15:04Z');
      const order = await orderOf(c, cod);
      // The manager maps the COD gateway to another method, and the cash state has already moved.
      await api.owner.pool.query(
        `UPDATE connections SET config = jsonb_set(config, '{gatewayMethods,Cash on Delivery (COD)}', '"instapay"') WHERE id = $1::uuid`,
        [c.id],
      );
      await api.owner.pool.query(`UPDATE orders SET cash_state = 'remitted' WHERE id = $1::uuid`, [
        order?.id,
      ]);
      const answer = await arrive(c, 'orders/updated', cod, '2026-11-02T14:00:00Z');
      expect(answer).toMatchObject({ status: 'processed' });
      expect(answer.outcome).toBe('payment_method_locked');
      expect(await orderOf(c, cod)).toMatchObject({ payment_method: 'cod' });
      expect((await mappingOf(c, cod))?.state['paymentMethodLocked']).toBe(true);
    });

    /** A SKU made through the catalog route, archived when asked. */
    const sku = async (code: string, archived = false): Promise<string> => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '450.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      const id = SkuDetail.parse(reply.body).id;
      if (archived) {
        await api.owner.pool.query(
          `UPDATE product_variants SET archived_at = now() WHERE id = $1::uuid`,
          [id],
        );
      }
      return id;
    };

    /** Maps a Shopify variant to an app variant on the connection, as task 8 will. */
    const mapVariant = (c: Planted, variantGid: string, variantId: string) =>
      api.owner.pool.query(
        `INSERT INTO connection_external_ids (connection_id, entity, external_id, local_id)
         VALUES ($1::uuid, 'variant', $2, $3::uuid)`,
        [c.id, variantGid, variantId],
      );

    const auditActions = async (orderId: string) =>
      (
        await api.owner.pool.query<{ action: string }>(
          `SELECT action FROM audit_entries WHERE record_id = $1::uuid ORDER BY recorded_at, id`,
          [orderId],
        )
      ).rows.map((row) => row.action);

    it('rederives the payment from the creation facts only when a creation gateway is mapped differently (lead decision D10)', async () => {
      useShopifyScenarios('order-cod-remapped');
      // Created with the COD gateway unmapped; marked as paid on `manual` (unmapped) later.
      const c = await plant(JSON.stringify({ appOwner: 'organization', gatewayMethods: {} }));
      const gid = 'gid://shopify/Order/5550000021001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      expect(await orderOf(c, gid)).toMatchObject({
        payment_method: 'cod',
        prepaid_amount: '0.00',
      });
      expect((await mappingOf(c, gid))?.state).toMatchObject({
        creationGateways: { 'Cash on Delivery (COD)': null },
        creationTransactionIds: [],
      });
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T14:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await orderOf(c, gid)).toMatchObject({
        payment_method: 'cod',
        prepaid_amount: '0.00',
      });

      // The manager maps the COD gateway to another method: the next read rederives, and the later
      // manual sale is not counted as a prepayment.
      await api.owner.pool.query(
        `UPDATE connections SET config = jsonb_set(config, '{gatewayMethods}', '{"Cash on Delivery (COD)":"instapay"}') WHERE id = $1::uuid`,
        [c.id],
      );
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T15:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const order = await orderOf(c, gid);
      expect(order).toMatchObject({
        payment_method: 'instapay',
        prepaid_amount: '0.00',
        prepaid_method: null,
      });
      expect(await auditActions(order?.id as string)).toContain('order.payment_method_rederived');
      expect((await mappingOf(c, gid))?.state).toMatchObject({
        creationGateways: { 'Cash on Delivery (COD)': null },
        creationTransactionIds: [],
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('links a late mapped variant with linkChannelLineVariant before the edit, with no edit recorded, and leaves a retired SKU unmapped (AC-9)', async () => {
      useShopifyScenarios('order-late-link');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000022001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      const order = await orderOf(c, gid);
      expect((await mappingOf(c, gid))?.state['unmappedLines']).toHaveLength(3);
      const live = await sku(`LL-${randomUUID().slice(0, 6)}`);
      const retired = await sku(`LR-${randomUUID().slice(0, 6)}`, true);
      await mapVariant(c, 'gid://shopify/ProductVariant/7770000000101', live);
      await mapVariant(c, 'gid://shopify/ProductVariant/7770000000999', retired);
      const intake = worker.get(OrderIntake);
      const link = vi.spyOn(intake, 'linkChannelLineVariant');
      try {
        expect(await arrive(c, 'orders/updated', gid, '2026-11-02T10:00:00Z')).toMatchObject({
          status: 'processed',
          outcome: null,
        });
        expect(link).toHaveBeenCalledTimes(2);
      } finally {
        link.mockRestore();
      }
      const variants = await api.owner.pool.query<{ variant_id: string | null }>(
        `SELECT variant_id FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [order?.id],
      );
      expect(variants.rows.map((row) => row.variant_id)).toEqual([live, null, null]);
      expect(await auditActions(order?.id as string)).not.toContain('order.edited');
      expect((await orderOf(c, gid))?.updated_at).toEqual(order?.updated_at);
      expect((await mappingOf(c, gid))?.state['unmappedLines']).toEqual([
        {
          channelLineId: 'gid://shopify/LineItem/55500000220012',
          variantGid: 'gid://shopify/ProductVariant/7770000000999',
        },
        { channelLineId: 'gid://shopify/LineItem/55500000220013', variantGid: null },
      ]);
    });

    it('takes the named move of a new order whose first read already shows a cancel or a fulfillment (AC-13)', async () => {
      useShopifyScenarios('order-cancelled-customer', 'order-go-live-import');
      const c = await plant();
      const cancelled = 'gid://shopify/Order/5550000006001';
      expect(await arrive(c, 'orders/create', cancelled, '2026-11-02T10:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const order = await orderOf(c, cancelled);
      expect(order?.fulfillment_state).toBe('cancelled');
      const reasons = await api.owner.pool.query<{ reason_code: string }>(
        `SELECT reason_code FROM order_events
         WHERE order_id = $1::uuid AND machine = 'fulfillment' AND to_state = 'cancelled'`,
        [order?.id],
      );
      expect(reasons.rows).toEqual([{ reason_code: 'channel.customer' }]);

      // A live order (no go live instant) read for the first time already fulfilled.
      const fulfilled = 'gid://shopify/Order/5550000009101';
      expect(await arrive(c, 'orders/create', fulfilled, '2026-10-23T09:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect((await orderOf(c, fulfilled))?.carrier_delivery_created_at?.toISOString()).toBe(
        '2026-10-23T09:00:00.000Z',
      );
      expect((await mappingOf(c, fulfilled))?.state['deliveryFulfillmentId']).toBe(
        'gid://shopify/Fulfillment/9990000009101',
      );
    });

    it('holds the applied lines of an imported shipped order, so a later refund never reaches applyChannelEdit (code re-review R1)', async () => {
      useShopifyScenarios('order-imported-refunded');
      const c = await plant();
      await api.owner.pool.query(
        `UPDATE connections SET go_live_at = '2026-11-01T00:00:00Z' WHERE id = $1::uuid`,
        [c.id],
      );
      const gid = 'gid://shopify/Order/5550000024001';
      expect(await arrive(c, 'orders/create', gid, '2026-10-23T09:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const order = await orderOf(c, gid);
      expect(order?.fulfillment_state).toBe('shipped');
      expect((await mappingOf(c, gid))?.state['deliveryFulfillmentId']).toBe(
        'gid://shopify/Fulfillment/9990000024001',
      );
      const edit = vi.spyOn(worker.get(OrderIntake), 'applyChannelEdit');
      try {
        // 02: the line refunded and restocked after the import (current quantity 0).
        expect(await arrive(c, 'orders/updated', gid, '2026-11-05T10:00:00Z')).toMatchObject({
          status: 'processed',
          outcome: null,
        });
        expect(edit).toHaveBeenCalledTimes(1);
        expect(edit.mock.calls[0]?.[2].lines.map((line) => line.quantity)).toEqual([1]);
      } finally {
        edit.mockRestore();
      }
      expect(await linesOf(order?.id as string)).toEqual([['55500000240011', 'open', null]]);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('creates an order whose gateway name holds U+0000, storing no such key in the jsonb mapping state (security review N3)', async () => {
      useShopifyScenarios('order-gateway-nul');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000025001';
      expect(await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await orderOf(c, gid)).toMatchObject({ payment_method: 'cod' });
      expect((await mappingOf(c, gid))?.state).toMatchObject({
        creationGateways: {},
        unmappedGateways: ['Cash onDelivery'],
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('creates an order whose gateway name and discount code hold lone surrogates, the whole mapping state stored (code review R4, security review N4)', async () => {
      useShopifyScenarios('order-lone-surrogate');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000026001';
      expect(await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await orderOf(c, gid)).toMatchObject({ payment_method: 'cod' });
      const mapping = await mappingOf(c, gid);
      expect(mapping?.state).toMatchObject({
        creationGateways: {},
        unmappedGateways: ['Wallet'],
        discountCodes: ['SAVE', 'WELCOME10'],
      });
      const discount = await api.owner.pool.query<{ discount_code: string | null }>(
        `SELECT discount_code FROM orders WHERE store_id = $1::uuid AND channel_order_ref = $2`,
        [c.storeId, gid],
      );
      expect(discount.rows[0]?.discount_code).toBe('SAVE');
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('applies an edit made before the fulfillment on the read where the fulfillment first appears, then records the carrier delivery (code review m1)', async () => {
      useShopifyScenarios('order-swapped-then-fulfilled');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000023001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T12:00:05Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const order = await orderOf(c, gid);
      expect(await linesOf(order?.id as string)).toEqual([
        ['55500000230011', 'cancelled', 'edit_removal'],
        ['55500000230012', 'open', null],
        ['55500000230013', 'open', null],
      ]);
      expect(order?.ship_to_address).toContain('30 شارع التعديل');
      expect(order?.carrier_delivery_created_at?.toISOString()).toBe('2026-11-02T12:00:00.000Z');
      expect((await mappingOf(c, gid))?.state['deliveryFulfillmentId']).toBe(
        'gid://shopify/Fulfillment/9990000023001',
      );
    });

    it('leaves the other received events of a held order received, so they run their own read back (security review L2)', async () => {
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
      await api.owner.pool.query(`UPDATE connections SET status = 'paused' WHERE id = $1::uuid`, [
        c.id,
      ]);
      const first = await deliver(c, 'orders/edited', body(gid, '2026-11-02T11:40:09Z'));
      const second = await deliver(c, 'orders/updated', body(gid, '2026-11-02T11:40:09Z'));
      const rowOf = async (webhookId: string) =>
        (
          await api.owner.pool.query<{ id: string; status: string; outcome: string | null }>(
            `SELECT id, status, outcome FROM inbound_events
             WHERE connection_id = $1::uuid AND dedupe_key = $2`,
            [c.id, webhookId],
          )
        ).rows[0];
      const ids = [(await rowOf(first))?.id as string, (await rowOf(second))?.id as string];
      await eventually(
        async () =>
          (
            await api.owner.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM pgboss.job WHERE name = 'connector-shopify'
               AND data->>'eventId' = ANY($1) AND state = 'completed'`,
              [ids],
            )
          ).rows[0]?.n === '2'
            ? true
            : undefined,
        { timeoutMs: 60_000, what: 'the paused jobs to complete' },
      );
      await api.owner.pool.query(`UPDATE connections SET status = 'active' WHERE id = $1::uuid`, [
        c.id,
      ]);
      const out = await worker
        .get(InboxJob)
        .run({ connectionId: c.id, eventId: ids[0] as string }, 'held-no-coalesce');
      expect(out).toEqual({ status: 'ignored', code: 'held_write_back_open' });
      expect(await rowOf(second)).toMatchObject({ status: 'received', outcome: null });
    });

    it('reruns the known order unit once after a deadlock, leaving one edit, one audit entry, and one saved mapping (code review m6)', async () => {
      useShopifyScenarios('order-edited-size-swap');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000002001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      const order = await orderOf(c, gid);
      const intake = worker.get(OrderIntake);
      const original = intake.applyChannelEdit.bind(intake);
      // A JS error carrying 40P01 after the real write: proves the unit's rollback and single rerun,
      // not PostgreSQL's own deadlock detection (code re-review nit).
      const edit = vi.spyOn(intake, 'applyChannelEdit').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      });
      try {
        expect(await arrive(c, 'orders/edited', gid, '2026-11-02T11:40:09Z')).toMatchObject({
          status: 'processed',
          outcome: null,
        });
        expect(edit).toHaveBeenCalledTimes(2);
      } finally {
        edit.mockRestore();
      }
      expect(await linesOf(order?.id as string)).toEqual([
        ['6660000002001', 'cancelled', 'edit_removal'],
        ['6660000002002', 'open', null],
        ['6660000002003', 'open', null],
      ]);
      expect(
        (await auditActions(order?.id as string)).filter((action) => action === 'order.edited'),
      ).toHaveLength(1);
      expect((await mappingOf(c, gid))?.version?.toISOString()).toBe('2026-11-02T11:40:09.000Z');
    });

    it('fails a read back of a known order whose mapping state is damaged, MAPPING_STATE_UNREADABLE with InboundEventFailed', async () => {
      useShopifyScenarios('order-edited-size-swap');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000002001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      await api.owner.pool.query(
        `UPDATE connection_external_ids SET state = '{"appliedLines":{"x":"bad"}}'::jsonb
         WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
        [c.id, gid],
      );
      const event = await arrive(c, 'orders/edited', gid, '2026-11-02T11:40:09Z');
      expect(event).toMatchObject({
        status: 'failed',
        failure_code: 'MAPPING_STATE_UNREADABLE',
        subject_label: '#1002',
      });
      expect(failedEvents.some((json) => json.includes(event.id))).toBe(true);
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

      // Security review L6: the mapping state, the event code and label columns, every
      // InboundEventFailed, and every log line stay free of personal data too.
      const texts = async (query: string) =>
        (await api.owner.pool.query<{ text: string }>(query, [planted])).rows
          .map((row) => row.text)
          .join('\n');
      const places = {
        mappings: await texts(
          `SELECT state::text AS text FROM connection_external_ids
           WHERE connection_id = ANY($1::uuid[])`,
        ),
        columns: await texts(
          `SELECT concat_ws(' ', subject_label, outcome, failure_code) AS text FROM inbound_events
           WHERE connection_id = ANY($1::uuid[])`,
        ),
        failedEvents: failedEvents.join('\n'),
        logs: logLines.join('\n'),
      };
      expect(places.mappings).toContain('appliedLines');
      expect(places.failedEvents).toContain('MAPPING_STATE_UNREADABLE');
      expect(places.logs).toContain('inbox event=');
      for (const [place, text] of Object.entries(places)) {
        expect(text, `phone in ${place}`).not.toMatch(/(\+?20|0)1[0-9]{9}/);
        for (const personal of PERSONAL) {
          expect(text.includes(personal), `${personal} in ${place}`).toBe(false);
        }
      }
    });
  },
);
