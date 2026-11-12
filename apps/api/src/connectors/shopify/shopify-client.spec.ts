import { describe, expect, it } from 'vitest';
import {
  UnrecordedRequest,
  createShopifyFixtureFetch,
  remainingShopifyExchanges,
  useShopifyScenarios,
} from '../../../test/shopify-fixture-fetch.js';
import type { ConnectionCredentials } from '../connections/connection-secrets.js';
import {
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  REQUEST_TIMEOUT_MS,
  SHOPIFY_API_VERSION,
  ShopifyClient,
  ShopifyClientError,
  ShopifyRejectedError,
  ShopifyTransientError,
  rejectUserErrors,
  type ShopifyClientOptions,
  type ShopifyConnectionAccess,
} from './shopify-client.js';
import { CONNECT_ACCESS_SCOPES, CONNECT_SHOP, CONNECT_SHOP_OPERATION } from './shopify-queries.js';

// Obviously fake test values; the sentinels must never surface in an error or a log line.
const SECRET_SENTINEL = 'sentinel-client-secret-0000';
const TOKEN_SENTINEL = 'sentinel-access-token-0000';
const SHOP = 'fixture-store.myshopify.com';
const CREDENTIALS: ConnectionCredentials = {
  kind: 'client_credentials',
  clientId: 'fake-client-id',
  clientSecret: SECRET_SENTINEL,
};
const access = (connectionId = 'connection-1', shopDomain = SHOP): ShopifyConnectionAccess => ({
  connectionId,
  shopDomain,
  credentials: CREDENTIALS,
});
const SHOP_OP = { operationName: CONNECT_SHOP_OPERATION, query: CONNECT_SHOP };
const SHOP_DATA = { shop: { name: 'Fixture Store' } };

/** A fake clock and sleep: sleeping moves the clock, and every wait is kept. */
function fakeTime(start = 1_000_000) {
  const time = { now: start, waits: [] as number[] };
  return {
    time,
    now: () => time.now,
    sleep: (ms: number) => {
      time.waits.push(ms);
      time.now += ms;
      return Promise.resolve();
    },
  };
}

/** A JSON answer. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-API-Version': '2026-10', ...headers },
  });
}

const tokenAnswer = (token = TOKEN_SENTINEL, expiresIn = 86_399) =>
  json(200, { access_token: token, scope: 'read_orders', expires_in: expiresIn });

const costOf = (actual: number | null, available: number, requested = 1) => ({
  cost: {
    requestedQueryCost: requested,
    actualQueryCost: actual,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 },
  },
});

type Handler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

/** A request body as text (the client sends strings only). */
const bodyText = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

/** A fetch that answers token requests with `token` and GraphQL requests with `graphql`. */
function fakeFetch(graphql: Handler, token: Handler = () => tokenAnswer()) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    return url.endsWith('/admin/oauth/access_token') ? token(url, init) : graphql(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls, tokenCalls: () => calls.filter((c) => c.url.includes('oauth')) };
}

/** Builds a client with a fake clock, a log collector, and the given options. */
function client(options: ShopifyClientOptions = {}) {
  const clock = fakeTime();
  const logs: string[] = [];
  const shopify = new ShopifyClient({
    now: clock.now,
    sleep: clock.sleep,
    logger: { warn: (message: unknown) => void logs.push(String(message)) },
    ...options,
  });
  return { shopify, clock, logs };
}

