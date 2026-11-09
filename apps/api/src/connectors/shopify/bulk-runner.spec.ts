import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BulkRunner, type BulkPosition } from './bulk-runner.js';
import { ConnectorBudget } from './connector-budget.js';
import { ConnectorClock } from './connector-clock.js';
import { ShopifyClient, type ShopifyConnectionAccess } from './shopify-client.js';

const ACCESS = {
  connectionId: 'c1',
  shopDomain: 'fixture-store.myshopify.com',
  credentials: { kind: 'client_credentials', clientId: 'id', clientSecret: 'secret' },
} as unknown as ShopifyConnectionAccess;
const BULK = 'gid://shopify/BulkOperation/3330000099001';
const URL_SIGNED = 'https://storage.fixture.example/bulk/runner.jsonl';

/** Three orders of two lines each (root, line item): lines 0 to 5. */
const LINES = [1, 2, 3].flatMap((n) => [
  JSON.stringify({ id: `gid://shopify/Order/${n}` }),
  JSON.stringify({ id: `gid://shopify/LineItem/${n}`, __parentId: `gid://shopify/Order/${n}` }),
]);

/** The address of a fetch input. */
const addressOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A fetch answering the bulk read as completed and the result file, counting downloads. */
function fakeFetch(status = 'COMPLETED') {
  const downloads: number[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    await Promise.resolve();
    const url = addressOf(input);
    if (url === URL_SIGNED) {
      downloads.push(1);
      // Split mid line so the reader has to join chunks.
      const text = `${LINES.join('\n')}\n`;
      const cut = Math.floor(text.length / 2);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text.slice(0, cut)));
          controller.enqueue(new TextEncoder().encode(text.slice(cut)));
          controller.close();
        },
      });
      expect(init?.headers).toBeUndefined();
      return new Response(body, { status: 200 });
    }
    const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      operationName?: string;
    };
    const data =
      sent.operationName === 'BulkOperationRunQuery'
        ? {
            bulkOperationRunQuery: {
              bulkOperation: { id: BULK, status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            bulkOperation: {
              id: BULK,
              status,
              errorCode: status === 'FAILED' ? 'ACCESS_DENIED' : null,
              objectCount: '6',
              url: URL_SIGNED,
            },
          };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-shopify-api-version': '2026-10' },
    });
  }) as typeof fetch;
  return { fetchFn, downloads };
}

/** A runner whose token exchange is pre answered by a static token, with a zero time budget. */
function runner(fetchFn: typeof fetch, chunkMillis: number) {
  const client = new ShopifyClient({
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      if (addressOf(input).endsWith('/admin/oauth/access_token')) {
        return new Response(
          JSON.stringify({ access_token: 'fixture-token', scope: '', expires_in: 86_399 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fetchFn(input, init);
    },
  });
  const budget = new ConnectorBudget();
  budget.chunkMillis = chunkMillis;
  return new BulkRunner(client, new ConnectorClock(), budget);
}

// Spec 0015 AC-17 (*Backfill, go live, and sweeps*): a chunk stopped after an object resumes at
// the next object's first line, with no object handled twice, streaming and never storing.
describe('BulkRunner', () => {
  it('starts the bulk query, then streams the result; a zero budget stops after each object and resumes at the next line', async () => {
    const { fetchFn, downloads } = fakeFetch();
    const run = runner(fetchFn, 0);
    const seen: string[] = [];
    const onObject = async (object: { root: Readonly<Record<string, unknown>>; line: number }) => {
      seen.push(`${String(object.root['id'])}@${object.line}`);
      await Promise.resolve();
    };
    const cost = { points: 0 };

    const started = await run.step(
      ACCESS,
      { bulkId: null, line: 0 },
      '{ orders { edges { node { id } } } }',
      onObject,
      cost,
    );
    expect(started).toEqual({ kind: 'wait', position: { bulkId: BULK, line: 0 } });

    const positions: BulkPosition[] = [];
    let position: BulkPosition = { bulkId: BULK, line: 0 };
    for (let chunk = 0; chunk < 5; chunk += 1) {
      const step = await run.step(ACCESS, position, 'unused once started', onObject, cost);
      if (step.kind === 'done') break;
      expect(step.kind).toBe('more');
      if (step.kind !== 'more') return;
      positions.push(step.position);
      position = step.position;
    }
    // Order 1 is lines 0 and 1: the chunk that handled it stopped at line N = 1 and the next
    // chunk began at line N + 1 = 2, and so on.
    expect(positions).toEqual([
      { bulkId: BULK, line: 2 },
      { bulkId: BULK, line: 4 },
    ]);
    expect(seen).toEqual([
      'gid://shopify/Order/1@0',
      'gid://shopify/Order/2@2',
      'gid://shopify/Order/3@4',
    ]);
    expect(downloads).toHaveLength(3);
  });

  it('hands every object in one chunk when the budget allows', async () => {
    const { fetchFn } = fakeFetch();
    const seen: unknown[] = [];
    const step = await runner(fetchFn, 60_000).step(
      ACCESS,
      { bulkId: BULK, line: 0 },
      'q',
      async (object) => {
        seen.push(object.root['id']);
        await Promise.resolve();
      },
      { points: 0 },
    );
    expect(step).toEqual({ kind: 'done', position: { bulkId: BULK, line: 6 } });
    expect(seen).toHaveLength(3);
  });

  it('ends a failed operation with its code and never downloads', async () => {
    const { fetchFn, downloads } = fakeFetch('FAILED');
    const step = await runner(fetchFn, 0).step(
      ACCESS,
      { bulkId: BULK, line: 0 },
      'q',
      async () => Promise.resolve(),
      { points: 0 },
    );
    expect(step).toEqual({ kind: 'failed', code: 'ACCESS_DENIED' });
    expect(downloads).toHaveLength(0);
  });

  it('keeps no file: no connector source imports the file system', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    for (const file of sources) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/from 'node:fs|from 'fs/);
    }
  });
});
