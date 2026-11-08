import { Logger } from '@nestjs/common';
import type { ConnectionCredentials } from '../connections/connection-secrets.js';

/**
 * The one Shopify Admin API version the connector speaks (spec 0015, *Shopify app, auth, and API
 * version*; supported until 16 October 2027). Moving to a newer version is a release step with the
 * fixtures recorded again; never change it without that.
 */
export const SHOPIFY_API_VERSION = '2026-10';

/** Shopify refuses a single query above this many cost points (`MAX_COST_EXCEEDED`). */
export const SHOPIFY_MAX_QUERY_COST = 1_000;

/** A cached access token is fetched again this long before it expires (AC-2). */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Every request, the body read included, is abandoned after this long (a transient `TIMEOUT`). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** How many times a `THROTTLED` answer, and separately an HTTP 429, is retried before giving up. */
export const MAX_THROTTLE_RETRIES = 5;

/** Shopify's advised backoff when it gives no better figure (HTTP 429 without `Retry-After`). */
const DEFAULT_BACKOFF_MS = 1_000;

/** The shop domains a connection may have (the `connections_shop_domain_shape` check). */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** A code shape safe to carry in an error: upper case letters, digits, and underscores. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Codes of a transient failure: the job may retry later with backoff. */
export type ShopifyTransientCode =
  'NETWORK_ERROR' | 'TIMEOUT' | 'SERVER_ERROR' | 'RATE_LIMITED' | 'THROTTLED' | 'INVALID_RESPONSE';

/** Codes of a rejection: retrying the same call will not help; a person or a fix must act. */
export type ShopifyRejectedCode =
  | 'APP_NOT_INSTALLED'
  | 'APP_ORGANIZATION_MISMATCH'
  | 'CREDENTIALS_REJECTED'
  | 'ACCESS_DENIED'
  | 'SHOP_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'REQUEST_REJECTED'
  | 'GRAPHQL_ERROR'
  | 'QUERY_TOO_COSTLY'
  | 'USER_ERRORS'
  | 'INVALID_SHOP_DOMAIN';

/** A warning a successful call carries; the caller turns it into a connection health warning. */
export type ShopifyWarning = 'API_VERSION_FELL_FORWARD';

/**
 * Base class of every Shopify client error. The message is `Shopify <kind>: <code>` and nothing
 * else: never a token, a secret, a request or response body, or a Shopify message text.
 */
export class ShopifyClientError extends Error {
  /**
   * @param kind - `transient` (retry later) or `rejected` (will not succeed as sent).
   * @param code - the stable code.
   * @param status - the HTTP status when one was received, else null.
   * @param graphqlCodes - Shopify's `extensions.code` values (or user error codes), shape checked.
   */
  constructor(
    readonly kind: 'transient' | 'rejected',
    readonly code: ShopifyTransientCode | ShopifyRejectedCode,
    readonly status: number | null = null,
    readonly graphqlCodes: readonly string[] = [],
  ) {
    super(`Shopify ${kind}: ${code}`);
    this.name = new.target.name;
  }
}

/** A failure worth retrying later: network, timeout, 5xx, 429 or `THROTTLED` after the retries. */
export class ShopifyTransientError extends ShopifyClientError {
  /** @param code - see `ShopifyTransientCode`. */
  constructor(code: ShopifyTransientCode, status: number | null = null) {
    super('transient', code, status);
  }
}

/** A refusal: 4xx, a token error, a GraphQL error, or mutation `userErrors`. */
export class ShopifyRejectedError extends ShopifyClientError {
  /** @param code - see `ShopifyRejectedCode`. */
  constructor(
    code: ShopifyRejectedCode,
    status: number | null = null,
    graphqlCodes: readonly string[] = [],
  ) {
    super('rejected', code, status, graphqlCodes);
  }
}

/** Shopify's leaky bucket reading, from `extensions.cost.throttleStatus`. */
export interface ShopifyThrottleStatus {
  /** The bucket size in points. */
  readonly maximumAvailable: number;
  /** The points available when Shopify answered. */
  readonly currentlyAvailable: number;
  /** Points restored per second. */
  readonly restoreRate: number;
}

/** `extensions.cost` of an answer. */
export interface ShopifyQueryCost {
  /** What Shopify computed before running the query. */
  readonly requestedQueryCost: number | null;
  /** What it really cost (null when it did not run, as on `THROTTLED`). */
  readonly actualQueryCost: number | null;
  /** The bucket after the call, when given. */
  readonly throttleStatus: ShopifyThrottleStatus | null;
}