/** Awaits a call that must fail, answering the error. */
async function failure(promise: Promise<unknown>): Promise<ShopifyClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ShopifyClientError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('ShopifyClient on the recorded fixtures', () => {
  it('connects with the client credentials grant and reuses the cached token', async () => {
    useShopifyScenarios('connect-ok');
    const { shopify } = client();

    const shop = await shopify.request(access(), SHOP_OP);
    // A second token request would find no recording and throw UnrecordedRequest.
    const scopes = await shopify.request(access(), {
      operationName: 'ConnectAccessScopes',
      query: CONNECT_ACCESS_SCOPES,
    });

    expect(shop.data).toEqual({
      shop: {
        name: 'Fixture Store',
        currencyCode: 'EGP',
        ianaTimezone: 'Africa/Cairo',
        myshopifyDomain: SHOP,
      },
    });
    expect(shop.warnings).toEqual([]);
    expect(shop.apiVersion).toBe(SHOPIFY_API_VERSION);
    expect(scopes.data).toHaveProperty('currentAppInstallation.accessScopes');
  });

  it('waits the computed time after THROTTLED and retries', async () => {
    useShopifyScenarios('client-throttled-then-ok');
    const { shopify, clock } = client();

    const answer = await shopify.request(access(), SHOP_OP);

    // 1 point missing at 50 points a second: 20 ms.
    expect(clock.time.waits).toEqual([20]);
    expect(answer.data).toMatchObject({ shop: { name: 'Fixture Store' } });
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('waits Retry-After after an HTTP 429 and retries', async () => {
    useShopifyScenarios('client-429-then-ok');
    const { shopify, clock } = client();

    await shopify.request(access(), SHOP_OP);

    expect(clock.time.waits).toEqual([2_000]);
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('reports API_VERSION_FELL_FORWARD when Shopify answers with another version', async () => {
    useShopifyScenarios('client-version-fall-forward');
    const { shopify, logs } = client();

    const answer = await shopify.request(access(), SHOP_OP);

    expect(answer.apiVersion).toBe('2027-01');
    expect(answer.warnings).toEqual(['API_VERSION_FELL_FORWARD']);
    expect(logs.join('\n')).toContain('API_VERSION_FELL_FORWARD');
  });

  it.each([
    ['connect-app-not-installed', 'APP_NOT_INSTALLED'],
    ['connect-shop-not-permitted', 'APP_ORGANIZATION_MISMATCH'],
    ['connect-credentials-rejected', 'CREDENTIALS_REJECTED'],
  ])('maps the token refusal of %s to %s', async (scenario, code) => {
    useShopifyScenarios(scenario);
    const { shopify } = client();

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(error).toBeInstanceOf(ShopifyRejectedError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(`Shopify rejected: ${code}`);
  });

  it('lets an unrecorded request fail the test with UnrecordedRequest', async () => {
    const { shopify } = client();

    await expect(shopify.request(access(), SHOP_OP)).rejects.toBeInstanceOf(UnrecordedRequest);
    await expect(fetch('https://example.com/anything')).rejects.toBeInstanceOf(UnrecordedRequest);
  });
});

describe('ShopifyClient token cache', () => {
  it('fetches the token again 60 seconds before it expires, not earlier', async () => {
    const fake = fakeFetch(
      () => json(200, { data: SHOP_DATA }),
      () => tokenAnswer('t', 1_000),
    );
    const { shopify, clock } = client({ fetch: fake.fetchImpl });

    await shopify.request(access(), SHOP_OP);
    clock.time.now += 1_000_000 - 60_000 - 1;
    await shopify.request(access(), SHOP_OP);
    expect(fake.tokenCalls()).toHaveLength(1);

    clock.time.now += 1;
    await shopify.request(access(), SHOP_OP);
    expect(fake.tokenCalls()).toHaveLength(2);
  });

  it('sends the grant form encoded with no scope, and the token in X-Shopify-Access-Token', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    await shopify.request(access(), SHOP_OP);

    const [tokenCall, graphqlCall] = fake.calls;
    const form = new URLSearchParams(bodyText(tokenCall?.init));
    expect(tokenCall?.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.has('scope')).toBe(false);
    expect(graphqlCall?.url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    expect(new Headers(graphqlCall?.init?.headers).get('X-Shopify-Access-Token')).toBe(
      TOKEN_SENTINEL,
    );
  });

  it('fetches a new token once after a 401, then gives up with CREDENTIALS_REJECTED', async () => {
    const fake = fakeFetch(() => json(401, { errors: 'Invalid API key or access token' }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(error.code).toBe('CREDENTIALS_REJECTED');
    expect(fake.tokenCalls()).toHaveLength(2);
  });

  it('uses a legacy access token as is, with no exchange', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    await shopify.request(
      {
        connectionId: 'legacy',
        shopDomain: SHOP,
        credentials: { kind: 'access_token', accessToken: 'fake-legacy-token', apiSecret: 'x' },
      },
      SHOP_OP,
    );

    expect(fake.tokenCalls()).toHaveLength(0);
  });

  it('goes to SHOPIFY_MOCK_ORIGIN instead of the shop when set', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl, mockOrigin: 'http://localhost:3935/' });

    await shopify.request(access(), SHOP_OP);

    expect(fake.calls.map((c) => c.url)).toEqual([
      'http://localhost:3935/admin/oauth/access_token',
      'http://localhost:3935/admin/api/2026-10/graphql.json',
    ]);
  });

  it('refuses a shop domain that is not <name>.myshopify.com before any call', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access('c', 'evil.example/x'), SHOP_OP));

    expect(error.code).toBe('INVALID_SHOP_DOMAIN');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('ShopifyClient rate policy', () => {
  it('waits before a call whose expected cost exceeds what has been restored', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA, extensions: costOf(110, 10) }));
    const { shopify, clock } = client({ fetch: fake.fetchImpl });

    await shopify.request(access(), SHOP_OP);
    expect(clock.time.waits).toEqual([]);
    // 10 available, 110 expected (the last actual cost), 50 a second: 2 seconds.
    expect(shopify.waitFor('connection-1', 110)).toBe(2_000);
    clock.time.now += 1_000;
    await shopify.request(access(), SHOP_OP);

    // One second already restored 50 points: the rest takes 1 second.
    expect(clock.time.waits).toEqual([1_000]);
  });

  it('refuses a query whose expected cost exceeds 1,000 points without sending it', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), { ...SHOP_OP, expectedCost: 1_001 }));

    expect(error).toBeInstanceOf(ShopifyRejectedError);
    expect(error.code).toBe('QUERY_TOO_COSTLY');
    expect(fake.calls).toHaveLength(0);
  });

  it('gives up after 5 THROTTLED retries with a transient THROTTLED', async () => {
    const fake = fakeFetch(() =>
      json(200, {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: costOf(null, 0, 100),
      }),
    );
    const { shopify, clock } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(error).toBeInstanceOf(ShopifyTransientError);
    expect(error.code).toBe('THROTTLED');
    expect(clock.time.waits).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it('waits 1 second after a 429 without Retry-After, and is transient after 5 retries', async () => {
    const fake = fakeFetch(() => json(429, { errors: 'Too many' }));
    const { shopify, clock } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.kind).toBe('transient');
    expect(clock.time.waits).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  it('runs one call per connection at a time, and other connections alongside', async () => {
    const started: string[] = [];
    const release: (() => void)[] = [];
    const fake = fakeFetch(
      (_url, init) =>
        new Promise<Response>((resolve) => {
          started.push(new Headers(init?.headers).get('X-Shopify-Access-Token') ?? '');
          release.push(() => resolve(json(200, { data: SHOP_DATA })));
        }),
      (_url, init) => tokenAnswer(`token-${bodyText(init).includes('other') ? 'b' : 'a'}`),
    );
    const { shopify } = client({ fetch: fake.fetchImpl });
    const other: ShopifyConnectionAccess = {
      connectionId: 'connection-2',
      shopDomain: SHOP,
      credentials: { kind: 'client_credentials', clientId: 'other', clientSecret: 'fake' },
    };

    const first = shopify.request(access(), SHOP_OP);
    const second = shopify.request(access(), SHOP_OP);
    const third = shopify.request(other, SHOP_OP);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // connection-1's second call has not started; connection-2's runs alongside the first.
    expect(started).toEqual(['token-a', 'token-b']);
    release.shift()?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['token-a', 'token-b', 'token-a']);
    for (const done of release.splice(0)) done();
    await Promise.all([second, third]);
  });

  it('runs the next call of a connection after the previous one failed', async () => {
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      return calls === 1 ? json(500, {}) : json(200, { data: SHOP_DATA });
    });
    const { shopify } = client({ fetch: fake.fetchImpl });

    const failed = shopify.request(access(), SHOP_OP);
    const next = shopify.request(access(), SHOP_OP);

    await expect(failed).rejects.toBeInstanceOf(ShopifyTransientError);
    await expect(next).resolves.toMatchObject({ data: SHOP_DATA });
  });
});

