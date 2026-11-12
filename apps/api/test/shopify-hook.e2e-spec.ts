import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import type { LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { OrderListResponse } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { InboundEventFailed } from '../src/connectors/connectors.events.js';
import { HOOK_BODY_LIMIT_BYTES } from '../src/connectors/hooks/mount-hooks.js';
import { ConnectorClock } from '../src/connectors/shopify/connector-clock.js';
import { CONNECTOR_SHOPIFY_RETRY } from '../src/connectors/shopify/connector-shopify.queue.js';
import { InboxJob } from '../src/connectors/shopify/inbox.job.js';
import { ShopifyClient } from '../src/connectors/shopify/shopify-client.js';
import { OrderIntake } from '../src/orders/intake/order-intake.service.js';
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

// A key rotation in progress (AC-2, code review m9a): both processes hold this as
// CONNECTOR_SECRET_KEY_PREVIOUS, so a connection sealed under it still verifies. A test key only.
const PREVIOUS_KEY = randomBytes(32).toString('base64');
process.env['CONNECTOR_SECRET_KEY_PREVIOUS'] = PREVIOUS_KEY;

/** The worker's clock (`ConnectorClock`): a test moves it instead of backdating rows. */
const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };

/** Three hours and a minute: past the READS_FAILING rule. */
const PAST_THREE_HOURS_MS = (3 * 60 + 1) * 60_000;

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
    options: {
      status?: string;
      health?: string;
      health_reason?: string | null;
      config?: string;
      sealWith?: ConnectionSecrets;
    } = {},
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
    const sealer: ConnectionSecrets = options.sealWith ?? api.app.get(ConnectionSecrets);
    const sealed = sealer.seal(
      { kind: 'client_credentials', clientId: `client-${t}-WXYZ`, clientSecret: SENTINEL_SECRET },
      id,
    );
    await api.owner.pool.query(
      `INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                credentials_ciphertext, credentials_key_version, credentials_hint,
                                credentials_updated_at, config, health, health_reason)
       VALUES ($1::uuid, 'shopify', 'Hook store', $2::uuid, $3, $4, $5, $6, 'WXYZ', now(),
               $9::jsonb, $7, $8)`,
      [
        id,
        storeId,
        options.status ?? 'active',
        shopDomain,
        sealed.ciphertext,
        sealed.keyVersion,
        options.health ?? 'ok',
        options.health_reason ?? null,
        options.config ?? '{"appOwner":"organization","altPhoneAttribute":"alt_phone"}',
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
      shop?: string | null;
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
      'x-shopify-webhook-id': webhookId,
      'x-shopify-api-version': '2026-10',
      'x-shopify-triggered-at': new Date().toISOString(),
    };
    if (options.shop !== null) {
      headers['x-shopify-shop-domain'] = options.shop ?? connection.shopDomain;
    }
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

  const eventById = async (id: string): Promise<EventRow> => {
    const { rows } = await api.owner.pool.query<EventRow>(
      `SELECT id, status, outcome, failure_code, attempts, subject_label, subject_external_id,
              payload
       FROM inbound_events WHERE id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error('no inbox row with that id');
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

  const warnings = async (id: string) =>
    (
      await api.owner.pool.query<{ health_warnings: string[] }>(
        'SELECT health_warnings FROM connections WHERE id = $1::uuid',
        [id],
      )
    ).rows[0]?.health_warnings;

  /** Waits until every pg-boss job of these events completed. */
  const jobsCompleted = (eventIds: string[]) =>
    eventually(
      async () =>
        (await count(
          `SELECT count(*) AS n FROM pgboss.job
           WHERE name = 'connector-shopify' AND data->>'eventId' = ANY($1) AND state = 'completed'`,
          [eventIds],
        )) === eventIds.length
          ? true
          : undefined,
      { timeoutMs: 60_000, what: 'the jobs to complete' },
    );

  /**
   * Plants a paused connection, delivers each topic for `gid` (each job meets the pause and leaves
   * its event received), then turns it active, so the test runs `InboxJob` itself.
   */
  const pausedThenActive = async (gid: string, topics: string[] = ['orders/create']) => {
    const c = await plant({ status: 'paused' });
    const events: EventRow[] = [];
    for (const topic of topics) {
      const reply = await deliver(c, topic, orderBody(gid));
      expect(reply.status).toBe(200);
      events.push(await eventOf(c.id, reply.webhookId));
    }
    await jobsCompleted(events.map((event) => event.id));
    await api.owner.pool.query(`UPDATE connections SET status = 'active' WHERE id = $1::uuid`, [
      c.id,
    ]);
    return { c, events };
  };

  /** What a raw HTTP exchange saw: the status line's code, the body, and who closed. */
  interface RawReply {
    status: number;
    body: string;
    closedByServer: boolean;
    ms: number;
    /** Body bytes written before the exchange ended. */
    sent: number;
  }

  /**
   * One HTTP/1.1 request over a plain socket, so a test controls exactly how many body bytes go
   * out and when (fetch cannot send a short body or keep reading after a reset). `body` is sent
   * at once; `stream` keeps sending chunks until the server answers or closes.
   */
  const rawExchange = (
    path: string,
    headers: Record<string, string>,
    options: { body?: Buffer; stream?: { chunk: Buffer; max: number } } = {},
  ): Promise<RawReply> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const { hostname, port } = new URL(api.base);
      const socket = netConnect({ host: hostname, port: Number(port) });
      const received: Buffer[] = [];
      let answered = false;
      let closedByServer = false;
      let sent = 0;
      const guard = setTimeout(() => {
        socket.destroy();
        reject(new Error('raw exchange timed out'));
      }, 30_000);
      socket.on('data', (data: Buffer) => {
        answered = true;
        received.push(data);
      });
      socket.on('end', () => {
        closedByServer = true;
      });
      // A reset after the answer is the server closing on a sender it refused.
      socket.on('error', () => {
        closedByServer = true;
      });
      socket.on('close', () => {
        clearTimeout(guard);
        const text = Buffer.concat(received).toString('latin1');
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
        const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        resolve({ status, body, closedByServer, ms: Date.now() - started, sent });
      });
      socket.on('connect', () => {
        const head = [
          `POST ${path} HTTP/1.1`,
          `Host: ${hostname}:${port}`,
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          '',
          '',
        ].join('\r\n');
        socket.write(head);
        if (options.body) {
          sent += options.body.length;
          socket.write(options.body);
        }
        const stream = options.stream;
        if (stream) {
          const next = () => {
            if (answered || socket.destroyed || sent >= stream.max) return;
            sent += stream.chunk.length;
            const size = stream.chunk.length.toString(16);
            socket.write(
              Buffer.concat([Buffer.from(`${size}\r\n`), stream.chunk, Buffer.from('\r\n')]),
              () => setImmediate(next),
            );
          };
          next();
        }
      });
    });

  /** The headers of a well formed delivery to `connection`, signed over nothing in particular. */
  const rawHeaders = (connection: { shopDomain: string }, extra: Record<string, string>) => ({
    'Content-Type': 'application/json',
    'X-Shopify-Topic': 'orders/updated',
    'X-Shopify-Shop-Domain': connection.shopDomain,
    'X-Shopify-Hmac-SHA256': 'AAAA',
    'X-Shopify-Webhook-Id': randomUUID(),
    ...extra,
  });

  /** The token exchange answer the stand in gives: a recorded grant or refusal. */
  let tokenFixture = 'connect-ok/01-access-token.json';

  beforeAll(async () => {
    api = await startInProcessApi();
    api.app.useLogger(capture);
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ConnectorClock)
      .useValue(clock)
      .compile();
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
    // `connect-ok` grant (the token is cached per connection, so once per connection), or the
    // recording a test names in `tokenFixture`; every other request goes to the refusing fetch.
    refusingFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/admin/oauth/access_token') {
        const grant = readShopifyFixture(tokenFixture).response;
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
    delete process.env['CONNECTOR_SECRET_KEY_PREVIOUS'];
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
    const jobs = await api.owner.pool.query<{
      data: unknown;
      group_id: string;
      retry_limit: number;
      retry_delay_max: number;
    }>(
      `SELECT data, group_id, retry_limit, retry_delay_max
       FROM pgboss.job WHERE name = 'connector-shopify' AND data->>'eventId' = $1`,
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
    // In its connection's group (group concurrency 1: one job per connection at a time, enforced
    // by pg-boss's fetch across workers) with the 3 h 15 min retry policy (code review M1, m9c).
    expect(jobs.rows[0]).toMatchObject({
      group_id: a.id,
      retry_limit: CONNECTOR_SHOPIFY_RETRY.retryLimit,
      retry_delay_max: CONNECTOR_SHOPIFY_RETRY.retryDelayMax,
    });

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
      // Security M1 and L7, code review m7: decided before any body byte is read.
      await deliver(a, 'orders/updated', body, { shop: null }),
      await deliver(a, 'orders/updated', body, { path: '/api/hooks/shopify/%E0' }),
      await deliver(a, 'orders/updated', body, {
        path: `/api/hooks/Shopify/${a.id}`,
        signature: null,
      }),
      await deliver(a, 'orders/updated', body, {
        path: `/api/hooks/Shopify/${a.id}`,
        tamper: true,
      }),
      await deliver(a, 'orders/updated', body, { path: `/api/hooks/other/${a.id}` }),
      await deliver(a, 'orders/updated', body, { path: `/api/hooks/shopify/${a.id}/extra` }),
    ];
    const read = await fetch(`${api.base}/api/hooks/shopify/${a.id}`, {
      headers: { 'x-shopify-shop-domain': a.shopDomain, 'x-shopify-hmac-sha256': 'AAAA' },
    });
    refusals.push({ status: read.status, text: await read.text(), webhookId: '' });
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

  it('answers 413 to 2 MB and one byte, declared or streamed, and closes the socket without draining, with no row', async () => {
    const before = await count('SELECT count(*) AS n FROM inbound_events');
    const path = `/api/hooks/shopify/${a.id}`;
    // Declared: refused on the header, before a body byte is read (only 10 bytes are sent).
    const declared = await rawExchange(
      path,
      rawHeaders(a, { 'Content-Length': String(HOOK_BODY_LIMIT_BYTES + 1) }),
      { body: Buffer.from('{"id":1234') },
    );
    expect([declared.status, declared.body, declared.closedByServer]).toEqual([413, '', true]);
    // Streamed without a length: refused once the bytes pass the cap, the socket closed while
    // the sender still had more to send.
    const streamed = await rawExchange(path, rawHeaders(a, { 'Transfer-Encoding': 'chunked' }), {
      stream: { chunk: Buffer.alloc(64 * 1024, 0x20), max: HOOK_BODY_LIMIT_BYTES * 4 },
    });
    // The 413 is written, then the socket is shut and destroyed while the sender still pushes
    // bytes, so TCP may reset the connection before the sender reads the answer: either way the
    // server stopped it just past the cap instead of draining everything it would send.
    expect([413, 0]).toContain(streamed.status);
    expect([streamed.body, streamed.closedByServer]).toEqual(['', true]);
    expect(streamed.sent).toBeLessThan(HOOK_BODY_LIMIT_BYTES * 2);
    expect(await count('SELECT count(*) AS n FROM inbound_events')).toBe(before);
  });

  it('refuses an unknown connection before reading the body, and answers 408 to a body slower than 10 seconds', async () => {
    // A declared body that never comes: an unknown connection is refused at once, never waited on.
    const unknown = await rawExchange(
      `/api/hooks/shopify/${randomUUID()}`,
      rawHeaders(a, { 'Content-Length': '1000' }),
    );
    expect([unknown.status, unknown.body, unknown.closedByServer]).toEqual([401, '', true]);
    expect(unknown.ms).toBeLessThan(5_000);

    // A live connection's body that stops arriving: 408 at the deadline, the socket closed.
    const slow = await rawExchange(
      `/api/hooks/shopify/${a.id}`,
      rawHeaders(a, { 'Content-Length': '1000' }),
      { body: Buffer.from('{"id":') },
    );
    expect([slow.status, slow.body, slow.closedByServer]).toEqual([408, '', true]);
    expect(slow.ms).toBeGreaterThanOrEqual(9_500);
  });

  it('verifies a connection sealed under the previous key while CONNECTOR_SECRET_KEY_PREVIOUS is set (AC-2)', async () => {
    const rotating = await plant({
      sealWith: new ConnectionSecrets({ CONNECTOR_SECRET_KEY: PREVIOUS_KEY }),
    });
    const sealedUnder = await api.owner.pool.query<{ version: number }>(
      'SELECT credentials_key_version AS version FROM connections WHERE id = $1::uuid',
      [rotating.id],
    );
    const current = await api.owner.pool.query<{ version: number }>(
      'SELECT credentials_key_version AS version FROM connections WHERE id = $1::uuid',
      [a.id],
    );
    expect(sealedUnder.rows[0]?.version).not.toBe(current.rows[0]?.version);
    const product = {
      id: 7770000000101,
      admin_graphql_api_id: 'gid://shopify/Product/7770000000101',
      updated_at: '2026-11-02T09:00:00Z',
    };
    const reply = await deliver(rotating, 'products/update', product);
    expect(reply.status).toBe(200);
    expect((await eventOf(rotating.id, reply.webhookId)).status).toBe('received');
    const tampered = await deliver(rotating, 'products/update', product, { tamper: true });
    expect([tampered.status, tampered.text]).toEqual([401, '']);
  });

  it('applies the newer snapshot of a known order (task 9 replaced the update_deferred of D1), and records a snapshot not newer as stale', async () => {
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

    // Read back 02: the size swap, newer than the applied version: applied through
    // applyChannelEdit (task 9; shopify-orders-in-full.e2e-spec.ts proves the lines).
    const edited = await deliver(a, 'orders/edited', orderBody(gid, '2026-11-02T11:40:09Z'));
    expect(await settled(a.id, edited.webhookId)).toMatchObject({
      status: 'processed',
      outcome: null,
      subject_label: '#1002',
    });
    const after = await snapshot();
    expect(after).not.toEqual(before);
    expect(after?.version).not.toBe(before?.version);

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

  it('sets READS_FAILING once a failed read has waited three hours by the clock, cleared by the next good read', async () => {
    const gid = 'gid://shopify/Order/5550000010001';
    const { c, events } = await pausedThenActive(gid);
    const event = events[0] as EventRow;
    useShopifyScenarios('order-read-server-error');
    const inbox = worker.get(InboxJob);
    // The clock, not the row, moves: the event was received three hours ago by the worker's clock.
    clock.offsetMs = PAST_THREE_HOURS_MS;
    try {
      await expect(
        inbox.run({ connectionId: c.id, eventId: event.id }, 'retry-stand-in', 3),
      ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    } finally {
      clock.offsetMs = 0;
    }
    expect(await eventById(event.id)).toMatchObject({
      status: 'received',
      attempts: 1,
    });
    expect(await health(c.id)).toEqual({ health: 'degraded', health_reason: 'READS_FAILING' });
    await inbox.run({ connectionId: c.id, eventId: event.id }, 'retry-stand-in', 4);
    expect(await health(c.id)).toEqual({ health: 'ok', health_reason: null });
  });

  it('sets READS_FAILING when the last retry fails, leaving the event received for the sweep', async () => {
    const gid = 'gid://shopify/Order/5550000010001';
    const { c, events } = await pausedThenActive(gid);
    const event = events[0] as EventRow;
    useShopifyScenarios('order-read-server-error');
    // Minutes old by the clock, but pg-boss has no retry left after this one.
    await expect(
      worker
        .get(InboxJob)
        .run(
          { connectionId: c.id, eventId: event.id },
          'last-retry-stand-in',
          CONNECTOR_SHOPIFY_RETRY.retryLimit,
        ),
    ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(await eventById(event.id)).toMatchObject({
      status: 'received',
      attempts: 1,
      failure_code: null,
    });
    expect(await health(c.id)).toEqual({ health: 'degraded', health_reason: 'READS_FAILING' });
  });

  it('confirms app/uninstalled before health turns failing: a refused token exchange confirms it', async () => {
    const c = await plant();
    tokenFixture = 'connect-app-not-installed/01-access-token.json';
    try {
      const reply = await deliver(c, 'app/uninstalled', {
        id: 1,
        name: 'Fixture Store',
        email: 'owner@example.com',
        domain: c.shopDomain,
      });
      expect(reply.status).toBe(200);
      expect(await settled(c.id, reply.webhookId)).toMatchObject({
        status: 'processed',
        outcome: null,
        payload: { topic: 'app/uninstalled', id: null, updatedAt: null },
      });
    } finally {
      tokenFixture = 'connect-ok/01-access-token.json';
    }
    expect(await health(c.id)).toEqual({ health: 'failing', health_reason: 'APP_NOT_INSTALLED' });
  });

  it('records an app/uninstalled that Shopify does not confirm as ignored uninstall_not_confirmed, health unchanged', async () => {
    const c = await plant();
    const reply = await deliver(c, 'app/uninstalled', { id: 1, domain: c.shopDomain });
    expect(reply.status).toBe(200);
    expect(await settled(c.id, reply.webhookId)).toMatchObject({
      status: 'ignored',
      outcome: 'uninstall_not_confirmed',
    });
    expect(await health(c.id)).toEqual({ health: 'ok', health_reason: null });
  });

  it('leaves order events received on a token refusal, the connection carrying the problem', async () => {
    const c = await plant();
    tokenFixture = 'connect-credentials-rejected/01-access-token.json';
    let event: EventRow;
    try {
      const reply = await deliver(
        c,
        'orders/create',
        orderBody('gid://shopify/Order/5550000001001'),
      );
      event = await eventOf(c.id, reply.webhookId);
      await jobsCompleted([event.id]);
    } finally {
      tokenFixture = 'connect-ok/01-access-token.json';
    }
    expect(await eventById(event.id)).toMatchObject({
      status: 'received',
      failure_code: null,
    });
    expect(await health(c.id)).toEqual({
      health: 'failing',
      health_reason: 'CREDENTIALS_REJECTED',
    });
    expect(failedSeen.filter((seen) => seen.eventId === event.id)).toEqual([]);
  });

  it('fails a read back of another order READ_BACK_MISMATCH, writing nothing', async () => {
    const c = await plant();
    useShopifyScenarios('order-read-mismatch');
    const gid = 'gid://shopify/Order/5550000014001';
    const reply = await deliver(c, 'orders/create', orderBody(gid));
    expect(await settled(c.id, reply.webhookId)).toMatchObject({
      status: 'failed',
      failure_code: 'READ_BACK_MISMATCH',
    });
    expect(remainingShopifyExchanges()).toEqual([]);
    expect(
      await count(
        `SELECT count(*) AS n FROM connection_external_ids WHERE connection_id = $1::uuid`,
        [c.id],
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM orders WHERE store_id = $1::uuid', [c.storeId]),
    ).toBe(0);
  });

  it('fails an order event of a connection whose config does not parse CONNECTION_CONFIG_INVALID, reading nothing', async () => {
    const c = await plant({ config: '{"gatewayMethods":"not-a-map"}' });
    const reply = await deliver(c, 'orders/create', orderBody('gid://shopify/Order/5550000001001'));
    expect(await settled(c.id, reply.webhookId)).toMatchObject({
      status: 'failed',
      failure_code: 'CONNECTION_CONFIG_INVALID',
    });
  });

  it('keeps API_VERSION_FELL_FORWARD on the connection while reads answer in another version, and clears it', async () => {
    const c = await plant();
    useShopifyScenarios('order-version-fell-forward');
    const gid = 'gid://shopify/Order/5550000015001';
    const created = await deliver(c, 'orders/create', orderBody(gid));
    expect((await settled(c.id, created.webhookId)).status).toBe('processed');
    expect(await warnings(c.id)).toEqual(['API_VERSION_FELL_FORWARD']);
    const again = await deliver(c, 'orders/updated', orderBody(gid));
    expect(await settled(c.id, again.webhookId)).toMatchObject({ outcome: 'stale' });
    expect(await warnings(c.id)).toEqual([]);
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('leaves the event received when the run crashes after the read back, and the retry creates exactly one order', async () => {
    const gid = 'gid://shopify/Order/5550000001001';
    const { c, events } = await pausedThenActive(gid);
    const event = events[0] as EventRow;
    useShopifyScenarios('order-created-cod', 'order-created-cod');
    const intake = worker.get(OrderIntake);
    const crash = vi
      .spyOn(intake, 'createFromChannel')
      .mockRejectedValueOnce(new Error('crash injected after the read back'));
    const inbox = worker.get(InboxJob);
    try {
      await expect(
        inbox.run({ connectionId: c.id, eventId: event.id }, 'crash-stand-in'),
      ).rejects.toThrow('crash injected after the read back');
    } finally {
      crash.mockRestore();
    }
    expect(await eventById(event.id)).toMatchObject({
      status: 'received',
      failure_code: null,
    });
    expect(
      await count(
        `SELECT count(*) AS n FROM connection_external_ids WHERE connection_id = $1::uuid`,
        [c.id],
      ),
    ).toBe(0);

    expect(await inbox.run({ connectionId: c.id, eventId: event.id }, 'retry-stand-in')).toEqual({
      status: 'processed',
      code: null,
    });
    expect(remainingShopifyExchanges()).toEqual([]);
    expect(
      await count('SELECT count(*) AS n FROM orders WHERE store_id = $1::uuid', [c.storeId]),
    ).toBe(1);
  });

  it('coalesces only events received before the read back started (code review m1)', async () => {
    const gid = 'gid://shopify/Order/5550000001001';
    const { c, events } = await pausedThenActive(gid, ['orders/create', 'orders/updated']);
    const [first, early] = events as [EventRow, EventRow];
    useShopifyScenarios('order-created-cod');
    const shopify = worker.get(ShopifyClient);
    const original = shopify.request.bind(shopify);
    let lateId = '';
    const spy = vi.spyOn(shopify, 'request').mockImplementationOnce(async (access, operation) => {
      // A change Shopify sends while the read back is in flight.
      const late = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                     subject_external_id, payload)
         VALUES ($1::uuid, 'webhook', 'orders/updated', $2, 'order', $3, $4::jsonb)
         RETURNING id`,
        [
          c.id,
          randomUUID(),
          gid,
          JSON.stringify({ topic: 'orders/updated', id: gid, updatedAt: null }),
        ],
      );
      lateId = late.rows[0]?.id ?? '';
      return original(access, operation);
    });
    try {
      expect(
        await worker.get(InboxJob).run({ connectionId: c.id, eventId: first.id }, 'stand-in'),
      ).toEqual({ status: 'processed', code: null });
    } finally {
      spy.mockRestore();
    }
    const statusOf = async (id: string) =>
      (
        await api.owner.pool.query<{ status: string; outcome: string | null }>(
          'SELECT status, outcome FROM inbound_events WHERE id = $1::uuid',
          [id],
        )
      ).rows[0];
    expect(await statusOf(early.id)).toEqual({ status: 'processed', outcome: 'coalesced' });
    expect(await statusOf(lateId)).toEqual({ status: 'received', outcome: null });
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

  it('records a verified topic no job processes yet, sending no job', async () => {
    // Products get their job from task 8; inventory levels wait for milestone 3.
    const reply = await deliver(a, 'inventory_levels/update', {
      inventory_item_id: 2230000031001,
      location_id: 4440000000001,
      available: 3,
      updated_at: '2026-11-02T09:00:00Z',
    });
    expect(reply.status).toBe(200);
    const event = await eventOf(a.id, reply.webhookId);
    expect(event).toMatchObject({
      status: 'received',
      payload: {
        topic: 'inventory_levels/update',
        id: null,
        updatedAt: '2026-11-02T09:00:00.000Z',
        inventoryItemId: '2230000031001',
        locationId: '4440000000001',
        available: 3,
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
