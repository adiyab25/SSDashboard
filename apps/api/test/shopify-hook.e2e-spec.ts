import { createHmac, randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { OrderListResponse } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { InboundEventFailed } from '../src/connectors/connectors.events.js';
import { HOOK_BODY_LIMIT_BYTES } from '../src/connectors/hooks/mount-hooks.js';
import { InboxJob } from '../src/connectors/shopify/inbox.job.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import {
  readShopifyFixture,
  remainingShopifyExchanges,
  useShopifyScenarios,
} from './shopify-fixture-fetch.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0015 task 7 (AC-4 to AC-9; *Critical test scenarios* "Hook", "Inbox privacy" (payload
// part), "One mapper" (the webhook path), "Failed reads" (the event part)): the milestone 1
// tracer bullet. A webhook signed in the test with a fake secret reaches the real api in process;
// the hook verifies it on the raw bytes, records the inbox row and its job in one transaction; the
// real worker's inbox job reads the order back from the recorded (synthetic) fixtures through the
// refusing fetch and applies it through the real mapper into `OrderIntake.createFromChannel`, and
// the order shows in `GET /api/orders` with its store. A sentinel secret is searched in every log
// line and row.

// Load the root .env before the api saves the environment (the worker reads it after).
devDatabaseUrl();

/** The webhook secret (the client secret) of every connection here; it must never come back out. */
const SENTINEL_SECRET = `sentinel-hook-secret-${randomUUID()}`;
/** The fixture's ship to name, phone, and address line: never in an inbox payload. */
const FIXTURE_NAME = 'مها تجريبية';
const FIXTURE_PHONE = '+201000000101';
const FIXTURE_ADDRESS = '12 شارع الاختبار';

/** Every log line written while the suite runs, in either process. */
const logLines: string[] = [];
const capture: LoggerService = {
  log: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  error: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  debug: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  verbose: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
};

/** A planted Shopify connection with its store. */
interface Planted {
  id: string;
  shopDomain: string;
  storeCode: string;
  storeId: string;
}

/** One delivery's answer. */
interface Delivered {
  status: number;
  text: string;
  webhookId: string;
}

/** The numeric id of a Shopify gid. */
const restId = (gid: string) => Number(gid.split('/').pop());