describe('ShopifyClient failures', () => {
  it('treats a request that outlives the timeout as a transient TIMEOUT', async () => {
    const fake = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const { shopify } = client({ fetch: fake.fetchImpl, timeoutMs: 20 });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(error).toBeInstanceOf(ShopifyTransientError);
    expect(error.code).toBe('TIMEOUT');
  });

  it('treats a refused connection as a transient NETWORK_ERROR', async () => {
    const fake = fakeFetch(() => Promise.reject(new TypeError(`fetch failed ${SECRET_SENTINEL}`)));
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.kind).toBe('transient');
  });

  it.each([
    [500, 'transient', 'SERVER_ERROR'],
    [503, 'transient', 'SERVER_ERROR'],
    [402, 'rejected', 'SHOP_UNAVAILABLE'],
    [404, 'rejected', 'NOT_FOUND'],
    [400, 'rejected', 'REQUEST_REJECTED'],
  ])('types HTTP %i as %s %s', async (status, kind, code) => {
    const fake = fakeFetch(() => json(status, { errors: 'whatever' }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect([error.kind, error.code, error.status]).toEqual([kind, code, status]);
  });

  it.each([
    ['ACCESS_DENIED', 'rejected', 'ACCESS_DENIED'],
    ['MAX_COST_EXCEEDED', 'rejected', 'QUERY_TOO_COSTLY'],
    ['SHOP_INACTIVE', 'rejected', 'SHOP_UNAVAILABLE'],
    ['INTERNAL_SERVER_ERROR', 'transient', 'SERVER_ERROR'],
    ['SOMETHING_NEW', 'rejected', 'GRAPHQL_ERROR'],
  ])('types the GraphQL error %s as %s %s', async (graphqlCode, kind, code) => {
    const fake = fakeFetch(() =>
      json(200, { errors: [{ message: 'text', extensions: { code: graphqlCode } }] }),
    );
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect([error.kind, error.code]).toEqual([kind, code]);
  });

  it('treats an answer that is not JSON as a transient INVALID_RESPONSE', async () => {
    const fake = fakeFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    expect((await failure(shopify.request(access(), SHOP_OP))).code).toBe('INVALID_RESPONSE');
  });

  it('rejects mutation userErrors, keeping only their codes', () => {
    let error: unknown;
    try {
      rejectUserErrors([
        {
          field: ['webhookSubscription', 'uri'],
          message: `bad ${SECRET_SENTINEL}`,
          code: 'INVALID',
        },
        { field: null, message: 'no code' },
      ]);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(ShopifyRejectedError);
    expect((error as ShopifyRejectedError).code).toBe('USER_ERRORS');
    expect((error as ShopifyRejectedError).graphqlCodes).toEqual(['INVALID']);
    expect(() => rejectUserErrors([])).not.toThrow();
  });

  it('never puts the secret, the token, or a body text in an error or a log line', async () => {
    const leaky = (status: number) => () =>
      json(status, {
        errors: [{ message: `${TOKEN_SENTINEL} ${SECRET_SENTINEL}`, extensions: { code: 'X' } }],
      });
    const scenarios: Handler[] = [
      leaky(200),
      leaky(400),
      leaky(401),
      leaky(500),
      () => json(429, { errors: TOKEN_SENTINEL }),
      () =>
        json(200, {
          errors: [{ message: TOKEN_SENTINEL, extensions: { code: 'THROTTLED' } }],
          extensions: costOf(null, 0),
        }),
    ];
    const surfaced: string[] = [];
    for (const graphql of scenarios) {
      const fake = fakeFetch(graphql);
      const { shopify, logs } = client({ fetch: fake.fetchImpl });
      const error = await failure(shopify.request(access(), SHOP_OP));
      surfaced.push(error.message, error.stack ?? '', JSON.stringify(error), ...logs);
    }
    const tokenRefused = fakeFetch(
      () => json(200, { data: SHOP_DATA }),
      () => json(400, { error: 'shop_not_permitted', error_description: SECRET_SENTINEL }),
    );
    const refused = await failure(
      client({ fetch: tokenRefused.fetchImpl }).shopify.request(access(), SHOP_OP),
    );
    surfaced.push(refused.message, refused.stack ?? '', JSON.stringify(refused));

    const everything = surfaced.join('\n');
    expect(everything).not.toContain(SECRET_SENTINEL);
    expect(everything).not.toContain(TOKEN_SENTINEL);
    expect(everything).not.toContain('fake-client-id');
  });
});

describe('ShopifyClient limits (security review L3, L4)', () => {
  it('never follows a redirect: redirect error on every request, a 3xx or a refused redirect is REQUEST_REJECTED', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl });
    await shopify.request(access(), SHOP_OP);
    expect(fake.calls.map((call) => call.init?.redirect)).toEqual(['error', 'error']);

    const moved = fakeFetch(
      () =>
        new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example/' } }),
    );
    const third = client({ fetch: moved.fetchImpl });
    const tokenMoved = await failure(third.shopify.request(access(), SHOP_OP));
    expect([tokenMoved.kind, tokenMoved.code, tokenMoved.status]).toEqual([
      'rejected',
      'REQUEST_REJECTED',
      307,
    ]);

    // What undici throws under `redirect: 'error'` when the server answers a redirect.
    const refused = fakeFetch(() =>
      Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })),
    );
    const fourth = client({ fetch: refused.fetchImpl });
    expect((await failure(fourth.shopify.request(access(), SHOP_OP))).code).toBe(
      'REQUEST_REJECTED',
    );
  });

  it('does not sleep a Retry-After above 60 seconds: a transient RATE_LIMITED at once', async () => {
    const fake = fakeFetch(() => json(429, {}, { 'Retry-After': '3600' }));
    const { shopify, clock } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.request(access(), SHOP_OP));

    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
    expect([error.kind, error.code]).toEqual(['transient', 'RATE_LIMITED']);
    expect(clock.time.waits).toEqual([]);
  });

  it('refuses an answer above 10 MB, by Content-Length or while reading, with RESPONSE_TOO_LARGE', async () => {
    const declared = fakeFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) },
        }),
    );
    const first = client({ fetch: declared.fetchImpl });
    const byHeader = await failure(first.shopify.request(access(), SHOP_OP));
    expect([byHeader.kind, byHeader.code]).toEqual(['rejected', 'RESPONSE_TOO_LARGE']);

    let pulled = 0;
    const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
    const streamed = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(megabyte);
            },
          }),
          { status: 200 },
        ),
    );
    const second = client({ fetch: streamed.fetchImpl });
    const byRead = await failure(second.shopify.request(access(), SHOP_OP));
    expect(byRead.code).toBe('RESPONSE_TOO_LARGE');
    // It stopped reading just past the cap instead of draining an endless body.
    expect(pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES / megabyte.byteLength + 2);
  });
});

