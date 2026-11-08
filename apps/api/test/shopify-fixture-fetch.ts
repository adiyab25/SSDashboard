import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The refusing `fetch` of spec 0015 (AC-26): installed by the api's vitest setup files
 * (`shopify-fixture-setup.ts`), it answers only requests recorded under
 * `src/connectors/shopify/fixtures/` for the scenarios a test loaded, and throws
 * `UnrecordedRequest` for any other request that is not to a loopback address. So no test can
 * reach Shopify, and an unexpected call fails the test.
 *
 * Matching (spec 0015, *Fixtures and the mock server*): method, URL path (the host is ignored, so
 * `SHOPIFY_MOCK_ORIGIN` and `https://<shop>` match alike), GraphQL operation name, and variables
 * (compared as canonical JSON; no variables and `{}` are the same). A request recorded more than
 * once is answered by the files in file order, each once. Loopback requests (`localhost`,
 * `127.0.0.1`, `::1`) pass to the real `fetch`: the e2e suites call their own api that way.
 */

/** The fixtures folder. */
export const SHOPIFY_FIXTURES_DIR = fileURLToPath(
  new URL('../src/connectors/shopify/fixtures/', import.meta.url),
);

/** A request no loaded recording answers. Its message names the method, path, and operation only. */
export class UnrecordedRequest extends Error {
  /** @param what - `METHOD /path operation`, never a body or a header. */
  constructor(what: string) {
    super(`No recorded Shopify fixture answers ${what}`);
    this.name = 'UnrecordedRequest';
  }
}

/** One recorded exchange as the fixture files hold it (the `_fixture` banner is ignored). */
export interface RecordedExchange {
  /** The file, relative to the fixtures folder. */
  readonly file: string;
  /** What was asked. */
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly operationName: string | null;
    readonly variables: unknown;
  };
  /** What Shopify answered. */
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
}

/** Narrows a parsed file to an exchange, or throws naming the file. */
function asExchange(file: string, parsed: unknown): RecordedExchange {
  const fail = (why: string): never => {
    throw new Error(`Shopify fixture ${file}: ${why}`);
  };
  if (typeof parsed !== 'object' || parsed === null) return fail('not an object');
  const { request, response } = parsed as { request?: unknown; response?: unknown };
  if (typeof request !== 'object' || request === null) return fail('no request');
  if (typeof response !== 'object' || response === null) return fail('no response');
  const req = request as Record<string, unknown>;
  const res = response as Record<string, unknown>;
  if (typeof req['method'] !== 'string' || typeof req['url'] !== 'string') {
    return fail('request.method and request.url are required');
  }
  if (typeof res['status'] !== 'number') return fail('response.status is required');
  const operationName = req['operationName'];
  return {
    file,
    request: {
      method: req['method'],
      url: req['url'],
      operationName: typeof operationName === 'string' ? operationName : null,
      variables: req['variables'] ?? null,
    },
    response: {
      status: res['status'],
      headers: (res['headers'] ?? {}) as Record<string, string>,
      body: res['body'] ?? null,
    },
  };
}

