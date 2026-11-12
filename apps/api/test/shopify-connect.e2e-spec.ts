import { randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  ConnectionDetail,
  ConnectionListResponse,
  ConnectShopifyResponse,
  type AppOwner,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../src/config/config.module.js';
import { loadEnv } from '../src/config/env.js';
import { SHOPIFY_WEBHOOK_TOPICS } from '../src/connectors/shopify/shopify-app.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import {
  readShopifyFixture,
  remainingShopifyExchanges,
  useShopifyScenarios,
} from './shopify-fixture-fetch.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0015 task 6 (AC-1, AC-2; *Critical test scenarios* "Connect against fixtures" and
// "Secrets"): a manager connects a Shopify store on `POST /api/connections/shopify`; the api
// writes the store, its channel, the connection, `connection.created`, and the `connect` job in
// one transaction; the worker's connect job, replaying the recorded (synthetic) fixtures through
// the refusing fetch, reads the shop, fills the store's names, registers the 13 webhook
// subscriptions, and sets the health. A sentinel secret is searched in every answer, row, job,
// and log line.

// Load the root .env before the api saves the environment (the worker reads it after).
devDatabaseUrl();

/** The worker's `PUBLIC_URL`: https, so webhook addresses can be registered. */
const HOOK_ORIGIN = 'https://erp.fixture.example';
/** The client secret of every connection here; it must never come back out. */
const SENTINEL_SECRET = `sentinel-secret-${randomUUID()}`;
/** The token every recorded exchange answers; it must never reach a row, an answer, or a log. */
const FIXTURE_TOKEN = 'fixture-access-token-not-real-0001';

/** Every log line written while the suite runs, in either process. */
const logLines: string[] = [];
const capture: LoggerService = {
  log: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  error: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  debug: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  verbose: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
};

/** One webhook registration the connect job asked for. */
interface Registration {
  topic: string;
  uri: string;
}