/** The connection a call runs for: its id (the lock and cache key), shop, and opened credentials. */
export interface ShopifyConnectionAccess {
  /** The `connections.id`; calls with the same id never overlap. */
  readonly connectionId: string;
  /** `<name>.myshopify.com`, checked against the connections shape before any call. */
  readonly shopDomain: string;
  /** Opened by `ConnectionSecrets.open` in the worker; held only in memory. */
  readonly credentials: ConnectionCredentials;
}

/** One GraphQL operation: a constant from `shopify-queries.ts` and its variables. */
export interface ShopifyOperation {
  /** The operation name inside `query` (the recordings match on it). */
  readonly operationName: string;
  /** The query or mutation text. */
  readonly query: string;
  /** Its variables, or omitted. */
  readonly variables?: Readonly<Record<string, unknown>>;
  /**
   * The expected cost when the caller knows it (a page size times a per node cost). Above
   * `SHOPIFY_MAX_QUERY_COST` the call is refused before sending. Unset: the last actual cost of
   * this operation on this connection is used, else no wait.
   */
  readonly expectedCost?: number;
}

/** A successful answer. `data` is unknown: the caller parses it with its own zod schema. */
export interface ShopifyResponse {
  /** The GraphQL `data`. */
  readonly data: unknown;
  /** `X-Shopify-API-Version` of the answer, or null when absent. */
  readonly apiVersion: string | null;
  /** `API_VERSION_FELL_FORWARD` when that header differs from `SHOPIFY_API_VERSION`. */
  readonly warnings: readonly ShopifyWarning[];
  /** `extensions.cost`, when given. */
  readonly cost: ShopifyQueryCost | null;
}

/** What the client needs from the outside world; every field is replaceable in a test. */
export interface ShopifyClientOptions {
  /** Called per request; default the global `fetch`, looked up at call time (the test harness replaces it). */
  readonly fetch?: typeof fetch;
  /** Milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
  /** Waits; default a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `SHOPIFY_MOCK_ORIGIN`: every call goes there instead of `https://<shop>`. */
  readonly mockOrigin?: string;
  /** Per request timeout; default `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Where retries and waits are logged (codes only); default a Nest `Logger`. */
  readonly logger?: Pick<Logger, 'warn'>;
}

/** A cached token of one connection. */
interface CachedToken {
  readonly clientId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

/** The throttle reading of one connection and when it was taken. */
interface ThrottleReading extends ShopifyThrottleStatus {
  readonly readAt: number;
}

/** Everything the client remembers per connection, in this process only. */
interface ConnectionState {
  token: CachedToken | null;
  throttle: ThrottleReading | null;
  readonly lastActualCost: Map<string, number>;
  /** The tail of the per connection call chain (the in process mutex). */
  tail: Promise<void>;
}

/** A raw answer: status, the headers the client reads, and the body text. */
interface RawAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/**
 * The one Shopify Admin GraphQL client of a process (spec 0015, AC-25, *Rate policy*), with state
 * per connection: the access token cache (client credentials grant, Q-13.1; fetched again 60
 * seconds before expiry), the throttle reading from `extensions.cost.throttleStatus` and each
 * operation's last actual cost (wait before a call whose expected cost exceeds what is available),
 * `THROTTLED` retried up to 5 times and HTTP 429 after `Retry-After` (or 1 second), a 30 second
 * timeout per request, and at most one call per connection at a time (an in process mutex). An
 * answer whose `X-Shopify-API-Version` differs from `SHOPIFY_API_VERSION` carries
 * `API_VERSION_FELL_FORWARD`.
 *
 * Provide it once per process, for example
 * `{ provide: ShopifyClient, useFactory: (env: Env) => new ShopifyClient({ mockOrigin: env.SHOPIFY_MOCK_ORIGIN }), inject: [ENV] }`.
 * Must never log, throw, or return a token, a secret, or a body text: errors and logs carry codes.
 * Never call it outside a worker job of the `connector-shopify` queue (spec 0015 key invariants).
 */
export class ShopifyClient {
  private readonly states = new Map<string, ConnectionState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Logger, 'warn'>;

  /** @param options - replaceable collaborators; all optional. */
  constructor(private readonly options: ShopifyClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? new Logger(ShopifyClient.name);
  }