/** Every fixture file, relative to the fixtures folder, sorted (`<scenario>/NN-<operation>.json`). */
export function listShopifyFixtureFiles(): string[] {
  return readdirSync(SHOPIFY_FIXTURES_DIR, { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.json'))
    .sort();
}

/** Reads one fixture file. */
export function readShopifyFixture(file: string): RecordedExchange {
  const parsed = JSON.parse(readFileSync(join(SHOPIFY_FIXTURES_DIR, file), 'utf8')) as unknown;
  return asExchange(file, parsed);
}

/** A scenario's exchanges in file order; throws when the scenario folder is empty or missing. */
export function loadShopifyScenario(scenario: string): RecordedExchange[] {
  const files = listShopifyFixtureFiles().filter((file) => file.startsWith(`${scenario}/`));
  if (files.length === 0) throw new Error(`No Shopify fixture scenario named ${scenario}`);
  return files.map(readShopifyFixture);
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** No variables and an empty object are the same request. */
function variablesKey(variables: unknown): string {
  const empty =
    variables === null ||
    variables === undefined ||
    (typeof variables === 'object' && Object.keys(variables).length === 0);
  return empty ? 'null' : canonical(variables);
}

/** The match key of a request. */
function keyOf(method: string, path: string, operationName: string | null, variables: unknown) {
  return `${method.toUpperCase()} ${path} ${operationName ?? '-'} ${variablesKey(variables)}`;
}

/** The operation name and variables of a GraphQL JSON body; nulls for any other body. */
function graphqlParts(body: string | null): { operationName: string | null; variables: unknown } {
  if (body === null) return { operationName: null, variables: null };
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null)
      return { operationName: null, variables: null };
    const { operationName, variables } = parsed as { operationName?: unknown; variables?: unknown };
    return {
      operationName: typeof operationName === 'string' ? operationName : null,
      variables: variables ?? null,
    };
  } catch {
    // A form body (the token exchange): matched on method and path only.
    return { operationName: null, variables: null };
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A `fetch` that answers loaded recordings, with `load`, `reset`, and `remaining` for tests. */
export interface ShopifyFixtureFetch {
  /** The `fetch` replacement. */
  readonly fetch: typeof fetch;
  /** Adds scenarios' exchanges to the queue, in the order given and file order inside each. */
  load(...scenarios: string[]): void;
  /** Drops every loaded exchange. */
  reset(): void;
  /** The files loaded but not yet served. */
  remaining(): string[];
}

/**
 * Builds the refusing fetch. `passThrough` serves loopback requests (the real fetch when
 * installed globally); without it a loopback request is refused too.
 */
export function createShopifyFixtureFetch(passThrough?: typeof fetch): ShopifyFixtureFetch {
  let queue: RecordedExchange[] = [];

  const replacement = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (LOOPBACK.has(url.hostname) && passThrough) return passThrough(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let body: string | null = null;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (input instanceof Request) body = await input.clone().text();
    const { operationName, variables } = graphqlParts(body);
    const key = keyOf(method, url.pathname, operationName, variables);
    const index = queue.findIndex(
      (exchange) =>
        keyOf(
          exchange.request.method,
          new URL(exchange.request.url).pathname,
          exchange.request.operationName,
          exchange.request.variables,
        ) === key,
    );
    const exchange = queue[index];
    if (!exchange) {
      throw new UnrecordedRequest(`${method.toUpperCase()} ${url.pathname} ${operationName ?? ''}`);
    }
    queue = queue.filter((_, i) => i !== index);
    const { status, headers, body: recorded } = exchange.response;
    const text = typeof recorded === 'string' ? recorded : JSON.stringify(recorded);
    return new Response(status === 204 ? null : text, { status, headers });
  };

  return {
    fetch: replacement,
    load: (...scenarios) => {
      for (const scenario of scenarios) queue.push(...loadShopifyScenario(scenario));
    },
    reset: () => {
      queue = [];
    },
    remaining: () => queue.map((exchange) => exchange.file),
  };
}

let installed: ShopifyFixtureFetch | undefined;

/**
 * Replaces the global `fetch` with the refusing fetch (loopback passes to the real one). Called
 * once per test file by the vitest setup files; calling it again keeps the first install.
 */
export function installShopifyFixtureFetch(): ShopifyFixtureFetch {
  if (!installed) {
    installed = createShopifyFixtureFetch(globalThis.fetch.bind(globalThis));
    globalThis.fetch = installed.fetch;
  }
  return installed;
}

/** Loads scenarios into the installed global fetch (see `ShopifyFixtureFetch.load`). */
export function useShopifyScenarios(...scenarios: string[]): void {
  installShopifyFixtureFetch().load(...scenarios);
}

/** Drops whatever a test loaded; the setup files call it after every test. */
export function resetShopifyScenarios(): void {
  installed?.reset();
}

/** The loaded files a test has not used yet (assert it is empty to prove every call happened). */
export function remainingShopifyExchanges(): string[] {
  return installed?.remaining() ?? [];
}