describe('connecting a Shopify store (spec 0015 task 6, AC-1, AC-2)', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let worker: TestingModule;
  let manager: string;
  let support: string;
  let refusingFetch: typeof fetch;
  const registrations: Registration[] = [];
  const answers: string[] = [];
  let n = 0;

  const unique = () => {
    n += 1;
    return `${n}${randomUUID().slice(0, 6)}`;
  };

  /** A connect body with a fresh store code and shop domain. */
  const body = (overrides: Record<string, unknown> = {}) => {
    const tag = unique();
    return {
      label: `Fixture ${tag}`,
      storeCode: `FX${tag.toUpperCase()}`,
      shopDomain: `fixture-${tag}.myshopify.com`,
      clientId: `client-id-${tag}-ABCD`,
      clientSecret: SENTINEL_SECRET,
      appOwner: 'organization' as AppOwner,
      ...overrides,
    };
  };

  const detail = async (id: string): Promise<ConnectionDetail> => {
    const reply = await api.call(manager, 'GET', `/api/connections/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    answers.push(JSON.stringify(reply.body));
    return ConnectionDetail.parse(reply.body);
  };

  /** Waits until the connect job decided (health no longer `connecting`, the run finished). */
  const settled = (id: string): Promise<ConnectionDetail> =>
    eventually(
      async () => {
        const found = await detail(id);
        return found.health !== 'connecting' && found.lastCheck?.finishedAt ? found : undefined;
      },
      { timeoutMs: 60_000, what: `connection ${id} to settle` },
    );

  /** Connects a store against one recorded scenario and waits for the connect job's verdict. */
  const connect = async (
    scenario: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; body: ReturnType<typeof body>; detail: ConnectionDetail }> => {
    useShopifyScenarios(scenario);
    const sent = body(overrides);
    const reply = await api.call(manager, 'POST', '/api/connections/shopify', sent);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    answers.push(JSON.stringify(reply.body));
    const { id, health } = ConnectShopifyResponse.parse(reply.body);
    expect(health).toBe('connecting');
    return { id, body: sent, detail: await settled(id) };
  };

  const count = async (query: string, values: unknown[]): Promise<number> => {
    const { rows } = await api.owner.pool.query<{ n: string }>(query, values);
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    api.app.useLogger(capture);
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ENV)
      .useValue({ ...loadEnv(), PUBLIC_URL: HOOK_ORIGIN })
      .compile();
    worker.useLogger(capture);
    await worker.init();

    // Webhook registrations carry the new connection's id in their address, which no recording
    // can know: they are answered from the recorded `connect-ok` registration with the topic and
    // address of the request put in, and every one is kept for the assertions. Anything else goes
    // to the refusing fetch.
    const template = readShopifyFixture('connect-ok/07-webhook-subscription-create.json');
    refusingFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/graphql.json') && typeof init?.body === 'string') {
        const sent = JSON.parse(init.body) as {
          operationName?: string;
          variables?: { topic: string; webhookSubscription: { uri: string } };
        };
        if (sent.operationName === 'WebhookSubscriptionCreate' && sent.variables) {
          const registration = {
            topic: sent.variables.topic,
            uri: sent.variables.webhookSubscription.uri,
          };
          registrations.push(registration);
          const answer = structuredClone(template.response.body) as {
            data: { webhookSubscriptionCreate: { webhookSubscription: Registration } };
          };
          Object.assign(answer.data.webhookSubscriptionCreate.webhookSubscription, registration);
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: template.response.headers,
          });
        }
      }
      return refusingFetch(input, init);
    };

    const boss = await api.addPerson(['manager']);
    manager = await api.signIn(boss.email);
    const agent = await api.addPerson(['support', 'operations', 'warehouse']);
    support = await api.signIn(agent.email);
  }, 180_000);

  afterAll(async () => {
    if (refusingFetch) globalThis.fetch = refusingFetch;
    await worker?.close();
    await api?.close();
  });

  it('connects: rows in one transaction, names from the shop, health ok, 13 subscriptions', async () => {
    const before = registrations.length;
    const { id, body: sent, detail: connected } = await connect('connect-ok');

    // The store, its channel, the connection, the audit entry, and the job all exist.
    const store = await api.owner.pool.query<{ id: string; name: unknown; public_name: unknown }>(
      `SELECT s.id, s.name, s.public_name FROM stores s JOIN connections c ON c.store_id = s.id
       WHERE c.id = $1::uuid AND s.code = $2 AND s.kind = 'shopify'`,
      [id, sent.storeCode],
    );
    expect(store.rows).toHaveLength(1);
    const storeId = store.rows[0]?.id;
    expect(
      await count(
        `SELECT count(*) AS n FROM channels
         WHERE code = $1 AND kind = 'shopify' AND default_store_id = $2::uuid`,
        [sent.storeCode, storeId],
      ),
    ).toBe(1);
    const audit = await api.owner.pool.query<{ record_label: string; after: unknown }>(
      `SELECT record_label, after FROM audit_entries
       WHERE action = 'connection.created' AND record_type = 'connection' AND record_id = $1::uuid`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      record_label: sent.storeCode,
      after: { shopDomain: sent.shopDomain, storeCode: sent.storeCode, appOwner: 'organization' },
    });
    const jobs = await api.owner.pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job WHERE name = 'connector-shopify' AND data->>'connectionId' = $1`,
      [id],
    );
    expect(jobs.rows.map((row) => row.data)).toEqual([
      { kind: 'connect', connectionId: id, capability: 'connectors.shopify.sync' },
    ]);

    // The names come from the shop, in both languages; the channel follows.
    expect(store.rows[0]?.name).toEqual({ en: 'Fixture Store', ar: 'Fixture Store' });
    expect(store.rows[0]?.public_name).toEqual({ en: 'Fixture Store', ar: 'Fixture Store' });

    expect(connected).toMatchObject({
      health: 'ok',
      healthReason: null,
      healthWarnings: [],
      apiVersion: '2026-10',
      shopDomain: sent.shopDomain,
      appOwner: 'organization',
      shopTimezone: 'Africa/Cairo',
      credentials: { set: true, clientIdLast4: 'ABCD' },
      store: { id: storeId, code: sent.storeCode, name: { en: 'Fixture Store' } },
      lastCheck: {
        status: 'succeeded',
        errorCode: null,
        missingScopes: [],
        webhookTopicsSubscribed: 13,
        locations: 2,
        onlineLocations: 1,
      },
    });
    expect(connected.healthChangedAt).not.toBeNull();

    // The 13 topics, once each, at the connection's https address.
    const mine = registrations.slice(before);
    expect(mine.map((r) => r.topic).sort()).toEqual([...SHOPIFY_WEBHOOK_TOPICS].sort());
    expect(new Set(mine.map((r) => r.uri))).toEqual(
      new Set([`${HOOK_ORIGIN}/api/hooks/shopify/${id}`]),
    );
    // Every recorded read was used; only the fixed address registration was answered by the stand in.
    expect(remainingShopifyExchanges()).toEqual(['connect-ok/07-webhook-subscription-create.json']);

    const run = await api.owner.pool.query<{ status: string; cost_points: number }>(
      `SELECT status, cost_points FROM connection_sync_runs
       WHERE connection_id = $1::uuid AND kind = 'connect'`,
      [id],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]?.status).toBe('succeeded');
    expect(run.rows[0]?.cost_points).toBeGreaterThan(0);

    // The list shows it, with its store code and health, paged by the keyset cursor.
    const list = await api.call(manager, 'GET', '/api/connections?limit=1');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    answers.push(JSON.stringify(list.body));
    const page = ConnectionListResponse.parse(list.body);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id,
      provider: 'shopify',
      storeCode: sent.storeCode,
      status: 'active',
      health: 'ok',
    });
  });

  it.each([
    ['connect-app-not-installed', 'APP_NOT_INSTALLED'],
    ['connect-shop-not-permitted', 'APP_ORGANIZATION_MISMATCH'],
    ['connect-credentials-rejected', 'CREDENTIALS_REJECTED'],
    ['connect-scope-missing', 'SCOPES_MISSING'],
    ['connect-protected-data-missing', 'PROTECTED_DATA_MISSING'],
    ['connect-currency-mismatch', 'CURRENCY_MISMATCH'],
  ])('ends failing on %s with %s and registers no webhook', async (scenario, code) => {
    const before = registrations.length;
    const { id, detail: failed } = await connect(scenario);
    expect(failed).toMatchObject({
      health: 'failing',
      healthReason: code,
      lastCheck: { status: 'failed', errorCode: code },
    });
    if (code === 'SCOPES_MISSING') {
      expect(failed.lastCheck?.missingScopes).toEqual(['write_inventory', 'read_locations']);
    }
    expect(registrations.length).toBe(before);
    expect(remainingShopifyExchanges()).toEqual([]);
    // The store keeps the label typed at connect until a check reaches the shop.
    const name = await api.owner.pool.query<{ name: unknown }>(
      `SELECT s.name FROM stores s JOIN connections c ON c.store_id = s.id WHERE c.id = $1::uuid`,
      [id],
    );
    const reachedShop = ![
      'APP_NOT_INSTALLED',
      'APP_ORGANIZATION_MISMATCH',
      'CREDENTIALS_REJECTED',
    ].includes(code);
    expect((name.rows[0]?.name as { en?: string }).en === 'Fixture Store').toBe(reachedShop);
  });

  it('keeps health ok with SHOP_TIMEZONE_DIFFERS for a shop in another time zone', async () => {
    const { id, detail: connected } = await connect('connect-shop-timezone-differs');
    expect(connected).toMatchObject({
      health: 'ok',
      healthReason: null,
      healthWarnings: ['SHOP_TIMEZONE_DIFFERS'],
      shopTimezone: 'Asia/Dubai',
    });
    expect(registrations.filter((r) => r.uri.endsWith(id))).toHaveLength(13);
  });

  it('keeps health ok with APP_OWNED_BY_PERSON for an app in a person account', async () => {
    const { detail: connected } = await connect('connect-ok', { appOwner: 'person' });
    expect(connected).toMatchObject({
      health: 'ok',
      healthWarnings: ['APP_OWNED_BY_PERSON'],
      appOwner: 'person',
    });
  });

  it('turns a failing connection ok through a passed check, and refuses unknown and archived ones', async () => {
    const { id } = await connect('connect-credentials-rejected');
    useShopifyScenarios('connect-ok');
    const checked = await api.call(manager, 'POST', `/api/connections/${id}/check`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(202);
    const healed = await eventually(
      async () => {
        const found = await detail(id);
        return found.health === 'ok' ? found : undefined;
      },
      { timeoutMs: 60_000, what: 'the check to pass' },
    );
    expect(healed).toMatchObject({ healthReason: null, lastCheck: { status: 'succeeded' } });

    const unknown = await api.call(manager, 'POST', `/api/connections/${randomUUID()}/check`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await api.call(manager, 'GET', `/api/connections/${randomUUID()}`)).status).toBe(404);
    expect((await api.call(manager, 'GET', '/api/connections/not-a-uuid')).status).toBe(404);

    await api.owner.pool.query(`UPDATE connections SET status = 'archived' WHERE id = $1::uuid`, [
      id,
    ]);
    const archived = await api.call(manager, 'POST', `/api/connections/${id}/check`);
    expect(archived.status).toBe(409);
    expect(archived.body).toMatchObject({ code: 'CONNECTION_ARCHIVED' });
  });

  it('answers 409 SHOP_ALREADY_CONNECTED for a second connection to a shop, keeping nothing', async () => {
    const { body: first } = await connect('connect-ok');
    const stores = await count('SELECT count(*) AS n FROM stores', []);
    const audits = await count(
      `SELECT count(*) AS n FROM audit_entries WHERE action = 'connection.created'`,
      [],
    );
    const again = body({ shopDomain: first.shopDomain.toUpperCase() });
    const reply = await api.call(manager, 'POST', '/api/connections/shopify', again);
    expect(reply.status, JSON.stringify(reply.body)).toBe(409);
    expect(reply.body).toMatchObject({ code: 'SHOP_ALREADY_CONNECTED' });
    // Rolled back whole: no store, channel, entry, or job of the refused connect.
    expect(await count('SELECT count(*) AS n FROM stores', [])).toBe(stores);
    expect(
      await count('SELECT count(*) AS n FROM channels WHERE code = $1', [again.storeCode]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM audit_entries WHERE action = 'connection.created'`,
        [],
      ),
    ).toBe(audits);
  });

  it('answers 409 STORE_CODE_TAKEN for a store code in use, keeping nothing', async () => {
    const connections = await count('SELECT count(*) AS n FROM connections', []);
    const jobs = await count(
      `SELECT count(*) AS n FROM pgboss.job WHERE name = 'connector-shopify'`,
      [],
    );
    const reply = await api.call(
      manager,
      'POST',
      '/api/connections/shopify',
      body({ storeCode: 'MAIN' }),
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(409);
    expect(reply.body).toMatchObject({ code: 'STORE_CODE_TAKEN' });
    expect(await count('SELECT count(*) AS n FROM connections', [])).toBe(connections);
    expect(
      await count(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'connector-shopify'`, []),
    ).toBe(jobs);
  });

  it('answers 422 INVALID_SHOP_DOMAIN for a bad domain and INVALID_BODY for other bad fields', async () => {
    const bad = await api.call(
      manager,
      'POST',
      '/api/connections/shopify',
      body({ shopDomain: 'fixture.example.com' }),
    );
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'INVALID_SHOP_DOMAIN' });
    const missing = await api.call(manager, 'POST', '/api/connections/shopify', {
      ...body(),
      clientSecret: '',
    });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'INVALID_BODY' });
    // Security review L11: a label with a direction override or a control character.
    for (const label of ['Main ‮erots', 'Main\u0007store']) {
      const spoofed = await api.call(manager, 'POST', '/api/connections/shopify', body({ label }));
      expect(spoofed.status).toBe(422);
      expect(spoofed.body).toMatchObject({ code: 'INVALID_BODY' });
      answers.push(JSON.stringify(spoofed.body));
    }
    answers.push(JSON.stringify(bad.body), JSON.stringify(missing.body));
  });

  it('writes API_VERSION_FELL_FORWARD to the health warnings when Shopify answers newer, and a matching check clears it (AC-25)', async () => {
    const { id, detail: connected } = await connect('connect-version-fell-forward');
    expect(connected).toMatchObject({ health: 'ok', healthReason: null });
    const stored = async () =>
      (
        await api.owner.pool.query<{ warnings: string[]; api_version: string }>(
          'SELECT health_warnings AS warnings, api_version FROM connections WHERE id = $1::uuid',
          [id],
        )
      ).rows[0];
    expect(await stored()).toEqual({
      warnings: ['API_VERSION_FELL_FORWARD'],
      api_version: '2027-01',
    });
    expect(remainingShopifyExchanges()).toEqual([
      'connect-version-fell-forward/07-webhook-subscription-create.json',
    ]);

    useShopifyScenarios('connect-ok');
    const checked = await api.call(manager, 'POST', `/api/connections/${id}/check`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(202);
    await eventually(async () => ((await stored())?.warnings.length === 0 ? true : undefined), {
      timeoutMs: 60_000,
      what: 'the warning to clear',
    });
  });

  it('refuses a person without settings.manage with 403', async () => {
    for (const [method, path, sent] of [
      ['GET', '/api/connections', undefined],
      ['POST', '/api/connections/shopify', body()],
      ['GET', `/api/connections/${randomUUID()}`, undefined],
      ['POST', `/api/connections/${randomUUID()}/check`, undefined],
    ] as const) {
      const reply = await api.call(support, method, path, sent);
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('never lets the secret or the token out: answers, rows, job data, sync runs, logs', async () => {
    const texts = async (query: string) =>
      (await api.owner.pool.query<{ text: string }>(query)).rows.map((row) => row.text).join('\n');
    const places = {
      answers: answers.join('\n'),
      audit: await texts('SELECT row_to_json(a)::text AS text FROM audit_entries a'),
      jobs: await texts(
        `SELECT row_to_json(j)::text AS text FROM pgboss.job j WHERE name = 'connector-shopify'`,
      ),
      syncRuns: await texts('SELECT row_to_json(r)::text AS text FROM connection_sync_runs r'),
      connections: await texts(
        `SELECT (to_jsonb(c) - 'credentials_ciphertext')::text AS text FROM connections c`,
      ),
      logs: logLines.join('\n'),
    };
    expect(places.answers.length).toBeGreaterThan(0);
    expect(places.jobs.length).toBeGreaterThan(0);
    // The capture saw the connect job's own lines, so an empty search would not pass by accident.
    expect(places.logs).toContain('connect connection=');
    for (const [place, text] of Object.entries(places)) {
      expect(text.includes(SENTINEL_SECRET), `secret in ${place}`).toBe(false);
      expect(text.includes(FIXTURE_TOKEN), `token in ${place}`).toBe(false);
    }
    // The full client id never comes back either: only its last 4 characters.
    expect(places.answers.includes('client-id-')).toBe(false);
  });
});