  /**
   * Runs one GraphQL operation for a connection, after any earlier call of the same connection
   * has finished. Throws `ShopifyTransientError` or `ShopifyRejectedError`; never anything that
   * carries a credential.
   */
  request(access: ShopifyConnectionAccess, operation: ShopifyOperation): Promise<ShopifyResponse> {
    const state = this.stateOf(access.connectionId);
    const run = state.tail.then(() => this.run(access, operation, state));
    state.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Forgets a connection's token, throttle reading, and costs: call it when its credentials are
   * replaced or it is archived, so the next call fetches a new token.
   */
  forgetConnection(connectionId: string): void {
    const state = this.states.get(connectionId);
    if (state) {
      state.token = null;
      state.throttle = null;
      state.lastActualCost.clear();
    }
  }

  /**
   * How long a call of `expectedCost` points would wait now on this connection, in milliseconds:
   * the missing points divided by the restore rate, since the last reading restored at that rate.
   * 0 when nothing is known yet. Exposed for the jobs' 60 second chunk budget and for tests.
   */
  waitFor(connectionId: string, expectedCost: number): number {
    const reading = this.states.get(connectionId)?.throttle;
    if (!reading || reading.restoreRate <= 0) return 0;
    const elapsed = Math.max(0, this.now() - reading.readAt) / 1_000;
    const available = Math.min(
      reading.maximumAvailable,
      reading.currentlyAvailable + reading.restoreRate * elapsed,
    );
    if (expectedCost <= available) return 0;
    return Math.ceil(((expectedCost - available) / reading.restoreRate) * 1_000);
  }

  private stateOf(connectionId: string): ConnectionState {
    let state = this.states.get(connectionId);
    if (!state) {
      state = { token: null, throttle: null, lastActualCost: new Map(), tail: Promise.resolve() };
      this.states.set(connectionId, state);
    }
    return state;
  }

  private async run(
    access: ShopifyConnectionAccess,
    operation: ShopifyOperation,
    state: ConnectionState,
  ): Promise<ShopifyResponse> {
    const base = this.baseUrl(access.shopDomain);
    if (operation.expectedCost !== undefined && operation.expectedCost > SHOPIFY_MAX_QUERY_COST) {
      throw new ShopifyRejectedError('QUERY_TOO_COSTLY');
    }
    const expected = operation.expectedCost ?? state.lastActualCost.get(operation.operationName);
    if (expected !== undefined) {
      const wait = this.waitFor(access.connectionId, expected);
      if (wait > 0) {
        this.log('THROTTLE_WAIT', access, operation, { waitMs: wait });
        await this.sleep(wait);
      }
    }

    const body = JSON.stringify({
      query: operation.query,
      operationName: operation.operationName,
      variables: operation.variables ?? {},
    });
    let throttledRetries = 0;
    let tokenRefreshed = false;
    for (;;) {
      const token = await this.tokenFor(access, state, base);
      const answer = await this.withRateLimitRetry(access, operation, () =>
        this.send(`${base}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body,
        }),
      );

      if (answer.status === 401) {
        // A token the shop no longer accepts: one fresh exchange for an app's client credentials.
        state.token = null;
        if (access.credentials.kind === 'client_credentials' && !tokenRefreshed) {
          tokenRefreshed = true;
          continue;
        }
        throw new ShopifyRejectedError('CREDENTIALS_REJECTED', 401);
      }
      throwForStatus(answer.status);

      const parsed = parseJson(answer.text);
      if (!isRecord(parsed)) throw new ShopifyTransientError('INVALID_RESPONSE', answer.status);
      const cost = readCost(parsed);
      this.remember(state, operation.operationName, cost);
      const codes = errorCodes(parsed);

      if (codes.includes('THROTTLED')) {
        if (throttledRetries >= MAX_THROTTLE_RETRIES) {
          throw new ShopifyTransientError('THROTTLED', answer.status);
        }
        throttledRetries += 1;
        const need = cost?.requestedQueryCost ?? expected;
        const computed =
          need !== undefined && need !== null ? this.waitFor(access.connectionId, need) : 0;
        const wait = computed > 0 ? computed : DEFAULT_BACKOFF_MS;
        this.log('THROTTLED_RETRY', access, operation, {
          attempt: throttledRetries,
          waitMs: wait,
        });
        await this.sleep(wait);
        continue;
      }
      if (codes.length > 0 || parsed['errors'] !== undefined) throw graphqlError(codes);
      if (!('data' in parsed) || parsed['data'] === null) {
        throw new ShopifyRejectedError('GRAPHQL_ERROR', answer.status);
      }

      const apiVersion = answer.headers.get('x-shopify-api-version');
      const warnings: ShopifyWarning[] = [];
      if (apiVersion !== null && apiVersion !== SHOPIFY_API_VERSION) {
        warnings.push('API_VERSION_FELL_FORWARD');
        this.log('API_VERSION_FELL_FORWARD', access, operation, {});
      }
      return { data: parsed['data'], apiVersion, warnings, cost };
    }
  }

  /** The access token of a connection: the legacy token as is, or a cached or new exchange. */
  private async tokenFor(
    access: ShopifyConnectionAccess,
    state: ConnectionState,
    base: string,
  ): Promise<string> {
    const credentials = access.credentials;
    if (credentials.kind === 'access_token') return credentials.accessToken;
    const cached = state.token;
    if (
      cached &&
      cached.clientId === credentials.clientId &&
      this.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS
    ) {
      return cached.accessToken;
    }
    state.token = null;
    const answer = await this.withRateLimitRetry(access, { operationName: 'AccessToken' }, () =>
      this.send(`${base}/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }).toString(),
      }),
    );
    if (answer.status >= 500) throw new ShopifyTransientError('SERVER_ERROR', answer.status);
    if (answer.status >= 400) throw new ShopifyRejectedError(tokenErrorCode(answer), answer.status);
    const parsed = parseJson(answer.text);
    const accessToken = isRecord(parsed) ? parsed['access_token'] : undefined;
    const expiresIn = isRecord(parsed) ? parsed['expires_in'] : undefined;
    if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresIn !== 'number') {
      throw new ShopifyTransientError('INVALID_RESPONSE', answer.status);
    }
    state.token = {
      clientId: credentials.clientId,
      accessToken,
      expiresAt: this.now() + expiresIn * 1_000,
    };
    return accessToken;
  }

  /** Sends, and on HTTP 429 waits `Retry-After` (or 1 second) and sends again, up to 5 times. */
  private async withRateLimitRetry(
    access: ShopifyConnectionAccess,
    operation: Pick<ShopifyOperation, 'operationName'>,
    send: () => Promise<RawAnswer>,
  ): Promise<RawAnswer> {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await send();
      if (answer.status !== 429) return answer;
      if (attempt >= MAX_THROTTLE_RETRIES) throw new ShopifyTransientError('RATE_LIMITED', 429);
      const wait = retryAfterMs(answer.headers.get('retry-after'));
      this.log('RATE_LIMITED_RETRY', access, operation, { attempt: attempt + 1, waitMs: wait });
      await this.sleep(wait);
    }
  }

  /** One HTTP exchange with the timeout around the body read too; network failures are codes. */
  private async send(url: string, init: RequestInit): Promise<RawAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const doFetch = this.options.fetch ?? globalThis.fetch;
      const response = await doFetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (error instanceof ShopifyClientError) throw error;
      if (controller.signal.aborted) throw new ShopifyTransientError('TIMEOUT');
      // Any other throw of fetch (refused, reset, DNS) is a network failure; its text is dropped.
      if (error instanceof Error && error.name === 'UnrecordedRequest') throw error;
      throw new ShopifyTransientError('NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  /** The origin calls go to: the mock origin, else the shop, after the shop domain shape check. */
  private baseUrl(shopDomain: string): string {
    if (!SHOP_DOMAIN.test(shopDomain)) throw new ShopifyRejectedError('INVALID_SHOP_DOMAIN');
    return this.options.mockOrigin?.replace(/\/+$/, '') ?? `https://${shopDomain}`;
  }

  /** Keeps the throttle reading and the operation's actual cost. */
  private remember(state: ConnectionState, operationName: string, cost: ShopifyQueryCost | null) {
    if (!cost) return;
    if (cost.throttleStatus) state.throttle = { ...cost.throttleStatus, readAt: this.now() };
    if (cost.actualQueryCost !== null)
      state.lastActualCost.set(operationName, cost.actualQueryCost);
  }

  /** A log line of codes, ids, and numbers only. */
  private log(
    code: string,
    access: ShopifyConnectionAccess,
    operation: Pick<ShopifyOperation, 'operationName'>,
    numbers: Readonly<Record<string, number>>,
  ): void {
    const extra = Object.entries(numbers)
      .map(([key, value]) => ` ${key}=${value}`)
      .join('');
    this.logger.warn(
      `${code} connection=${access.connectionId} operation=${operation.operationName}${extra}`,
    );
  }
}