describe('the Shopify hook and the inbox (spec 0015 task 7)', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let worker: TestingModule;
  let manager: string;
  let refusingFetch: typeof fetch;
  let a: Planted;
  let n = 0;
  /** Inside `InboundEventFailed`'s handler: what the event looked like in and out of the publisher. */
  const failedSeen: { eventId: string; inside: string; outside: string }[] = [];

  const tag = () => {
    n += 1;
    return `${n}${randomUUID().slice(0, 6)}`;
  };

  /** Plants a Shopify store, its channel, and a connection sealed with the sentinel secret. */
  const plant = async (
    options: { status?: string; health?: string; health_reason?: string | null } = {},
  ): Promise<Planted> => {
    const t = tag();
    const storeCode = `HK${t.toUpperCase()}`;
    const shopDomain = `hookfx-${t}.myshopify.com`;
    const id = randomUUID();
    const store = await api.owner.pool.query<{ id: string }>(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ($1, '{"en":"Hook store"}', '{"en":"Hook store"}', 'shopify') RETURNING id`,
      [storeCode],
    );
    const storeId = store.rows[0]?.id as string;
    await api.owner.pool.query(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ($1, '{"en":"Hook store"}', 'shopify', $2::uuid)`,
      [storeCode, storeId],
    );
    const sealed = api.app
      .get(ConnectionSecrets)
      .seal(
        { kind: 'client_credentials', clientId: `client-${t}-WXYZ`, clientSecret: SENTINEL_SECRET },
        id,
      );
    await api.owner.pool.query(
      `INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                credentials_ciphertext, credentials_key_version, credentials_hint,
                                credentials_updated_at, config, health, health_reason)
       VALUES ($1::uuid, 'shopify', 'Hook store', $2::uuid, $3, $4, $5, $6, 'WXYZ', now(),
               '{"appOwner":"organization","altPhoneAttribute":"alt_phone"}'::jsonb, $7, $8)`,
      [
        id,
        storeId,
        options.status ?? 'active',
        shopDomain,
        sealed.ciphertext,
        sealed.keyVersion,
        options.health ?? 'ok',
        options.health_reason ?? null,
      ],
    );
    return { id, shopDomain, storeCode, storeId };
  };

  /** A webhook body as Shopify's REST payload would carry it, personal fields included. */
  const orderBody = (gid: string, updatedAt = '2026-11-02T09:15:04Z') => ({
    id: restId(gid),
    admin_graphql_api_id: gid,
    name: '#9999',
    updated_at: updatedAt,
    phone: FIXTURE_PHONE,
    email: 'maha.fixture@example.com',
    note: 'اتصلوا قبل التوصيل (fixture note)',
    shipping_address: { name: FIXTURE_NAME, phone: FIXTURE_PHONE, address1: FIXTURE_ADDRESS },
    line_items: [{ title: 'Fixture Basic Tee', sku: 'FX-TEE-BLK-M' }],
  });

  /** Sends one signed delivery; `change` alters the raw bytes or headers after signing. */
  const deliver = async (
    connection: { id: string; shopDomain: string },
    topic: string,
    body: unknown,
    options: {
      webhookId?: string;
      raw?: Buffer;
      tamper?: boolean;
      shop?: string;
      signature?: string | null;
      path?: string;
    } = {},
  ): Promise<Delivered> => {
    const webhookId = options.webhookId ?? randomUUID();
    let raw = options.raw ?? Buffer.from(JSON.stringify(body), 'utf8');
    const signature = createHmac('sha256', SENTINEL_SECRET).update(raw).digest('base64');
    if (options.tamper) {
      raw = Buffer.from(raw);
      raw[5] = (raw[5] ?? 0) ^ 1;
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': options.shop ?? connection.shopDomain,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-api-version': '2026-10',
      'x-shopify-triggered-at': new Date().toISOString(),
    };
    if (options.signature !== null)
      headers['x-shopify-hmac-sha256'] = options.signature ?? signature;
    const response = await fetch(
      `${api.base}${options.path ?? `/api/hooks/shopify/${connection.id}`}`,
      { method: 'POST', headers, body: new Uint8Array(raw) },
    );
    return { status: response.status, text: await response.text(), webhookId };
  };

  const count = async (query: string, values: unknown[] = []): Promise<number> => {
    const { rows } = await api.owner.pool.query<{ n: string }>(query, values);
    return Number(rows[0]?.n ?? 0);
  };

  interface EventRow {
    id: string;
    status: string;
    outcome: string | null;
    failure_code: string | null;
    attempts: number;
    subject_label: string | null;
    subject_external_id: string | null;
    payload: unknown;
  }

  const eventOf = async (connectionId: string, webhookId: string): Promise<EventRow> => {
    const { rows } = await api.owner.pool.query<EventRow>(
      `SELECT id, status, outcome, failure_code, attempts, subject_label, subject_external_id,
              payload
       FROM inbound_events WHERE connection_id = $1::uuid AND dedupe_key = $2`,
      [connectionId, webhookId],
    );
    const row = rows[0];
    if (!row) throw new Error('no inbox row for that delivery');
    return row;
  };

  /** Waits until the event left `received`. */
  const settled = (connectionId: string, webhookId: string) =>
    eventually(
      async () => {
        const row = await eventOf(connectionId, webhookId);
        return row.status === 'received' ? undefined : row;
      },
      { timeoutMs: 60_000, what: `event ${webhookId} to settle` },
    );

  const health = async (id: string) =>
    (
      await api.owner.pool.query<{ health: string; health_reason: string | null }>(
        'SELECT health, health_reason FROM connections WHERE id = $1::uuid',
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    api = await startInProcessApi();
    api.app.useLogger(capture);
    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    worker.useLogger(capture);

    // `InboundEventFailed` is published in the transaction that marks the event failed: inside the
    // handler the event already reads `failed`, while another connection still sees `received`.
    worker.get(DomainEvents).on(
      InboundEventFailed,
      async (tx, event) => {
        const inside = await tx.execute<{ status: string }>(sql`
          SELECT status FROM inbound_events WHERE id = ${event.eventId}::uuid`);
        const outside = await api.owner.pool.query<{ status: string }>(
          'SELECT status FROM inbound_events WHERE id = $1::uuid',
          [event.eventId],
        );
        failedSeen.push({
          eventId: event.eventId,
          inside: inside.rows[0]?.status ?? '',
          outside: outside.rows[0]?.status ?? '',
        });
      },
      'shopify-hook-e2e',
    );
    await worker.init();

    // The token exchange of a client credentials connection is answered from the recorded
    // `connect-ok` grant (the token is cached per connection, so once per connection); every
    // other request goes to the refusing fetch.
    const grant = readShopifyFixture('connect-ok/01-access-token.json').response;
    refusingFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/admin/oauth/access_token') {
        return new Response(JSON.stringify(grant.body), {
          status: grant.status,
          headers: grant.headers,
        });
      }
      return refusingFetch(input, init);
    };

    const boss = await api.addPerson(['manager']);
    manager = await api.signIn(boss.email);
    a = await plant();
  }, 180_000);

  afterAll(async () => {
    if (refusingFetch) globalThis.fetch = refusingFetch;
    await worker?.close();
    await api?.close();
  });

  it('turns a signed orders/create into an order in the orders list (the tracer bullet)', async () => {
    useShopifyScenarios('order-created-cod');
    const gid = 'gid://shopify/Order/5550000001001';
    const first = await deliver(a, 'orders/create', orderBody(gid));
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({});

    // The same delivery again answers 200 and adds nothing.
    const again = await deliver(a, 'orders/create', orderBody(gid), { webhookId: first.webhookId });
    expect(again.status).toBe(200);
    expect(
      await count('SELECT count(*) AS n FROM inbound_events WHERE connection_id = $1::uuid', [
        a.id,
      ]),
    ).toBe(1);

    const event = await settled(a.id, first.webhookId);
    expect(event).toMatchObject({
      status: 'processed',
      outcome: null,
      failure_code: null,
      subject_label: '#1001',
      subject_external_id: gid,
      payload: { topic: 'orders/create', id: gid, updatedAt: '2026-11-02T09:15:04.000Z' },
    });
    // One read back, one job (the repeat sent none), with ids only in its data.
    expect(remainingShopifyExchanges()).toEqual([]);
    const jobs = await api.owner.pool.query<{ data: unknown }>(
      `SELECT data FROM pgboss.job WHERE name = 'connector-shopify' AND data->>'eventId' = $1`,
      [event.id],
    );
    expect(jobs.rows.map((row) => row.data)).toEqual([
      {
        kind: 'inbox',
        connectionId: a.id,
        eventId: event.id,
        capability: 'connectors.shopify.sync',
      },
    ]);

    // The order shows in the list with its store.
    const list = await api.call(manager, 'GET', `/api/orders?storeId=${a.storeId}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const items = OrderListResponse.parse(list.body).items.filter(
      (item) => item.storeCode === a.storeCode,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      orderNumber: '#1001',
      storeCode: a.storeCode,
      fulfillmentState: 'new',
      type: 'sale',
    });

    // The mapping: the order id, the applied version, and the connector's own state.
    const mapping = await api.owner.pool.query<{
      local_id: string;
      version: string;
      state: Record<string, unknown>;
    }>(
      `SELECT local_id,
              to_char(external_version AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS version,
              state
       FROM connection_external_ids
       WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
      [a.id, gid],
    );
    expect(mapping.rows).toHaveLength(1);
    expect(mapping.rows[0]).toMatchObject({
      local_id: items[0]?.id,
      version: '2026-11-02T09:15:04Z',
      state: {
        appliedLineIds: [
          'gid://shopify/LineItem/6660000001001',
          'gid://shopify/LineItem/6660000001002',
        ],
        discountCodes: ['WELCOME10'],
        // No variant is mapped before task 8, so both lines stay unmapped.
        unmappedLines: [
          {
            channelLineId: 'gid://shopify/LineItem/6660000001001',
            variantGid: 'gid://shopify/ProductVariant/7770000000101',
          },
          {
            channelLineId: 'gid://shopify/LineItem/6660000001002',
            variantGid: 'gid://shopify/ProductVariant/7770000000102',
          },
        ],
      },
    });
    const order = await api.owner.pool.query<{ channel_order_ref: string; lines: string }>(
      `SELECT o.channel_order_ref, (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id) AS lines
       FROM orders o WHERE o.id = $1::uuid`,
      [items[0]?.id],
    );
    expect(order.rows[0]).toEqual({ channel_order_ref: gid, lines: '2' });
    const freshness = await api.owner.pool.query<{ inbound: boolean; ordered: boolean }>(
      `SELECT last_inbound_at IS NOT NULL AS inbound, last_order_at IS NOT NULL AS ordered
       FROM connections WHERE id = $1::uuid`,
      [a.id],
    );
    expect(freshness.rows[0]).toEqual({ inbound: true, ordered: true });
  });

  it('answers the same empty 401 for a tampered byte, a wrong shop, no signature, an unknown, malformed, or archived connection, with no row', async () => {
    const archived = await plant({ status: 'archived' });
    const before = await count('SELECT count(*) AS n FROM inbound_events');
    const body = orderBody('gid://shopify/Order/5550000001001');
    const refusals = [
      await deliver(a, 'orders/updated', body, { tamper: true }),
      await deliver(a, 'orders/updated', body, { shop: 'another-shop.myshopify.com' }),
      await deliver(a, 'orders/updated', body, { signature: null }),
      await deliver(a, 'orders/updated', body, { signature: 'AAAA' }),
      await deliver({ id: randomUUID(), shopDomain: a.shopDomain }, 'orders/updated', body),
      await deliver(a, 'orders/updated', body, { path: '/api/hooks/shopify/not-a-uuid' }),
      await deliver(archived, 'orders/updated', body),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(401);
      expect(refusal.text).toBe('');
    }
    expect(await count('SELECT count(*) AS n FROM inbound_events')).toBe(before);
    // Four failures on the live connection within a minute count once.
    const failures = await api.owner.pool.query<{ n: number; at: boolean }>(
      `SELECT hook_auth_failures AS n, last_hook_auth_failure_at IS NOT NULL AS at
       FROM connections WHERE id = $1::uuid`,
      [a.id],
    );
    expect(failures.rows[0]).toEqual({ n: 1, at: true });
  });

  it('answers 413 to 2 MB and one byte, with no row', async () => {
    const before = await count('SELECT count(*) AS n FROM inbound_events');
    const raw = Buffer.alloc(HOOK_BODY_LIMIT_BYTES + 1, 0x20);
    const reply = await deliver(a, 'orders/updated', null, { raw });
    expect(reply.status).toBe(413);
    expect(reply.text).toBe('');
    expect(await count('SELECT count(*) AS n FROM inbound_events')).toBe(before);
  });

  it('records a known order with a newer snapshot as update_deferred, changing nothing, and a snapshot not newer as stale', async () => {
    useShopifyScenarios('order-edited-size-swap');
    const gid = 'gid://shopify/Order/5550000002001';
    const created = await deliver(a, 'orders/create', orderBody(gid));
    expect((await settled(a.id, created.webhookId)).status).toBe('processed');
    const snapshot = async () =>
      (
        await api.owner.pool.query<{ order: unknown; lines: unknown; version: string }>(
          `SELECT row_to_json(o)::jsonb AS order,
                  (SELECT jsonb_agg(row_to_json(l) ORDER BY l.position) FROM order_lines l
                   WHERE l.order_id = o.id) AS lines,
                  (SELECT external_version::text FROM connection_external_ids m
                   WHERE m.external_id = $1 AND m.entity = 'order') AS version
           FROM orders o WHERE o.channel_order_ref = $1`,
          [gid],
        )
      ).rows[0];
    const before = await snapshot();

    // Read back 02: the size swap, newer than the applied version (D1: task 9 applies it).
    const edited = await deliver(a, 'orders/edited', orderBody(gid, '2026-11-02T11:40:09Z'));
    expect(await settled(a.id, edited.webhookId)).toMatchObject({
      status: 'ignored',
      outcome: 'update_deferred',
      subject_label: '#1002',
    });
    expect(await snapshot()).toEqual(before);

    // The tracer order read back again with the version already applied: stale.
    useShopifyScenarios('order-created-cod');
    const repeat = await deliver(
      a,
      'orders/updated',
      orderBody('gid://shopify/Order/5550000001001'),
    );
    expect(await settled(a.id, repeat.webhookId)).toMatchObject({
      status: 'ignored',
      outcome: 'stale',
    });
    // One read each: the size swap's later echo reads (03, 04) were never asked for.
    expect(remainingShopifyExchanges()).toEqual([
      'order-edited-size-swap/03-order-read.json',
      'order-edited-size-swap/04-order-read.json',
    ]);
  });

  it('reads three webhooks of one order back once: one processed, two coalesced (a paused connection leaves them received)', async () => {
    const gid = 'gid://shopify/Order/5550000003001';
    await api.owner.pool.query(`UPDATE connections SET status = 'paused' WHERE id = $1::uuid`, [
      a.id,
    ]);
    const deliveries = [
      await deliver(a, 'orders/create', orderBody(gid)),
      await deliver(a, 'orders/updated', orderBody(gid)),
      await deliver(a, 'orders/edited', orderBody(gid)),
    ];
    for (const delivery of deliveries) expect(delivery.status).toBe(200);
    const events = await Promise.all(deliveries.map((d) => eventOf(a.id, d.webhookId)));
    const ids = events.map((event) => event.id);
    // Each job meets the paused connection, completes, and leaves its event received.
    await eventually(
      async () =>
        (await count(
          `SELECT count(*) AS n FROM pgboss.job
           WHERE name = 'connector-shopify' AND data->>'eventId' = ANY($1) AND state = 'completed'`,
          [ids],
        )) === 3
          ? true
          : undefined,
      { timeoutMs: 60_000, what: 'the paused jobs to complete' },
    );
    for (const id of ids) {
      expect(
        await count(
          `SELECT count(*) AS n FROM inbound_events WHERE id = $1::uuid AND status = 'received'`,
          [id],
        ),
      ).toBe(1);
    }

    // Resumed (task 16 sends the work again; here the job is run once for the first event).
    await api.owner.pool.query(`UPDATE connections SET status = 'active' WHERE id = $1::uuid`, [
      a.id,
    ]);
    useShopifyScenarios('order-unmapped-line');
    const outcome = await worker
      .get(InboxJob)
      .run({ connectionId: a.id, eventId: ids[0] as string }, 'resume-stand-in');
    expect(outcome).toEqual({ status: 'processed', code: null });
    expect(remainingShopifyExchanges()).toEqual([]);
    const after = await Promise.all(deliveries.map((d) => eventOf(a.id, d.webhookId)));
    expect(after.map((row) => [row.status, row.outcome, row.subject_label])).toEqual([
      ['processed', null, '#1003'],
      ['processed', 'coalesced', '#1003'],
      ['processed', 'coalesced', '#1003'],
    ]);
    expect(
      await count('SELECT count(*) AS n FROM orders WHERE channel_order_ref = $1', [gid]),
    ).toBe(1);
  });

  it('records an empty read back as not_visible and a test order as test_order, writing no order', async () => {
    useShopifyScenarios('order-not-visible', 'order-test-order');
    const hidden = await deliver(
      a,
      'orders/updated',
      orderBody('gid://shopify/Order/5550000011001'),
    );
    expect(await settled(a.id, hidden.webhookId)).toMatchObject({
      status: 'ignored',
      outcome: 'not_visible',
      subject_label: null,
    });
    const test = await deliver(a, 'orders/create', orderBody('gid://shopify/Order/5550000012001'));
    expect(await settled(a.id, test.webhookId)).toMatchObject({
      status: 'ignored',
      outcome: 'test_order',
      subject_label: '#1012',
    });
    expect(remainingShopifyExchanges()).toEqual([]);
    expect(
      await count(`SELECT count(*) AS n FROM orders WHERE channel_order_ref = ANY($1)`, [
        ['gid://shopify/Order/5550000011001', 'gid://shopify/Order/5550000012001'],
      ]),
    ).toBe(0);
  });

  it('fails an order whose apply throws with its code and InboundEventFailed in the same transaction, writing no order', async () => {
    // A second order named #1001 in the same store: OrderNumberTaken.
    useShopifyScenarios('order-number-collision');
    const gid = 'gid://shopify/Order/5550000007002';
    const reply = await deliver(a, 'orders/create', orderBody(gid));
    const event = await settled(a.id, reply.webhookId);
    expect(event).toMatchObject({
      status: 'failed',
      failure_code: 'ORDER_NUMBER_TAKEN',
      subject_label: '#1001',
      outcome: null,
    });
    expect(failedSeen.filter((seen) => seen.eventId === event.id)).toEqual([
      { eventId: event.id, inside: 'failed', outside: 'received' },
    ]);
    expect(
      await count('SELECT count(*) AS n FROM orders WHERE channel_order_ref = $1', [gid]),
    ).toBe(0);
    // The domain writes rolled back: no mapping row either.
    expect(
      await count(
        `SELECT count(*) AS n FROM connection_external_ids WHERE external_id = $1 AND entity = 'order'`,
        [gid],
      ),
    ).toBe(0);
  });

  it('keeps an event received with its attempts counted on a 500, and applies it on the retry', async () => {
    useShopifyScenarios('order-read-server-error');
    const gid = 'gid://shopify/Order/5550000010001';
    const reply = await deliver(a, 'orders/create', orderBody(gid));
    const failedOnce = await eventually(
      async () => {
        const row = await eventOf(a.id, reply.webhookId);
        return row.attempts >= 1 ? row : undefined;
      },
      { timeoutMs: 60_000, what: 'the first read to fail' },
    );
    expect(failedOnce).toMatchObject({ status: 'received', attempts: 1, failure_code: null });
    expect(await health(a.id)).toEqual({ health: 'ok', health_reason: null });

    // The retry (pg-boss would send it after its backoff; run here at once).
    const outcome = await worker
      .get(InboxJob)
      .run({ connectionId: a.id, eventId: failedOnce.id }, 'retry-stand-in');
    expect(outcome).toEqual({ status: 'processed', code: null });
    expect(await eventOf(a.id, reply.webhookId)).toMatchObject({
      status: 'processed',
      attempts: 1,
      subject_label: '#1010',
    });
    expect(
      await count('SELECT count(*) AS n FROM orders WHERE channel_order_ref = $1', [gid]),
    ).toBe(1);
  });

  it('sets READS_FAILING after three hours of failed reads, cleared by the next good read', async () => {
    // Paused while it is planted, so the hook's own job leaves the event alone.
    const c = await plant({ status: 'paused' });
    const gid = 'gid://shopify/Order/5550000010001';
    const reply = await deliver(c, 'orders/create', orderBody(gid));
    const event = await eventOf(c.id, reply.webhookId);
    await eventually(
      async () =>
        (await count(
          `SELECT count(*) AS n FROM pgboss.job WHERE data->>'eventId' = $1 AND state = 'completed'`,
          [event.id],
        )) === 1
          ? true
          : undefined,
      { timeoutMs: 60_000, what: 'the paused job to complete' },
    );
    // The event arrived over three hours ago; its first read fails now.
    await api.owner.pool.query(
      `UPDATE inbound_events SET received_at = now() - interval '3 hours 1 minute' WHERE id = $1::uuid`,
      [event.id],
    );
    await api.owner.pool.query(`UPDATE connections SET status = 'active' WHERE id = $1::uuid`, [
      c.id,
    ]);
    useShopifyScenarios('order-read-server-error');
    const inbox = worker.get(InboxJob);
    await expect(
      inbox.run({ connectionId: c.id, eventId: event.id }, 'retry-stand-in'),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(await eventOf(c.id, reply.webhookId)).toMatchObject({ status: 'received', attempts: 1 });
    expect(await health(c.id)).toEqual({ health: 'degraded', health_reason: 'READS_FAILING' });
    await inbox.run({ connectionId: c.id, eventId: event.id }, 'retry-stand-in');
    expect(await health(c.id)).toEqual({ health: 'ok', health_reason: null });
  });

  it('sets health failing APP_NOT_INSTALLED on app/uninstalled', async () => {
    const c = await plant();
    const reply = await deliver(c, 'app/uninstalled', {
      id: 1,
      name: 'Fixture Store',
      email: 'owner@example.com',
      domain: c.shopDomain,
    });
    expect(reply.status).toBe(200);
    expect(await settled(c.id, reply.webhookId)).toMatchObject({
      status: 'processed',
      payload: { topic: 'app/uninstalled', id: null, updatedAt: null },
    });
    expect(await health(c.id)).toEqual({ health: 'failing', health_reason: 'APP_NOT_INSTALLED' });
  });

  it('sets PROTECTED_DATA_MISSING when the connect check saw no order and the first order lacks ship to data', async () => {
    const c = await plant();
    await api.owner.pool.query(
      `INSERT INTO connection_sync_runs (connection_id, kind, status, finished_at, counts)
       VALUES ($1::uuid, 'connect', 'succeeded', now(), '{"latestOrderChecked": false}')`,
      [c.id],
    );
    useShopifyScenarios('order-protected-data-missing');
    const reply = await deliver(c, 'orders/create', orderBody('gid://shopify/Order/5550000013001'));
    expect((await settled(c.id, reply.webhookId)).status).toBe('processed');
    expect(await health(c.id)).toEqual({
      health: 'degraded',
      health_reason: 'PROTECTED_DATA_MISSING',
    });
    // The tracer's connection had no such connect run: still ok.
    expect(await health(a.id)).toEqual({ health: 'ok', health_reason: null });
  });

  it('records a verified topic milestone 1 does not process, sending no job', async () => {
    const reply = await deliver(a, 'products/update', {
      id: 7770000000101,
      admin_graphql_api_id: 'gid://shopify/Product/7770000000101',
      title: 'Fixture Basic Tee',
      updated_at: '2026-11-02T09:00:00Z',
    });
    expect(reply.status).toBe(200);
    const event = await eventOf(a.id, reply.webhookId);
    expect(event).toMatchObject({
      status: 'received',
      payload: {
        topic: 'products/update',
        id: 'gid://shopify/Product/7770000000101',
        updatedAt: '2026-11-02T09:00:00.000Z',
      },
    });
    expect(
      await count(`SELECT count(*) AS n FROM pgboss.job WHERE data->>'eventId' = $1`, [event.id]),
    ).toBe(0);
  });

  it('keeps every inbox payload free of personal data and the secret out of every log line and row', async () => {
    const payloads = (
      await api.owner.pool.query<{ text: string }>(
        'SELECT payload::text AS text, subject_label FROM inbound_events',
      )
    ).rows.map((row) => row.text);
    expect(payloads.length).toBeGreaterThan(10);
    const inbox = payloads.join('\n');
    expect(inbox).not.toMatch(/(\+?20|0)1[0-9]{9}/);
    for (const personal of [
      FIXTURE_NAME,
      FIXTURE_ADDRESS,
      'maha.fixture',
      'Fixture Basic Tee',
      'fixture note',
    ]) {
      expect(inbox.includes(personal), personal).toBe(false);
    }

    const texts = async (query: string) =>
      (await api.owner.pool.query<{ text: string }>(query)).rows.map((row) => row.text).join('\n');
    const places = {
      logs: logLines.join('\n'),
      inbox: await texts('SELECT row_to_json(e)::text AS text FROM inbound_events e'),
      mappings: await texts('SELECT row_to_json(m)::text AS text FROM connection_external_ids m'),
      jobs: await texts(
        `SELECT row_to_json(j)::text AS text FROM pgboss.job j WHERE name = 'connector-shopify'`,
      ),
      connections: await texts(
        `SELECT (to_jsonb(c) - 'credentials_ciphertext')::text AS text FROM connections c`,
      ),
    };
    // The capture saw the inbox job's own lines, so an empty search would not pass by accident.
    expect(places.logs).toContain('inbox event=');
    for (const [place, text] of Object.entries(places)) {
      expect(text.includes(SENTINEL_SECRET), `secret in ${place}`).toBe(false);
      expect(text.includes('fixture-access-token-not-real'), `token in ${place}`).toBe(false);
      expect(text.includes(FIXTURE_NAME), `name in ${place}`).toBe(false);
      expect(text.includes(FIXTURE_PHONE), `phone in ${place}`).toBe(false);
    }
  });
});
