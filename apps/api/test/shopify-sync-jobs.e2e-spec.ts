import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  ConnectionFreshnessResponse,
  SkuDetail,
  SyncRunListResponse,
  SyncRunStarted,
} from '@ssdashboard/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENV } from '../src/config/config.module.js';
import { loadEnv } from '../src/config/env.js';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { GoLiveClock } from '../src/connectors/connections/go-live-clock.js';
import { InboxPurgeJob } from '../src/connectors/inbox/inbox-purge.job.js';
import { ConnectorBudget } from '../src/connectors/shopify/connector-budget.js';
import { ConnectorClock } from '../src/connectors/shopify/connector-clock.js';
import {
  BACKFILL_JOB_PRIORITY,
  CONNECTOR_SHOPIFY_QUEUE,
  INBOX_JOB_PRIORITY,
} from '../src/connectors/shopify/connector-shopify.queue.js';
import { HourlyCheckJob } from '../src/connectors/shopify/hourly-check.job.js';
import { SWEEP_RETRY_DAYS, SweepJob } from '../src/connectors/shopify/sweep.job.js';
import { JobSender } from '../src/platform/jobs/job-sender.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import {
  readShopifyFixture,
  remainingShopifyExchanges,
  useShopifyScenarios,
} from './shopify-fixture-fetch.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0015 task 12 (AC-3, AC-6, AC-8, AC-17, AC-18; *Critical test scenarios* "Go live and
// backfill", "Sweep and freshness", "Scopes over time", "Inbox privacy", "Failed reads"): the real
// api in process and the real worker (its connector-shopify jobs run by pg-boss) against the
// synthetic fixtures (to be replaced by recordings, task 1) through the refusing fetch. The
// worker's `ConnectorClock` is a fixture clock and its `ConnectorBudget` is shrunk where a test
// needs a chunk to stop. Each test plants its own store, so the fixtures' names never collide.

// Load the root .env before the api saves the environment (the worker reads it after).
devDatabaseUrl();

/** The worker's `PUBLIC_URL`: https, so the hourly check may register webhook addresses. */
const HOOK_ORIGIN = 'https://erp.fixture.example';

/** The connection id the hourly check fixtures carry in place of the planted one. */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-00000000c0de';

/** The go live instant of the backfill fixtures (they read from 60 days before it). */
const GO_LIVE = '2026-11-05T08:00:00Z';

const COD = 'Cash on Delivery (COD)';
const CARD = 'Fixture Card Gateway';
const VARIANT_M = 'gid://shopify/ProductVariant/7770000000101';
const VARIANT_L = 'gid://shopify/ProductVariant/7770000000102';

/** The fixture clock the worker's jobs judge time by. */
class FixtureClock extends ConnectorClock {
  at = new Date('2026-11-05T09:00:00Z');

  override now(): Date {
    return new Date(this.at);
  }
}

interface Planted {
  id: string;
  storeId: string;
}

interface PlantOptions {
  config?: Record<string, unknown>;
  status?: string;
  health?: string;
  healthReason?: string | null;
  goLiveAt?: string | null;
  ordersSweptThrough?: string | null;
  productsSweptThrough?: string | null;
  /** Minutes ago of the last successful orders sweep, or null for none. */
  lastSweepMinutesAgo?: number | null;
  /** No keys: the jobs skip it as `CONNECTION_INCOMPLETE`. */
  incomplete?: boolean;
}

const gid = (n: number) => `gid://shopify/Order/555000${n}001`;