/**
 * Throws `ShopifyRejectedError('USER_ERRORS')` when a mutation answered `userErrors`, keeping only
 * their `code` values (shape checked); `message` and `field` may echo the input and are dropped.
 */
export function rejectUserErrors(userErrors: unknown): void {
  if (!Array.isArray(userErrors) || userErrors.length === 0) return;
  const codes = userErrors
    .map((entry: unknown) => (isRecord(entry) ? entry['code'] : undefined))
    .filter((code): code is string => typeof code === 'string' && CODE_SHAPE.test(code));
  throw new ShopifyRejectedError('USER_ERRORS', null, codes);
}

/** Throws for a non 2xx GraphQL status (401 and 429 are handled before this). */
function throwForStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status >= 500) throw new ShopifyTransientError('SERVER_ERROR', status);
  if (status === 402 || status === 403 || status === 423) {
    throw new ShopifyRejectedError('SHOP_UNAVAILABLE', status);
  }
  if (status === 404) throw new ShopifyRejectedError('NOT_FOUND', status);
  throw new ShopifyRejectedError('REQUEST_REJECTED', status);
}

/**
 * The code of a refused token exchange. Shopify names the cause in the body
 * (`shop_not_permitted`, documented; `app_not_installed` and `invalid_client`, per spec 0015): the
 * text is searched for those names only and never kept. Any other 4xx means the keys were refused.
 */