describe('ShopifyClient.confirmAccess (security review L1)', () => {
  it('makes one fresh token exchange for client credentials, even with a cached token', async () => {
    const fake = fakeFetch(() => json(200, { data: SHOP_DATA }));
    const { shopify } = client({ fetch: fake.fetchImpl });
    await shopify.request(access(), SHOP_OP);

    await shopify.confirmAccess(access());

    expect(fake.tokenCalls()).toHaveLength(2);
    expect(fake.calls).toHaveLength(3);
  });

  it('throws the token refusal code that confirms an uninstall', async () => {
    const fake = fakeFetch(
      () => json(200, { data: SHOP_DATA }),
      () => json(400, { error: 'app_not_installed' }),
    );
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(shopify.confirmAccess(access()));

    expect([error.kind, error.code]).toEqual(['rejected', 'APP_NOT_INSTALLED']);
  });

  it('reads the shop once for a legacy access token', async () => {
    const fake = fakeFetch(() => json(401, { errors: 'Invalid API key or access token' }));
    const { shopify } = client({ fetch: fake.fetchImpl });

    const error = await failure(
      shopify.confirmAccess({
        connectionId: 'legacy',
        shopDomain: SHOP,
        credentials: { kind: 'access_token', accessToken: 'fake-legacy-token', apiSecret: 'x' },
      }),
    );

    expect(error.code).toBe('CREDENTIALS_REJECTED');
    expect(fake.tokenCalls()).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('the refusing test fetch (security review L10)', () => {
  it('passes a loopback request through without following a redirect', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const passThrough = ((_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(
        new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }),
      );
    }) as typeof fetch;
    const refusing = createShopifyFixtureFetch(passThrough);

    const answer = await refusing.fetch('http://127.0.0.1:3931/api/health');

    expect(answer.status).toBe(302);
    expect(seen.map((init) => init?.redirect)).toEqual(['manual']);
  });
});