describe('Shopify sweeps, backfill, and checks (spec 0015 task 12)', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let worker: TestingModule;
  let refusingFetch: typeof fetch;
  let manager = '';
  let support = '';
  let current = '';
  const clock = new FixtureClock();
  const budget = new ConnectorBudget();
  const registrations: unknown[] = [];

  const plant = async (options: PlantOptions = {}): Promise<Planted> => {
    const t = randomUUID().slice(0, 8);
    const code = `SJ${t.toUpperCase()}`;
    const id = randomUUID();
    const store = await api.owner.pool.query<{ id: string }>(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ($1, '{"en":"Sync store"}', '{"en":"Sync Essentials","ar":"أساسيات المزامنة"}',
               'shopify') RETURNING id`,
      [code],
    );
    const storeId = store.rows[0]?.id as string;
    await api.owner.pool.query(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ($1, '{"en":"Sync store"}', 'shopify', $2::uuid)`,
      [code, storeId],
    );
    const sealed = api.app
      .get(ConnectionSecrets)
      .seal({ kind: 'client_credentials', clientId: `client-${t}-WXYZ`, clientSecret: 'x' }, id);
    const config = options.config ?? {
      appOwner: 'organization',
      gatewayMethods: { [COD]: 'cod' },
    };
    await api.owner.pool.query(
      `INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                credentials_ciphertext, credentials_key_version, credentials_hint,
                                credentials_updated_at, config, health, health_reason, go_live_at,
                                orders_swept_through, products_swept_through, last_sweep_at)
       VALUES ($1::uuid, 'shopify', 'Sync store', $2::uuid, $3, $4, $5, $6,
               CASE WHEN $5::bytea IS NULL THEN NULL ELSE 'WXYZ' END,
               CASE WHEN $5::bytea IS NULL THEN NULL ELSE now() END, $7::jsonb, $8, $9,
               $10::timestamptz, $11::timestamptz, $12::timestamptz,
               CASE WHEN $13::int IS NULL THEN NULL ELSE now() - make_interval(mins => $13::int) END)`,
      [
        id,
        storeId,
        options.status ?? 'active',
        `syncfx-${t}.myshopify.com`,
        options.incomplete ? null : sealed.ciphertext,
        options.incomplete ? null : sealed.keyVersion,
        JSON.stringify(config),
        options.health ?? 'ok',
        options.healthReason ?? null,
        options.goLiveAt ?? null,
        options.ordersSweptThrough ?? null,
        options.productsSweptThrough ?? null,
        options.lastSweepMinutesAgo ?? null,
      ],
    );
    current = id;
    return { id, storeId };
  };

  const sku = async (code: string): Promise<string> => {
    const reply = await api.call(manager, 'POST', '/api/products', {
      name: { en: `Tee ${code}` },
      variants: [{ sku: code, price: '450.00' }],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return SkuDetail.parse(reply.body).id;
  };

  const mapVariant = async (c: Planted, variantGid: string, variantId: string) => {
    await api.owner.pool.query(
      `INSERT INTO connection_external_ids (connection_id, entity, external_id, local_id)
       VALUES ($1::uuid, 'variant', $2, $3::uuid)`,
      [c.id, variantGid, variantId],
    );
  };

  const orderOf = async (c: Planted, ref: string) =>
    (
      await api.owner.pool.query<{
        id: string;
        order_number: string;
        fulfillment_state: string;
      }>(
        `SELECT id, order_number, fulfillment_state FROM orders
         WHERE store_id = $1::uuid AND channel_order_ref = $2`,
        [c.storeId, ref],
      )
    ).rows[0];

  const fulfillmentEvents = async (orderId: string) =>
    (
      await api.owner.pool.query<{ to_state: string; actor_type: string; reason_code: string }>(
        `SELECT to_state, actor_type, reason_code FROM order_events
         WHERE order_id = $1::uuid AND machine = 'fulfillment' ORDER BY recorded_at, id`,
        [orderId],
      )
    ).rows;

  /** Today's operating day by the database clock, as the sweep puts it in a retry key. */
  const operatingDay = async (): Promise<string> =>
    (await api.owner.pool.query<{ day: string }>(`SELECT ssd_operating_day(now())::text AS day`))
      .rows[0]?.day as string;

  /**
   * Pins where now falls in the operating day: moves the day's start (the cutoff hour) so now is
   * `hoursIn` whole hours, plus the minutes past the hour, into today, and returns the restore.
   * The sweep counts retries per operating day by the database's real now(), which the test clock
   * does not move, so a test that plants history hours back must pin it (CI run 43644216582 ran
   * nine minutes after Cairo midnight and saw yesterday's retries as another day's).
   */
  const pinOperatingDay = async (hoursIn: number): Promise<() => Promise<void>> => {
    const { rows } = await api.owner.pool.query<{ hour: number; cutoff: unknown }>(
      `SELECT extract(hour FROM now() AT TIME ZONE coalesce(
                (SELECT value #>> '{}' FROM settings WHERE key = 'timezone'), 'Africa/Cairo'))::int AS hour,
              (SELECT value FROM settings WHERE key = 'operating_day_cutoff_hour') AS cutoff`,
    );
    const { hour, cutoff } = rows[0] as { hour: number; cutoff: unknown };
    const write = (value: unknown) =>
      value === null || value === undefined
        ? api.owner.pool.query(`DELETE FROM settings WHERE key = 'operating_day_cutoff_hour'`)
        : api.owner.pool.query(
            `INSERT INTO settings (key, value) VALUES ('operating_day_cutoff_hour', $1::jsonb)
             ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [JSON.stringify(value)],
          );
    await write((hour - hoursIn + 24) % 24);
    return async () => {
      await write(cutoff);
    };
  };

  const runsOf = async (c: Planted, kind: string) =>
    (
      await api.owner.pool.query<{
        id: string;
        status: string;
        counts: Record<string, unknown>;
        cursor: string | null;
        error_code: string | null;
        finished_at: Date | null;
      }>(
        `SELECT id, status, counts, cursor, error_code, finished_at FROM connection_sync_runs
         WHERE connection_id = $1::uuid AND kind = $2::sync_run_kind ORDER BY started_at, id`,
        [c.id, kind],
      )
    ).rows;

  const finished = (c: Planted, kind: string, what: string) =>
    eventually(
      async () => {
        const run = (await runsOf(c, kind)).at(-1);
        return run?.finished_at ? run : undefined;
      },
      { timeoutMs: 120_000, what },
    );

  const connectionRow = async (c: Planted) =>
    (
      await api.owner.pool.query<{
        health: string;
        health_reason: string | null;
        go_live_at: Date | null;
        orders_swept_through: Date | null;
        products_swept_through: Date | null;
        last_sweep_at: Date | null;
      }>(
        `SELECT health, health_reason, go_live_at, orders_swept_through, products_swept_through,
                last_sweep_at
         FROM connections WHERE id = $1::uuid`,
        [c.id],
      )
    ).rows[0];

  const eventsOf = async (c: Planted, subject: string) =>
    (
      await api.owner.pool.query<{
        id: string;
        source: string;
        status: string;
        dedupe_key: string;
        subject_external_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, source, status, dedupe_key, subject_external_id, payload FROM inbound_events
         WHERE connection_id = $1::uuid AND subject_type = $2::inbound_subject
         ORDER BY received_at, id`,
        [c.id, subject],
      )
    ).rows;

  /** Inserts an inbox row as a webhook (or a sweep retry) left it, for the sweep tests. */
  const inboxRow = async (
    c: Planted,
    row: {
      gidValue: string;
      status: string;
      dedupe?: string;
      source?: string;
      minutesAgo?: number;
      daysAgo?: number;
      attempts?: number;
      topic?: string;
      subject?: string;
    },
  ) => {
    const { rows } = await api.owner.pool.query<{ id: string }>(
      `INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                   subject_external_id, subject_version, payload, status,
                                   failure_code, attempts, received_at, processed_at)
       VALUES ($1::uuid, $2::inbound_source, $9, $3, $10::inbound_subject, $4,
               '2026-11-05T09:00:00Z', '{}'::jsonb, $5::inbound_status,
               CASE WHEN $5 = 'failed' THEN 'CONTRACT_REFUSED' ELSE NULL END, $6,
               now() - make_interval(mins => $7::int, days => $8::int),
               CASE WHEN $5 = 'received' THEN NULL
                    ELSE now() - make_interval(mins => $7::int, days => $8::int) END)
       RETURNING id`,
      [
        c.id,
        row.source ?? 'webhook',
        row.dedupe ?? randomUUID(),
        row.gidValue,
        row.status,
        row.attempts ?? 0,
        row.minutesAgo ?? 0,
        row.daysAgo ?? 0,
        row.topic ?? 'orders/create',
        row.subject ?? 'order',
      ],
    );
    return rows[0]?.id as string;
  };

  /** Plants a succeeded gateway scan with the given counts. */
  const scanned = async (c: Planted, counts: Record<string, unknown>) =>
    api.owner.pool.query(
      `INSERT INTO connection_sync_runs (connection_id, kind, status, counts, finished_at)
       VALUES ($1::uuid, 'gateway_scan', 'succeeded', $2::jsonb, now())`,
      [c.id, JSON.stringify(counts)],
    );

  beforeAll(async () => {
    // The go live window (D11) is judged by the fixtures' instant, not the machine's clock.
    api = await startInProcessApi((builder) => {
      builder
        .overrideProvider(GoLiveClock)
        .useValue({ now: async () => Promise.resolve(new Date('2026-11-05T09:00:00Z')) });
    });
    budget.bulkPollSeconds = 0;
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ENV)
      .useValue({ ...loadEnv(), PUBLIC_URL: HOOK_ORIGIN })
      .overrideProvider(ConnectorClock)
      .useValue(clock)
      .overrideProvider(ConnectorBudget)
      .useValue(budget)
      .compile();
    await worker.init();

    // The token exchange is answered from the recorded `connect-ok` grant. The planted
    // connection's id goes out as the fixtures' placeholder and comes back in its place (only the
    // hourly check sends it, in a webhook address); every request goes to the refusing fetch.
    refusingFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return refusingFetch(input, init);
      }
      if (url.pathname === '/admin/oauth/access_token') {
        const grant = readShopifyFixture('connect-ok/01-access-token.json').response;
        return new Response(JSON.stringify(grant.body), {
          status: grant.status,
          headers: grant.headers,
        });
      }
      let sent = init;
      if (current && typeof init?.body === 'string' && init.body.includes(current)) {
        const parsed = JSON.parse(init.body) as { operationName?: string; variables?: unknown };
        if (parsed.operationName === 'WebhookSubscriptionCreate')
          registrations.push(parsed.variables);
        sent = { ...init, body: init.body.replaceAll(current, PLACEHOLDER_ID) };
      }
      const answer = await refusingFetch(input, sent);
      if (answer.status === 204) return answer;
      const text = await answer.text();
      return new Response(current ? text.replaceAll(PLACEHOLDER_ID, current) : text, {
        status: answer.status,
        headers: answer.headers,
      });
    };

    const boss = await api.addPerson(['manager']);
    manager = await api.signIn(boss.email);
    const agent = await api.addPerson(['support']);
    support = await api.signIn(agent.email);
  }, 180_000);

  afterAll(async () => {
    if (refusingFetch) globalThis.fetch = refusingFetch;
    await worker?.close();
    await api?.close();
  });

  describe('go live and backfill (AC-17)', () => {
    it('refuses the backfill with GATEWAYS_UNMAPPED until every scanned gateway is mapped, then imports from the go live instant in resumable chunks', async () => {
      clock.at = new Date('2026-11-05T09:00:00Z');
      const c = await plant();
      const skuM = await sku(`SJM-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, VARIANT_M, skuM);

      // No scan yet.
      const early = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: GO_LIVE,
      });
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: 'GATEWAYS_UNMAPPED', gateways: [] });

      // The gateway scan: a bulk read of 60 days by the fixture clock, polled, streamed.
      useShopifyScenarios('gateway-scan-two-gateways');
      const scan = await api.call(manager, 'POST', `/api/connections/${c.id}/gateway-scan`);
      expect(scan.status, JSON.stringify(scan.body)).toBe(202);
      const scanRunId = SyncRunStarted.parse(scan.body).runId;
      const again = await api.call(manager, 'POST', `/api/connections/${c.id}/gateway-scan`);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'SCAN_RUNNING' });
      const scanRun = await finished(c, 'gateway_scan', 'the gateway scan');
      expect(scanRun).toMatchObject({ id: scanRunId, status: 'succeeded', cursor: null });
      expect(scanRun.counts).toMatchObject({
        orders: 3,
        gatewayNames: [COD, CARD],
        gatewayNamesTruncated: false,
        since: '2026-09-06T09:00:00Z',
      });
      // Security review L7: the scan's start is audited with its run id.
      const scanAudit = await api.owner.pool.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_entries
         WHERE action = 'connection.gateway_scan_started' AND record_id = $1::uuid`,
        [c.id],
      );
      expect(scanAudit.rows).toEqual([{ after: { runId: scanRunId } }]);

      const unmapped = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: GO_LIVE,
      });
      expect(unmapped.status).toBe(409);
      expect(unmapped.body).toMatchObject({ code: 'GATEWAYS_UNMAPPED', gateways: [CARD] });
      expect((await connectionRow(c))?.go_live_at).toBeNull();

      await api.owner.pool.query(
        `UPDATE connections SET config = jsonb_set(config, '{gatewayMethods}', $2::jsonb)
         WHERE id = $1::uuid`,
        [c.id, JSON.stringify({ [COD]: 'cod', [CARD]: 'gateway' })],
      );

      // A webhook of #1033 received while the backfill runs: the bulk snapshot may predate it, so
      // the backfill never coalesces it (code review minor); it keeps waiting for its own job.
      const duringBackfill = await inboxRow(c, { gidValue: gid(1033), status: 'received' });

      // A zero time budget: every orders chunk stops after one order and the next resumes on the
      // line after it (4 orders, 4 chunks: each reads the operation and the file once).
      budget.chunkMillis = 0;
      try {
        useShopifyScenarios('backfill-go-live');
        const started = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
          goLiveAt: GO_LIVE,
        });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const productsRunId = SyncRunStarted.parse(started.body).runId;
        const twice = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
          goLiveAt: GO_LIVE,
        });
        expect(twice.status).toBe(409);
        expect(twice.body).toMatchObject({ code: 'BACKFILL_RUNNING' });

        const orders = await finished(c, 'backfill_orders', 'the orders backfill');
        expect(orders.status).toBe('succeeded');
        expect(orders.counts).toMatchObject({
          objects: 4,
          applied: 4,
          failed: 0,
          mode: 'bulk',
          rereadsQueued: 2,
        });
        const products = (await runsOf(c, 'backfill_products'))[0];
        expect(products).toMatchObject({ id: productsRunId, status: 'succeeded' });
        // Task 8: the product is applied from the bulk line (its SKU is not the mapped one's).
        expect(products?.counts).toMatchObject({ objects: 1, recorded: 1, applied: 1, failed: 0 });
      } finally {
        budget.chunkMillis = 60_000;
      }
      // Lead decision D12: the two imported orders still open (#1031 confirmed, #1032 new) are
      // read back once, which nets their sales history; the closed ones (#1033, #1034) never.
      const rereads = await eventually(
        async () => {
          const { rows } = await api.owner.pool.query<{
            subject_external_id: string;
            status: string;
            outcome: string | null;
          }>(
            `SELECT subject_external_id, status, outcome FROM inbound_events
             WHERE connection_id = $1::uuid AND dedupe_key LIKE 'backfill-reread:%'
             ORDER BY subject_external_id`,
            [c.id],
          );
          return rows.length === 2 && rows.every((r) => r.status !== 'received') ? rows : undefined;
        },
        { timeoutMs: 60_000, what: 'the budgeted read backs' },
      );
      expect(rereads).toEqual([
        { subject_external_id: gid(1031), status: 'processed', outcome: 'history_netted' },
        { subject_external_id: gid(1032), status: 'processed', outcome: 'history_netted' },
      ]);
      const unread = await api.owner.pool.query<{ external_id: string }>(
        `SELECT external_id FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'order'
           AND state->>'salesHistoryTruncated' = 'true' ORDER BY external_id`,
        [c.id],
      );
      expect(unread.rows.map((r) => r.external_id)).toEqual([gid(1033), gid(1034)]);
      expect(remainingShopifyExchanges()).toEqual([]);
      const webhook = await api.owner.pool.query<{ status: string }>(
        `SELECT status FROM inbound_events WHERE id = $1::uuid`,
        [duringBackfill],
      );
      expect(webhook.rows[0]?.status).toBe('received');

      // Open, placed 07:30, before go live: confirmed by system_job with go_live_import.
      const open = await orderOf(c, gid(1031));
      expect(open).toMatchObject({ order_number: '#1031', fulfillment_state: 'confirmed' });
      expect(await fulfillmentEvents(open?.id as string)).toEqual([
        { to_state: 'confirmed', actor_type: 'system_job', reason_code: 'go_live_import' },
      ]);
      // Placed 08:30, after go live: a live new order.
      expect(await orderOf(c, gid(1032))).toMatchObject({ fulfillment_state: 'new' });
      // Closed before go live: their found states, by the import actor.
      const cancelled = await orderOf(c, gid(1033));
      expect(cancelled?.fulfillment_state).toBe('cancelled');
      const shipped = await orderOf(c, gid(1034));
      expect(shipped?.fulfillment_state).toBe('shipped');
      expect((await fulfillmentEvents(shipped?.id as string))[0]?.actor_type).toBe('import');
      // Fulfilled in Shopify before go live: no shipment posted, nothing in the stock ledger.
      const movements = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM stock_movements WHERE variant_id = $1::uuid`,
        [skuM],
      );
      expect(Number(movements.rows[0]?.n)).toBe(0);

      // Security review L4: the backfilled orders' system_job actor is the backfill.
      const actors = await api.owner.pool.query<{ actor_ref: string | null }>(
        `SELECT DISTINCT a.actor_ref FROM audit_entries a
         WHERE a.actor_kind = 'system_job' AND a.record_id = ANY($1::uuid[])`,
        [[open?.id, (await orderOf(c, gid(1032)))?.id]],
      );
      for (const row of actors.rows) {
        expect(row.actor_ref ?? '').not.toContain('connectors.shopify.inbox');
      }

      // One inbox row per order, never two, each minimized; the product applied in the run.
      const orderEvents = (await eventsOf(c, 'order')).filter((e) =>
        e.dedupe_key.startsWith('backfill:'),
      );
      expect(orderEvents.map((e) => e.subject_external_id).sort()).toEqual(
        [gid(1031), gid(1032), gid(1033), gid(1034)].sort(),
      );
      for (const event of orderEvents) {
        expect(event).toMatchObject({ source: 'backfill', status: 'processed' });
        expect(Object.keys(event.payload).sort()).toEqual(['id', 'topic', 'updatedAt']);
      }
      const productEvents = await eventsOf(c, 'product');
      expect(productEvents).toEqual([
        expect.objectContaining({
          source: 'backfill',
          status: 'processed',
          subject_external_id: 'gid://shopify/Product/2220000031001',
        }),
      ]);
      // The mapped variant keeps its mapping: its catalog SKU differs from Shopify's.
      const variantMapping = await api.owner.pool.query<{ local_id: string; state: unknown }>(
        `SELECT local_id, state FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'variant' AND external_id = $2`,
        [c.id, VARIANT_M],
      );
      expect(variantMapping.rows[0]).toMatchObject({
        local_id: skuM,
        state: {
          lastOutcome: 'sku_mismatch',
          inventoryItemId: 'gid://shopify/InventoryItem/2230000031001',
        },
      });

      // The sweeps take over from the backfill; the result address is stored nowhere.
      const row = await connectionRow(c);
      expect(row?.go_live_at?.toISOString()).toBe('2026-11-05T08:00:00.000Z');
      expect(row?.orders_swept_through).not.toBeNull();
      expect(row?.products_swept_through).not.toBeNull();
      expect(row?.last_sweep_at).not.toBeNull();
      // Code review minor: the last order is the newest order's creation, never the clock.
      const lastOrder = await api.owner.pool.query<{ last_order_at: Date | null }>(
        `SELECT last_order_at FROM connections WHERE id = $1::uuid`,
        [c.id],
      );
      expect(lastOrder.rows[0]?.last_order_at?.toISOString()).toBe('2026-11-05T08:30:00.000Z');
      const stored = await api.owner.pool.query<{ text: string }>(
        `SELECT coalesce(string_agg(row_to_json(r)::text, ''), '') AS text
         FROM connection_sync_runs r WHERE connection_id = $1::uuid`,
        [c.id],
      );
      expect(stored.rows[0]?.text).not.toContain('storage.fixture.example');

      // The audit entry of the start: the go live instant and the products run, no credential.
      const audit = await api.owner.pool.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_entries
         WHERE action = 'connection.backfill_started' AND record_id = $1::uuid`,
        [c.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.after).toMatchObject({ goLiveAt: GO_LIVE, resumed: false });

      // Lead decision D11: the go live instant is set once; another one is refused.
      const moved = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: '2026-11-05T08:30:00Z',
      });
      expect(moved.status).toBe(409);
      expect(moved.body).toMatchObject({ code: 'GO_LIVE_ALREADY_SET' });
      expect((await connectionRow(c))?.go_live_at?.toISOString()).toBe('2026-11-05T08:00:00.000Z');

      // The runs list, newest first, a page at a time.
      const first = await api.call(manager, 'GET', `/api/connections/${c.id}/sync-runs?limit=1`);
      expect(first.status).toBe(200);
      const page1 = SyncRunListResponse.parse(first.body);
      expect(page1.items.map((run) => run.kind)).toEqual(['backfill_orders']);
      expect(page1.nextCursor).not.toBeNull();
      const rest = await api.call(
        manager,
        'GET',
        `/api/connections/${c.id}/sync-runs?cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
      );
      const page2 = SyncRunListResponse.parse(rest.body);
      expect(page2.items.map((run) => run.kind)).toEqual(['backfill_products', 'gateway_scan']);
      expect(JSON.stringify([page1, page2])).not.toContain('movedAt');
      expect(page2.items[1]?.counts['gatewayNames']).toEqual([COD, CARD]);
      expect(JSON.stringify([page1, page2])).not.toContain('bulkId');
    });

    it('falls back to paged reads of one order when Shopify refuses the bulk selection', async () => {
      const c = await plant();
      const skuM = await sku(`SJP-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, VARIANT_M, skuM);
      await scanned(c, { orders: 2, gatewayNames: [COD] });
      budget.chunkMillis = 0;
      try {
        useShopifyScenarios('backfill-paged-fallback');
        const started = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
          goLiveAt: GO_LIVE,
        });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const orders = await finished(c, 'backfill_orders', 'the paged backfill');
        expect(orders.status).toBe('succeeded');
        expect(orders.counts).toMatchObject({
          mode: 'paged',
          bulkRefusedCodes: ['INVALID'],
          objects: 2,
          applied: 2,
        });
      } finally {
        budget.chunkMillis = 60_000;
      }
      expect(remainingShopifyExchanges()).toEqual([]);
      expect(await orderOf(c, gid(1035))).toMatchObject({ fulfillment_state: 'new' });
      expect(await orderOf(c, gid(1036))).toMatchObject({ fulfillment_state: 'confirmed' });
      expect((await eventsOf(c, 'order')).map((e) => e.status)).toEqual(['processed', 'processed']);
    });

    it('refuses a backfill of a paused connection with CONNECTION_PAUSED and a failing one with CONNECTION_NOT_READY (QA 3)', async () => {
      const c = await plant({ status: 'paused' });
      const reply = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: GO_LIVE,
      });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'CONNECTION_PAUSED' });
      const failing = await plant({ health: 'failing', healthReason: 'CREDENTIALS_REJECTED' });
      const refused = await api.call(manager, 'POST', `/api/connections/${failing.id}/backfill`, {
        goLiveAt: GO_LIVE,
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'CONNECTION_NOT_READY' });
      const bad = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: 'soon',
      });
      expect(bad.status).toBe(422);
      expect(bad.body).toMatchObject({ code: 'INVALID_BODY' });
    });

    it('refuses a first go live instant more than 5 minutes ahead or 60 days back of the database clock (D11)', async () => {
      const c = await plant();
      await scanned(c, { orders: 1, gatewayNames: [COD] });
      for (const goLiveAt of ['2026-11-05T09:05:01Z', '2026-09-06T08:59:59Z']) {
        const reply = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
          goLiveAt,
        });
        expect(reply.status, goLiveAt).toBe(422);
        expect(reply.body).toMatchObject({ code: 'GO_LIVE_OUT_OF_RANGE' });
      }
      expect((await connectionRow(c))?.go_live_at).toBeNull();
      expect(await runsOf(c, 'backfill_products')).toEqual([]);
    });

    it('refuses the backfill with GATEWAYS_TOO_MANY while the newest scan dropped names (security review L3)', async () => {
      const c = await plant();
      await scanned(c, { orders: 500, gatewayNames: [COD], gatewayNamesTruncated: true });
      const reply = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: GO_LIVE,
      });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'GATEWAYS_TOO_MANY' });
      expect((await connectionRow(c))?.go_live_at).toBeNull();
    });

    it('resumes a failed paged orders backfill from its recorded page with the same go live instant (D11, AC-17)', async () => {
      const c = await plant({ goLiveAt: GO_LIVE });
      const skuM = await sku(`SJU-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, VARIANT_M, skuM);
      await scanned(c, { orders: 2, gatewayNames: [COD] });
      const position = {
        step: 3,
        bulkId: null,
        line: 0,
        mode: 'paged',
        after: 'fixture-cursor-1047',
        since: null,
      };
      const failed = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO connection_sync_runs (connection_id, kind, status, cursor, counts,
                                           finished_at, error_code)
         VALUES ($1::uuid, 'backfill_orders', 'failed', $2, $3::jsonb, now(),
                 'CONNECTION_NOT_LIVE')
         RETURNING id`,
        [
          c.id,
          JSON.stringify(position),
          JSON.stringify({ goLiveAt: GO_LIVE, objects: 1, applied: 1, mode: 'paged' }),
        ],
      );
      const runId = failed.rows[0]?.id as string;
      useShopifyScenarios('backfill-resume-paged');
      const resumed = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
        goLiveAt: GO_LIVE,
      });
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(202);
      expect(SyncRunStarted.parse(resumed.body).runId).toBe(runId);
      const run = await finished(c, 'backfill_orders', 'the resumed backfill');
      expect(run).toMatchObject({ id: runId, status: 'succeeded', error_code: null });
      expect(run.counts).toMatchObject({ objects: 2, applied: 2, mode: 'paged' });
      expect(await orderOf(c, 'gid://shopify/Order/5550001048001')).toMatchObject({
        order_number: '#1048',
        fulfillment_state: 'confirmed',
      });
      expect(await runsOf(c, 'backfill_products')).toEqual([]);
      expect(remainingShopifyExchanges()).toEqual([]);
      const audit = await api.owner.pool.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_entries
         WHERE action = 'connection.backfill_started' AND record_id = $1::uuid`,
        [c.id],
      );
      expect(audit.rows.map((r) => r.after)).toEqual([{ goLiveAt: GO_LIVE, runId, resumed: true }]);
    });

    it('ends a stalled gateway scan RUN_STALLED and starts a new one instead of answering SCAN_RUNNING forever (code review Major 3)', async () => {
      clock.at = new Date('2026-11-05T09:00:00Z');
      const c = await plant();
      const fresh = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO connection_sync_runs (connection_id, kind, status, started_at)
         VALUES ($1::uuid, 'gateway_scan', 'running', now() - interval '1 hour') RETURNING id`,
        [c.id],
      );
      const busy = await api.call(manager, 'POST', `/api/connections/${c.id}/gateway-scan`);
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ code: 'SCAN_RUNNING' });
      await api.owner.pool.query(
        `UPDATE connection_sync_runs SET started_at = now() - interval '7 hours'
         WHERE id = $1::uuid`,
        [fresh.rows[0]?.id],
      );
      useShopifyScenarios('gateway-scan-two-gateways');
      const scan = await api.call(manager, 'POST', `/api/connections/${c.id}/gateway-scan`);
      expect(scan.status, JSON.stringify(scan.body)).toBe(202);
      const done = await finished(c, 'gateway_scan', 'the new gateway scan');
      expect(done).toMatchObject({
        id: SyncRunStarted.parse(scan.body).runId,
        status: 'succeeded',
      });
      const runs = await runsOf(c, 'gateway_scan');
      expect(runs.find((r) => r.id === fresh.rows[0]?.id)).toMatchObject({
        status: 'failed',
        error_code: 'RUN_STALLED',
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });
  });

  describe('sweeps (AC-8, AC-18)', () => {
    // The operating day pin of the test that set one (`pinOperatingDay`), undone after it.
    let restoreDay: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await restoreDay?.();
      restoreDay = undefined;
    });

    it('applies an order changed at 10:00 with no webhook through the 10:05 sweep, well before 10:15', async () => {
      clock.at = new Date('2026-11-05T10:05:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T09:55:00Z',
        lastSweepMinutesAgo: 10,
        health: 'degraded',
        healthReason: 'SWEEP_LATE',
      });
      const skuM = await sku(`SJS-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, VARIANT_M, skuM);
      useShopifyScenarios('sweep-order-updated');

      const outcome = await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
      expect(outcome).toEqual({ status: 'succeeded', found: 1, recorded: 1 });
      const order = await eventually(async () => orderOf(c, gid(1037)), {
        timeoutMs: 60_000,
        what: 'the swept order',
      });
      expect(order.order_number).toBe('#1037');
      expect(clock.now().getTime()).toBeLessThan(Date.parse('2026-11-05T10:15:00Z'));
      const [event] = await eventsOf(c, 'order');
      expect(event).toMatchObject({
        source: 'sweep',
        dedupe_key: `sweep:${gid(1037)}:2026-11-05T10:00:00.000Z`,
      });
      await eventually(
        async () => ((await eventsOf(c, 'order'))[0]?.status === 'processed' ? true : undefined),
        { what: 'the sweep row to be processed' },
      );
      const [run] = await runsOf(c, 'sweep_orders');
      expect(run).toMatchObject({ status: 'succeeded' });
      const row = await connectionRow(c);
      expect(row?.orders_swept_through?.toISOString()).toBe('2026-11-05T10:00:00.000Z');
      expect(row).toMatchObject({ health: 'ok', health_reason: null });
      expect(remainingShopifyExchanges()).toEqual([]);

      // Read again later with nothing new: no second row for the same version.
      const seen = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM inbound_events WHERE connection_id = $1::uuid`,
        [c.id],
      );
      expect(Number(seen.rows[0]?.n)).toBe(1);
    });

    it('records a found product with its inbox job, which reads it back and applies it (task 8)', async () => {
      clock.at = new Date('2026-11-05T10:00:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T09:55:00Z',
        productsSweptThrough: '2026-11-05T09:30:00Z',
      });
      useShopifyScenarios('sweep-products-updated');
      const outcome = await worker.get(SweepJob).sweep('products', { connectionId: c.id });
      expect(outcome).toEqual({ status: 'succeeded', found: 1, recorded: 1 });
      const event = await eventually(
        async () => {
          const [row] = await eventsOf(c, 'product');
          return row && row.status !== 'received' ? row : undefined;
        },
        { timeoutMs: 60_000, what: 'the swept product to be applied' },
      );
      expect(event).toMatchObject({ source: 'sweep', status: 'processed' });
      const mapped = await api.owner.pool.query<{ entity: string; local_id: string | null }>(
        `SELECT entity, local_id FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity IN ('product', 'variant') ORDER BY entity`,
        [c.id],
      );
      expect(mapped.rows.map((row) => [row.entity, row.local_id !== null])).toEqual([
        ['product', true],
        ['variant', true],
      ]);
      expect((await connectionRow(c))?.products_swept_through?.toISOString()).toBe(
        '2026-11-05T09:40:00.000Z',
      );
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('adds a sweep retry row for an order whose latest event failed, at most 3 a day, and sends a stranded received event again (AC-8)', async () => {
      // Its planted history goes back 200 minutes and must all be today's (CI run 43644216582).
      restoreDay = await pinOperatingDay(6);
      clock.at = new Date('2026-11-05T12:05:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T12:00:00Z',
        lastSweepMinutesAgo: 5,
      });
      const skuM = await sku(`SJR-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, VARIANT_M, skuM);
      // #1038: its webhook event failed 90 minutes ago (a rule fixed since).
      const failed1038 = await inboxRow(c, {
        gidValue: gid(1038),
        status: 'failed',
        minutesAgo: 90,
      });
      // Code review minor: the n-th retry waits n hours after the previous attempt. #1052 failed
      // 30 minutes ago (retry 1 waits an hour); #1053 failed its first retry 90 minutes ago
      // (retry 2 waits two hours). Neither is retried by this sweep.
      await inboxRow(c, { gidValue: gid(1052), status: 'failed', minutesAgo: 30 });
      await inboxRow(c, { gidValue: gid(1053), status: 'failed', minutesAgo: 200 });
      await inboxRow(c, {
        gidValue: gid(1053),
        status: 'failed',
        source: 'sweep',
        dedupe: `sweep-retry:${gid(1053)}:2026-11-05T09:00:00.000Z:1`,
        minutesAgo: 90,
      });
      // #1039: its webhook event was recorded 20 minutes ago and its job was lost.
      await inboxRow(c, { gidValue: gid(1039), status: 'received', minutesAgo: 20 });
      // #1040: already retried 3 times today, each failing.
      const capped = gid(1040);
      await inboxRow(c, { gidValue: capped, status: 'failed', minutesAgo: 50 });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await inboxRow(c, {
          gidValue: capped,
          status: 'failed',
          source: 'sweep',
          dedupe: `sweep-retry:${capped}:2026-11-05T09:00:00.000Z:${attempt}`,
          minutesAgo: 40 - attempt,
        });
      }
      useShopifyScenarios('sweep-retry-and-resend');

      const outcome = await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
      expect(outcome).toMatchObject({ status: 'succeeded', found: 0 });
      const [run] = await runsOf(c, 'sweep_orders');
      expect(run?.counts).toMatchObject({ retried: 1, resent: 1 });

      const retries = await api.owner.pool.query<{
        subject_external_id: string;
        dedupe_key: string;
      }>(
        `SELECT subject_external_id, dedupe_key FROM inbound_events
         WHERE connection_id = $1::uuid AND dedupe_key LIKE 'sweep-retry:%'
           AND subject_external_id = $2`,
        [c.id, gid(1038)],
      );
      expect(retries.rows).toEqual([
        {
          subject_external_id: gid(1038),
          dedupe_key: `sweep-retry:${await operatingDay()}:1:${failed1038}`,
        },
      ]);
      const cappedRows = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM inbound_events
         WHERE connection_id = $1::uuid AND subject_external_id = $2`,
        [c.id, capped],
      );
      expect(Number(cappedRows.rows[0]?.n)).toBe(4);
      const spaced = await api.owner.pool.query<{ subject_external_id: string; n: string }>(
        `SELECT subject_external_id, count(*) AS n FROM inbound_events
         WHERE connection_id = $1::uuid AND subject_external_id = ANY($2::text[])
         GROUP BY subject_external_id ORDER BY subject_external_id`,
        [c.id, [gid(1052), gid(1053)]],
      );
      expect(spaced.rows.map((r) => [r.subject_external_id, Number(r.n)])).toEqual([
        [gid(1052), 1],
        [gid(1053), 2],
      ]);

      await eventually(async () => orderOf(c, gid(1038)), {
        timeoutMs: 60_000,
        what: 'the retried order',
      });
      await eventually(async () => orderOf(c, gid(1039)), {
        timeoutMs: 60_000,
        what: 'the resent order',
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('retries a failed order again on the next operating day after its 3 retries of the day before (code review: the day is in the retry key)', async () => {
      clock.at = new Date('2026-11-05T12:05:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T12:00:00Z',
        lastSweepMinutesAgo: 5,
      });
      // #1059: refused (say GATEWAY_UNMAPPED) a day ago, then retried 3 times that day, each
      // failing, with the keys the sweep wrote before the day was in them; the gateway is mapped
      // since. Before the fix today's first retry reused yesterday's `:1` key and was a no-op.
      const stuck = gid(1059);
      await inboxRow(c, { gidValue: stuck, status: 'failed', daysAgo: 1, minutesAgo: 30 });
      let lastFailed = '';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        lastFailed = await inboxRow(c, {
          gidValue: stuck,
          status: 'failed',
          source: 'sweep',
          dedupe: `sweep-retry:${stuck}:2026-11-05T09:00:00.000Z:${attempt}`,
          daysAgo: 1,
          minutesAgo: 20 - attempt,
        });
      }
      useShopifyScenarios('sweep-retry-and-resend');
      // The retry's own inbox job is not run here: only the row the sweep records is checked.
      const jobs = worker.get(JobSender);
      const spy = vi.spyOn(jobs, 'sendIn').mockResolvedValue('recorded');
      try {
        await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
      } finally {
        spy.mockRestore();
      }

      const { rows } = await api.owner.pool.query<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM inbound_events
         WHERE connection_id = $1::uuid AND subject_external_id = $2
           AND ssd_operating_day(received_at) = ssd_operating_day(now())`,
        [c.id, stuck],
      );
      expect(rows).toEqual([{ dedupe_key: `sweep-retry:${await operatingDay()}:1:${lastFailed}` }]);
      expect(rows[0]?.dedupe_key.length).toBeLessThanOrEqual(128);
    });

    it('starts a new day of 3 retries at the operating day boundary: just after it, the retries of the day before no longer count (CI run 43644216582)', async () => {
      // Now is under an hour into today, so retries made 90 minutes ago were yesterday's.
      restoreDay = await pinOperatingDay(0);
      clock.at = new Date('2026-11-05T12:05:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T12:00:00Z',
        lastSweepMinutesAgo: 5,
      });
      const value = gid(1063);
      await inboxRow(c, { gidValue: value, status: 'failed', minutesAgo: 200 });
      let lastFailed = '';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        lastFailed = await inboxRow(c, {
          gidValue: value,
          status: 'failed',
          source: 'sweep',
          dedupe: `sweep-retry:yesterday:${attempt}:${randomUUID()}`,
          minutesAgo: 93 - attempt,
        });
      }
      const yesterday = await api.owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM inbound_events
         WHERE connection_id = $1::uuid AND subject_external_id = $2
           AND ssd_operating_day(received_at) = ssd_operating_day(now()) - 1`,
        [c.id, value],
      );
      expect(Number(yesterday.rows[0]?.n)).toBe(4);
      useShopifyScenarios('sweep-retry-and-resend');
      const jobs = worker.get(JobSender);
      const spy = vi.spyOn(jobs, 'sendIn').mockResolvedValue('recorded');
      try {
        await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
      } finally {
        spy.mockRestore();
      }

      const { rows } = await api.owner.pool.query<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM inbound_events
         WHERE connection_id = $1::uuid AND subject_external_id = $2
           AND ssd_operating_day(received_at) = ssd_operating_day(now())`,
        [c.id, value],
      );
      expect(rows).toEqual([{ dedupe_key: `sweep-retry:${await operatingDay()}:1:${lastFailed}` }]);
    });

    it('retries a failed order on the 7th operating day of its failure run and never on the 8th (review round 2 M1, SWEEP_RETRY_DAYS)', async () => {
      clock.at = new Date('2026-11-05T12:05:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T12:00:00Z',
        lastSweepMinutesAgo: 5,
      });
      expect(SWEEP_RETRY_DAYS).toBe(7);
      /** An order that first failed `daysAgo` days ago and failed every retry since, the last yesterday. */
      const failing = async (n: number, daysAgo: number): Promise<string> => {
        const value = gid(n);
        await inboxRow(c, { gidValue: value, status: 'failed', daysAgo });
        // An older success of the order ends no run: only events after the run's first failure count.
        return inboxRow(c, {
          gidValue: value,
          status: 'failed',
          source: 'sweep',
          dedupe: `sweep-retry:old:${randomUUID()}`,
          daysAgo: 1,
        });
      };
      const day7 = await failing(1060, 6);
      await failing(1061, 7);
      // #1062 failed 10 days ago, then a newer Shopify update applied (`processed`), then failed
      // again 2 days ago: a new failure run, still retried.
      const renewed = gid(1062);
      await inboxRow(c, { gidValue: renewed, status: 'failed', daysAgo: 10 });
      await inboxRow(c, { gidValue: renewed, status: 'processed', daysAgo: 9 });
      const renewedFailed = await inboxRow(c, { gidValue: renewed, status: 'failed', daysAgo: 2 });
      useShopifyScenarios('sweep-retry-and-resend');
      const jobs = worker.get(JobSender);
      const spy = vi.spyOn(jobs, 'sendIn').mockResolvedValue('recorded');
      try {
        await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
      } finally {
        spy.mockRestore();
      }

      const { rows } = await api.owner.pool.query<{ gid: string; dedupe_key: string }>(
        `SELECT subject_external_id AS gid, dedupe_key FROM inbound_events
         WHERE connection_id = $1::uuid AND ssd_operating_day(received_at) = ssd_operating_day(now())
           AND left(dedupe_key, 12) = 'sweep-retry:'
         ORDER BY subject_external_id`,
        [c.id],
      );
      const today = await operatingDay();
      expect(rows).toEqual([
        { gid: gid(1060), dedupe_key: `sweep-retry:${today}:1:${day7}` },
        { gid: renewed, dedupe_key: `sweep-retry:${today}:1:${renewedFailed}` },
      ]);
    });

    it('never resends a D12 re-read at webhook priority: not at 15 minutes, only past 4 hours and at the backfill priority (F2, M-R1)', async () => {
      clock.at = new Date('2026-11-05T12:05:00Z');
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T12:00:00Z',
        lastSweepMinutesAgo: 5,
      });
      const reread = (n: number, minutesAgo: number) =>
        inboxRow(c, {
          gidValue: gid(n),
          status: 'received',
          source: 'backfill',
          topic: 'orders/updated',
          dedupe: `backfill-reread:${gid(n)}`,
          minutesAgo,
        });
      // 40 minutes old: past the 15 minute rule, and still no resend. 5 hours old: resent, low.
      const recent = await reread(1054, 40);
      const old = await reread(1055, 300);
      const webhook = await inboxRow(c, {
        gidValue: gid(1056),
        status: 'received',
        minutesAgo: 20,
      });
      useShopifyScenarios('sweep-retry-and-resend');
      const jobs = worker.get(JobSender);
      const sent: { eventId: string; priority: number | undefined }[] = [];
      const spy = vi.spyOn(jobs, 'send').mockImplementation((_queue, data, options) => {
        const payload = data as { eventId?: string };
        sent.push({ eventId: payload.eventId ?? '', priority: options?.priority });
        return Promise.resolve('recorded');
      });
      try {
        await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
      } finally {
        spy.mockRestore();
      }
      const resent = sent.filter((job) => [recent, old, webhook].includes(job.eventId));
      expect(resent.sort((a, b) => a.eventId.localeCompare(b.eventId))).toEqual(
        [
          { eventId: webhook, priority: INBOX_JOB_PRIORITY },
          { eventId: old, priority: BACKFILL_JOB_PRIORITY },
        ].sort((a, b) => a.eventId.localeCompare(b.eventId)),
      );
      expect(sent.some((job) => job.eventId === recent)).toBe(false);
    });

    it('marks a live connection whose last sweep is 16 minutes old SWEEP_LATE on the tick', async () => {
      await api.owner.pool.query(
        `UPDATE connections SET status = 'paused' WHERE status = 'active'`,
      );
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        ordersSweptThrough: '2026-11-05T09:00:00Z',
        lastSweepMinutesAgo: 16,
        // No keys: the sweep job the tick sends skips it (CONNECTION_INCOMPLETE).
        incomplete: true,
      });
      expect(await worker.get(SweepJob).tick('orders')).toEqual({ connections: 1 });
      expect(await connectionRow(c)).toMatchObject({
        health: 'degraded',
        health_reason: 'SWEEP_LATE',
      });
    });
  });

  describe('freshness (AC-8, AC-18)', () => {
    it('answers every active connection to a hat with orders.view: late at 16 minutes, fresh at 14, failing, and the failed counts', async () => {
      const late = await plant({
        ordersSweptThrough: '2026-11-05T09:00:00Z',
        lastSweepMinutesAgo: 16,
      });
      const fresh = await plant({
        ordersSweptThrough: '2026-11-05T09:00:00Z',
        lastSweepMinutesAgo: 14,
      });
      const failing = await plant({
        ordersSweptThrough: '2026-11-05T09:00:00Z',
        lastSweepMinutesAgo: 1,
        health: 'failing',
        healthReason: 'CREDENTIALS_REJECTED',
      });
      const settingUp = await plant();
      // Two failed events of one order count once; an order applied after its failure not at all.
      await inboxRow(fresh, { gidValue: gid(1041), status: 'failed', minutesAgo: 10 });
      await inboxRow(fresh, { gidValue: gid(1041), status: 'failed', minutesAgo: 5 });
      await inboxRow(fresh, { gidValue: gid(1042), status: 'failed', minutesAgo: 10 });
      await inboxRow(fresh, { gidValue: gid(1042), status: 'processed', minutesAgo: 2 });
      await api.owner.pool.query(
        `INSERT INTO outbound_commands (connection_id, kind, linked_type, linked_id, payload,
                                        idempotency_key, sync_state, failure_reason, attempts)
         VALUES ($1::uuid, 'fixture_write', 'connection', $1::uuid, '{}'::jsonb, $2, 'failed',
                 'FIXTURE_REFUSED', 3)`,
        [fresh.id, randomUUID()],
      );

      const reply = await api.call(support, 'GET', '/api/connections/freshness');
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const answer = ConnectionFreshnessResponse.parse(reply.body);
      const item = (c: Planted) => answer.items.find((i) => i.connectionId === c.id);
      expect(item(late)).toMatchObject({ state: 'late', failedOrderEvents: 0, failedCommands: 0 });
      expect(item(fresh)).toMatchObject({
        state: 'fresh',
        failedOrderEvents: 1,
        failedCommands: 1,
        storePublicName: { en: 'Sync Essentials', ar: 'أساسيات المزامنة' },
        lastOrderAt: null,
      });
      expect(item(fresh)?.lastSweepAt).not.toBeNull();
      expect(item(failing)).toMatchObject({ state: 'failing' });
      expect(item(settingUp)).toMatchObject({ state: 'fresh', lastSweepAt: null });
      const lag = Date.parse(answer.asOf) - Date.parse(item(late)?.lastSweepAt ?? '');
      expect(lag).toBeGreaterThanOrEqual(16 * 60_000);
      expect(JSON.stringify(answer)).not.toMatch(/WXYZ|syncfx-|client-/);

      const paused = await plant({ status: 'paused' });
      const again = ConnectionFreshnessResponse.parse(
        (await api.call(support, 'GET', '/api/connections/freshness')).body,
      );
      expect(again.items.some((i) => i.connectionId === paused.id)).toBe(false);
    });
  });

  describe('the hourly check (AC-3, AC-12, AC-18)', () => {
    it('subscribes a topic Shopify removed again, never deleting another app subscription', async () => {
      const c = await plant({ goLiveAt: '2026-11-01T00:00:00Z' });
      registrations.length = 0;
      useShopifyScenarios('hourly-check-subscription-missing');
      const outcome = await worker.get(HourlyCheckJob).check(c.id, randomUUID());
      expect(outcome).toMatchObject({ status: 'succeeded', missingScopes: [], created: 1 });
      expect(registrations).toEqual([
        {
          topic: 'ORDERS_UPDATED',
          webhookSubscription: { uri: `${HOOK_ORIGIN}/api/hooks/shopify/${c.id}`, format: 'JSON' },
        },
      ]);
      expect(remainingShopifyExchanges()).toEqual([]);
      const [run] = await runsOf(c, 'hourly_check');
      expect(run).toMatchObject({ status: 'succeeded' });
      expect(run?.counts).toMatchObject({ webhookTopicsCreated: 1, webhooksRefused: false });
      expect(await connectionRow(c)).toMatchObject({ health: 'ok' });
    });

    it('sets SCOPES_MISSING with the handles a release needs and the shop no longer grants', async () => {
      const c = await plant({ goLiveAt: '2026-11-01T00:00:00Z' });
      useShopifyScenarios('hourly-check-scope-missing');
      const outcome = await worker.get(HourlyCheckJob).check(c.id, randomUUID());
      expect(outcome).toMatchObject({ status: 'succeeded', missingScopes: ['write_inventory'] });
      expect(await connectionRow(c)).toMatchObject({
        health: 'degraded',
        health_reason: 'SCOPES_MISSING',
      });
      const [run] = await runsOf(c, 'hourly_check');
      expect(run?.counts).toMatchObject({ missingScopes: ['write_inventory'] });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('QA 4: sets SCOPES_MISSING in a run that clears WEBHOOKS_MISSING, never leaving health ok', async () => {
      const c = await plant({
        goLiveAt: '2026-11-01T00:00:00Z',
        health: 'degraded',
        healthReason: 'WEBHOOKS_MISSING',
      });
      useShopifyScenarios('hourly-check-scope-missing');
      const outcome = await worker.get(HourlyCheckJob).check(c.id, randomUUID());
      expect(outcome).toMatchObject({ status: 'succeeded', missingScopes: ['write_inventory'] });
      expect(await connectionRow(c)).toMatchObject({
        health: 'degraded',
        health_reason: 'SCOPES_MISSING',
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('creates the waiting replacement order once the original is delivered (AC-12)', async () => {
      useShopifyScenarios('order-exchange-added-lines');
      const c = await plant({
        goLiveAt: null,
        config: {
          appOwner: 'organization',
          altPhoneAttribute: 'alt_phone',
          gatewayMethods: { [COD]: 'cod', manual: 'cod' },
        },
      });
      const skuL = await sku(`SJW-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, VARIANT_L, skuL);
      const order = 'gid://shopify/Order/5550000008001';
      // The order and its exchange edit arrive while the original is not yet delivered.
      for (const [topic, updatedAt] of [
        ['orders/create', '2026-11-04T10:00:01Z'],
        ['orders/edited', '2026-11-07T15:05:00Z'],
      ] as const) {
        const eventId = await api.owner.pool
          .query<{ id: string }>(
            `INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                         subject_external_id, subject_version, payload)
             VALUES ($1::uuid, 'webhook', $2, $3, 'order', $4, $5::timestamptz, '{}'::jsonb)
             RETURNING id`,
            [c.id, topic, randomUUID(), order, updatedAt],
          )
          .then((r) => r.rows[0]?.id as string);
        const jobs = worker.get(JobSender);
        await jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
        await jobs.send(CONNECTOR_SHOPIFY_QUEUE, { kind: 'inbox', connectionId: c.id, eventId });
        await eventually(
          async () => {
            const { rows } = await api.owner.pool.query<{ status: string }>(
              `SELECT status FROM inbound_events WHERE id = $1::uuid`,
              [eventId],
            );
            return rows[0]?.status === 'received' ? undefined : rows[0]?.status;
          },
          { timeoutMs: 60_000, what: `${topic} to settle` },
        );
      }
      const original = await orderOf(c, order);
      const mapping = await api.owner.pool.query<{ state: Record<string, unknown> }>(
        `SELECT state FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
        [c.id, order],
      );
      expect(mapping.rows[0]?.state['pendingReplacementLines']).toBeDefined();

      // The hourly check before delivery: still waiting.
      useShopifyScenarios('hourly-check-ok', 'hourly-check-ok');
      const before = await worker.get(HourlyCheckJob).check(c.id, randomUUID());
      expect(before).toMatchObject({ status: 'succeeded', replacementsCreated: 0 });
      expect(await orderOf(c, `${order}:R1`)).toBeUndefined();

      await api.owner.pool.query(
        `UPDATE orders SET fulfillment_state = 'delivered' WHERE id = $1::uuid`,
        [original?.id],
      );
      const after = await worker.get(HourlyCheckJob).check(c.id, randomUUID());
      expect(after).toMatchObject({ status: 'succeeded', created: 0, replacementsCreated: 1 });
      const replacement = await orderOf(c, `${order}:R1`);
      expect(replacement).toMatchObject({ order_number: '#1009-R1' });
      const events = await api.owner.pool.query<{ actor_type: string }>(
        `SELECT DISTINCT actor_type FROM order_events WHERE order_id = $1::uuid`,
        [replacement?.id],
      );
      expect(events.rows).toEqual([{ actor_type: 'system_job' }]);
      const runs = await runsOf(c, 'hourly_check');
      expect(runs.map((r) => r.counts['replacementsCreated'])).toEqual([0, 1]);
      expect(remainingShopifyExchanges()).toEqual([]);
    });
  });

  describe('inbox privacy (AC-6)', () => {
    it('purges a processed row aged 91 days and a failed one aged 181, keeping a failed one aged 100 and every received one', async () => {
      const c = await plant();
      const processedOld = await inboxRow(c, {
        gidValue: gid(1043),
        status: 'processed',
        daysAgo: 91,
      });
      const processedRecent = await inboxRow(c, {
        gidValue: gid(1043),
        status: 'processed',
        daysAgo: 89,
      });
      const failedKept = await inboxRow(c, { gidValue: gid(1044), status: 'failed', daysAgo: 100 });
      const failedOld = await inboxRow(c, { gidValue: gid(1045), status: 'failed', daysAgo: 181 });
      const receivedOld = await inboxRow(c, {
        gidValue: gid(1046),
        status: 'received',
        daysAgo: 200,
      });
      const run = async (daysAgo: number) =>
        (
          await api.owner.pool.query<{ id: string }>(
            `INSERT INTO connection_sync_runs (connection_id, kind, status, counts, started_at,
                                               finished_at)
             VALUES ($1::uuid, 'sweep_orders', 'succeeded', '{}'::jsonb,
                     now() - make_interval(days => $2::int), now() - make_interval(days => $2::int))
             RETURNING id`,
            [c.id, daysAgo],
          )
        ).rows[0]?.id as string;
      const oldRun = await run(120);
      const newestOldRun = await run(95);

      const outcome = await worker.get(InboxPurgeJob).run();
      expect(outcome.inboundEvents).toBeGreaterThanOrEqual(1);
      expect(outcome.failedInboundEvents).toBeGreaterThanOrEqual(1);

      const left = await api.owner.pool.query<{ id: string }>(
        `SELECT id FROM inbound_events WHERE connection_id = $1::uuid`,
        [c.id],
      );
      expect(left.rows.map((r) => r.id).sort()).toEqual(
        [processedRecent, failedKept, receivedOld].sort(),
      );
      expect(left.rows.map((r) => r.id)).not.toContain(processedOld);
      expect(left.rows.map((r) => r.id)).not.toContain(failedOld);
      const runs = await api.owner.pool.query<{ id: string }>(
        `SELECT id FROM connection_sync_runs WHERE connection_id = $1::uuid`,
        [c.id],
      );
      // The newest finished run of a kind is kept, however old: the screen's last check.
      expect(runs.rows.map((r) => r.id)).toEqual([newestOldRun]);
      expect(runs.rows.map((r) => r.id)).not.toContain(oldRun);
    });

    it('purges a failed row past 90 days once a newer event of its order did not fail, received rows of unprocessed topics past 90 days except product rows, and unfinished runs past 90 days unless they moved lately (code review minor, security review L5, D13, F2)', async () => {
      const c = await plant();
      const superseded = await inboxRow(c, { gidValue: gid(1054), status: 'failed', daysAgo: 95 });
      const newer = await inboxRow(c, { gidValue: gid(1054), status: 'processed', daysAgo: 92 });
      const alone = await inboxRow(c, { gidValue: gid(1055), status: 'failed', daysAgo: 95 });
      const product = await inboxRow(c, {
        gidValue: 'gid://shopify/Product/2220001056001',
        status: 'received',
        daysAgo: 91,
        topic: 'products/update',
        subject: 'product',
      });
      const recentProduct = await inboxRow(c, {
        gidValue: 'gid://shopify/Product/2220001057001',
        status: 'received',
        daysAgo: 30,
        topic: 'products/update',
        subject: 'product',
      });
      const refund = await inboxRow(c, {
        gidValue: gid(1056),
        status: 'received',
        daysAgo: 91,
        topic: 'refunds/create',
      });
      const waitingOrder = await inboxRow(c, {
        gidValue: gid(1057),
        status: 'received',
        daysAgo: 120,
      });
      const stuck = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO connection_sync_runs (connection_id, kind, status, started_at)
         VALUES ($1::uuid, 'backfill_orders', 'running', now() - interval '100 days')
         RETURNING id`,
        [c.id],
      );
      // F2 (m-R1): a backfill started 100 days ago but resumed an hour ago is still running.
      const resumed = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO connection_sync_runs (connection_id, kind, status, started_at, cursor)
         VALUES ($1::uuid, 'backfill_products', 'running', now() - interval '100 days',
                 jsonb_build_object('movedAt', now() - interval '1 hour')::text)
         RETURNING id`,
        [c.id],
      );
      const kept = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO connection_sync_runs (connection_id, kind, status, started_at, finished_at)
         VALUES ($1::uuid, 'backfill_orders', 'succeeded', now() - interval '120 days',
                 now() - interval '120 days')
         RETURNING id`,
        [c.id],
      );

      const outcome = await worker.get(InboxPurgeJob).run();
      expect(outcome.unprocessedInboundEvents).toBeGreaterThanOrEqual(1);
      const left = (
        await api.owner.pool.query<{ id: string }>(
          `SELECT id FROM inbound_events WHERE connection_id = $1::uuid`,
          [c.id],
        )
      ).rows.map((r) => r.id);
      // F2 (m-R2): a received product row is kept until task 8 reads it, however old.
      expect(left.sort()).toEqual([alone, product, recentProduct, waitingOrder].sort());
      for (const gone of [superseded, newer, refund]) expect(left).not.toContain(gone);
      const runs = (
        await api.owner.pool.query<{ id: string }>(
          `SELECT id FROM connection_sync_runs WHERE connection_id = $1::uuid`,
          [c.id],
        )
      ).rows.map((r) => r.id);
      // The newest finished run of a kind stays, however old; the stuck unfinished one goes.
      expect(runs.sort()).toEqual([kept.rows[0]?.id, resumed.rows[0]?.id].sort());
      expect(runs).not.toContain(stuck.rows[0]?.id);
    });

    it('QA: keeps rows 1 hour short of 90 and 180 days and purges them 1 hour past, for every closed status', async () => {
      const c = await plant();
      const ids = {
        processedKept: await inboxRow(c, {
          gidValue: gid(1047),
          status: 'processed',
          daysAgo: 89,
          minutesAgo: 23 * 60,
        }),
        processedGone: await inboxRow(c, {
          gidValue: gid(1047),
          status: 'processed',
          daysAgo: 90,
          minutesAgo: 60,
        }),
        ignoredGone: await inboxRow(c, { gidValue: gid(1048), status: 'ignored', daysAgo: 91 }),
        unlicensedGone: await inboxRow(c, {
          gidValue: gid(1048),
          status: 'ignored_unlicensed',
          daysAgo: 91,
        }),
        echoGone: await inboxRow(c, { gidValue: gid(1049), status: 'echo', daysAgo: 91 }),
        // Its own order: a newer row of the same order that did not fail would supersede it.
        failedKept: await inboxRow(c, {
          gidValue: gid(1058),
          status: 'failed',
          daysAgo: 179,
          minutesAgo: 23 * 60,
        }),
        failedGone: await inboxRow(c, {
          gidValue: gid(1050),
          status: 'failed',
          daysAgo: 180,
          minutesAgo: 60,
        }),
      };
      await worker.get(InboxPurgeJob).run();
      const left = (
        await api.owner.pool.query<{ id: string }>(
          `SELECT id FROM inbound_events WHERE connection_id = $1::uuid`,
          [c.id],
        )
      ).rows.map((r) => r.id);
      expect(left.sort()).toEqual([ids.processedKept, ids.failedKept].sort());
    });

    it('QA: a paused or archived connection is never swept, checked, or backfilled, and starts no run', async () => {
      for (const status of ['paused', 'archived']) {
        const c = await plant({
          status,
          goLiveAt: '2026-11-01T00:00:00Z',
          ordersSweptThrough: '2026-11-05T08:00:00Z',
          productsSweptThrough: '2026-11-05T08:00:00Z',
        });
        const swept = await worker.get(SweepJob).sweep('orders', { connectionId: c.id });
        expect(swept, status).toHaveProperty('skipped');
        const checked = await worker.get(HourlyCheckJob).check(c.id, randomUUID());
        expect(checked, status).toHaveProperty('skipped');
        expect(await runsOf(c, 'sweep_orders'), status).toEqual([]);
        expect(await runsOf(c, 'hourly_check'), status).toEqual([]);
        // QA 3: a paused connection's scan and backfill are refused at the route with
        // CONNECTION_PAUSED; an archived one's with CONNECTION_ARCHIVED and CONNECTION_NOT_READY.
        const scan = await api.call(manager, 'POST', `/api/connections/${c.id}/gateway-scan`);
        expect(scan.status, status).toBe(409);
        expect(scan.body, status).toMatchObject({
          code: status === 'paused' ? 'CONNECTION_PAUSED' : 'CONNECTION_ARCHIVED',
        });
        expect(await runsOf(c, 'gateway_scan'), status).toEqual([]);
        const fill = await api.call(manager, 'POST', `/api/connections/${c.id}/backfill`, {
          goLiveAt: GO_LIVE,
        });
        expect(fill.status, status).toBe(409);
        expect(fill.body, status).toMatchObject({
          code: status === 'paused' ? 'CONNECTION_PAUSED' : 'CONNECTION_NOT_READY',
        });
      }
    });
  });
});