function tokenErrorCode(answer: RawAnswer): ShopifyRejectedCode {
  if (/\bapp_not_installed\b/.test(answer.text)) return 'APP_NOT_INSTALLED';
  if (/\bshop_not_permitted\b/.test(answer.text)) return 'APP_ORGANIZATION_MISMATCH';
  return 'CREDENTIALS_REJECTED';
}

/** The error for a GraphQL `errors` list other than `THROTTLED`. */
function graphqlError(codes: readonly string[]): ShopifyClientError {
  if (codes.includes('INTERNAL_SERVER_ERROR'))
    return new ShopifyTransientError('SERVER_ERROR', 200);
  if (codes.includes('MAX_COST_EXCEEDED')) {
    return new ShopifyRejectedError('QUERY_TOO_COSTLY', 200, codes);
  }
  if (codes.includes('ACCESS_DENIED')) return new ShopifyRejectedError('ACCESS_DENIED', 200, codes);
  if (codes.includes('SHOP_INACTIVE')) {
    return new ShopifyRejectedError('SHOP_UNAVAILABLE', 200, codes);
  }
  return new ShopifyRejectedError('GRAPHQL_ERROR', 200, codes);
}

/** `errors[].extensions.code` values of an answer, shape checked. */
function errorCodes(body: Record<string, unknown>): string[] {
  const errors = body['errors'];
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry: unknown) => {
      const extensions = isRecord(entry) ? entry['extensions'] : undefined;
      return isRecord(extensions) ? extensions['code'] : undefined;
    })
    .filter((code): code is string => typeof code === 'string' && CODE_SHAPE.test(code));
}

/** `extensions.cost` of an answer, or null when absent or malformed. */
function readCost(body: Record<string, unknown>): ShopifyQueryCost | null {
  const extensions = body['extensions'];
  const cost = isRecord(extensions) ? extensions['cost'] : undefined;
  if (!isRecord(cost)) return null;
  const status = cost['throttleStatus'];
  const throttleStatus =
    isRecord(status) &&
    isNumber(status['maximumAvailable']) &&
    isNumber(status['currentlyAvailable']) &&
    isNumber(status['restoreRate'])
      ? {
          maximumAvailable: status['maximumAvailable'],
          currentlyAvailable: status['currentlyAvailable'],
          restoreRate: status['restoreRate'],
        }
      : null;
  return {
    requestedQueryCost: isNumber(cost['requestedQueryCost']) ? cost['requestedQueryCost'] : null,
    actualQueryCost: isNumber(cost['actualQueryCost']) ? cost['actualQueryCost'] : null,
    throttleStatus,
  };
}

/** `Retry-After` in milliseconds (seconds, possibly fractional), else Shopify's 1 second. */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : DEFAULT_BACKOFF_MS;
}

/** JSON text parsed, or undefined; the text itself never leaves this function. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
