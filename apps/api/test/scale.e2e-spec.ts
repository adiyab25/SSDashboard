import { randomUUID } from 'node:crypto';
import { APP_ROLE, sql } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSkuListSql } from '../src/catalog/catalog.service.js';
import { ledgerHarness, posting, type LedgerHarness } from './ledger.js';
import { randomScaleKeys, seedScale } from './scale-seed.js';
import { freePort, signInAs, start, stop, waitForHttp, type RunningProcess } from './support.js';

const SKUS = 100_000;
const MOVEMENTS = 1_000_000;
const RUNS = 200;
const WARMUP = 20;
const TARGET_MS = 50;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function timeEach<T>(inputs: T[], run: (input: T) => Promise<unknown>): Promise<number[]> {
  const samples: number[] = [];
  for (const input of inputs) {
    const start = performance.now();
    await run(input);
    samples.push(performance.now() - start);
  }
  return samples;
}

// Spec 0002, AC-14: full catalog size on the dev PostgreSQL.
describe('ledger at scale', { timeout: 600_000 }, () => {
  let h: LedgerHarness;
  let keys: { variantId: string; locationId: string }[];
  beforeAll(async () => {
    h = await ledgerHarness();
    await seedScale(h.owner, { skus: SKUS, movements: MOVEMENTS, locations: 20 });
    keys = await randomScaleKeys(h.owner, RUNS + WARMUP);
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  it('holds 100,000 SKUs and 1,000,000 movements', async () => {
    const { rows } = await h.owner.pool.query<{ skus: number; movements: number }>(
      `SELECT (SELECT count(*) FROM product_variants)::int AS skus,
              (SELECT count(*) FROM stock_movements)::int AS movements`,
    );

    expect(rows[0]?.skus).toBeGreaterThanOrEqual(SKUS);
    expect(rows[0]?.movements).toBeGreaterThanOrEqual(MOVEMENTS);
  });

  it(`reads on hand and available for one SKU across all locations in under ${TARGET_MS} ms at p95`, async () => {
    await timeEach(keys.slice(0, WARMUP), (key) =>
      h.ledger.getAvailable({ variantId: key.variantId }),
    );

    const samples = await timeEach(keys.slice(WARMUP), (key) =>
      h.ledger.getAvailable({ variantId: key.variantId }),
    );

    console.log(`getAvailable p95: ${p95(samples).toFixed(1)} ms`);
    expect(p95(samples)).toBeLessThan(TARGET_MS);
  });

  it(`posts a single line in under ${TARGET_MS} ms at p95`, async () => {
    const post = (key: { variantId: string; locationId: string }) =>
      h.ledger.post(posting([{ ...key, quantity: 1, unitCost: '2.5000' }]));
    await timeEach(keys.slice(0, WARMUP), post);

    const samples = await timeEach(keys.slice(WARMUP), post);

    console.log(`post p95: ${p95(samples).toFixed(1)} ms`);
    expect(p95(samples)).toBeLessThan(TARGET_MS);
  });

  // Spec 0006, AC-18: the same seed, through the real HTTP endpoints, as an admin (cost fields on).
  describe('core stock loop endpoints', () => {
    const SAMPLES = 25;
    let api: RunningProcess | undefined;
    let base: string;
    let admin: string;

    beforeAll(async () => {
      // The built api, as the application role, on the same seeded scratch database (AC-18).
      const appUrl = new URL(h.owner.pool.options.connectionString as string);
      appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      api = start('main.js', {
        PORT: String(port),
        DATABASE_URL: appUrl.toString(),
        PUBLIC_URL: base,
      });
      await waitForHttp(`${base}/api/health`, api);
      admin = await signInAs(base, h.owner.pool, { email: 'admin@example.com', role: 'admin' });
    }, 120_000);

    afterAll(async () => {
      await stop(api);
    });
    const results: { name: string; p95: number; target: number }[] = [];

    async function get(path: string): Promise<unknown> {
      const response = await fetch(`${base}/api${path}`, {
        headers: { cookie: admin, origin: base },
      });
      expect(response.status, path).toBe(200);
      return response.json();
    }

    async function measure(
      name: string,
      target: number,
      inputs: string[],
      run: (input: string) => Promise<unknown>,
    ) {
      await timeEach(inputs.slice(0, WARMUP), run);
      const samples = await timeEach(inputs.slice(WARMUP, WARMUP + SAMPLES), run);
      const value = p95(samples);
      results.push({ name, p95: value, target });
      console.log(`${name} p95: ${value.toFixed(1)} ms (target ${target} ms)`);
      expect(value).toBeLessThan(target);
    }

    async function sample(text: string, values: unknown[] = []): Promise<Record<string, string>[]> {
      const { rows } = await h.owner.pool.query<Record<string, string>>(text, values);
      return rows;
    }

    afterAll(() => {
      console.table(results.map((r) => ({ ...r, p95: Number(r.p95.toFixed(1)) })));
    });

    it('lists the first page of stock in under 200 ms at p95', async () => {
      const first = (await get('/stock')) as { items: unknown[] };
      expect(first.items).toHaveLength(50);
      await measure('GET /stock first page', 200, Array<string>(WARMUP + SAMPLES).fill(''), () =>
        get('/stock'),
      );
    });

    it("reads one SKU's stock per location in under 200 ms at p95", async () => {
      const ids = keys.map((key) => key.variantId);
      await measure('GET /skus/:id/stock', 200, ids, (id) => get(`/skus/${id}/stock`));
    });

    it('searches SKU codes by prefix in under 100 ms at p95', async () => {
      const rows = await sample(`SELECT sku FROM product_variants ORDER BY random() LIMIT $1`, [
        WARMUP + SAMPLES,
      ]);
      // As typed by a person: the start of a code, long enough to narrow it to a few.
      const prefixes = rows.map((row) => (row.sku as string).slice(0, 10));
      const hit = (await get(`/skus?q=${encodeURIComponent(prefixes[0] as string)}`)) as {
        items: unknown[];
      };
      expect(hit.items.length).toBeGreaterThan(0);
      await measure('GET /skus?q=<prefix>', 100, prefixes, (q) =>
        get(`/skus?q=${encodeURIComponent(q)}`),
      );
    });

    it('plans the code prefix search as an index scan on product_variants_sku_c_idx', async () => {
      const [row] = await sample(`SELECT sku FROM product_variants ORDER BY random() LIMIT 1`);
      const q = (row?.sku as string).slice(0, 10);
      const { rows } = await h.owner.db.execute<{ 'QUERY PLAN': unknown[] }>(
        sql`EXPLAIN (FORMAT JSON) ${buildSkuListSql({ q, status: 'active', limit: 50 })}`,
      );
      const nodes: { 'Node Type': string; 'Index Name'?: string }[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if ('Node Type' in node) nodes.push(node as (typeof nodes)[number]);
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(walk);
          else walk(value);
        }
      };
      walk(rows[0]?.['QUERY PLAN']);
      console.log(
        `prefix plan nodes: ${nodes.map((n) => n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '')).join(' > ')}`,
      );
      expect(
        nodes.some(
          (n) =>
            n['Index Name'] === 'product_variants_sku_c_idx' &&
            ['Index Scan', 'Index Only Scan'].includes(n['Node Type']),
        ),
      ).toBe(true);
    });

    it('searches names by contains in under 500 ms at p95', async () => {
      // A word from the middle of a name that matches no code: the plain scan, worst case.
      const terms = Array.from(
        { length: WARMUP + SAMPLES },
        (_, i) => `product ${10_000 + ((i * 3_571) % 89_999)}`,
      );
      const hit = (await get(`/skus?q=${encodeURIComponent(terms[0] as string)}`)) as {
        items: unknown[];
      };
      expect(hit.items.length).toBeGreaterThan(0);
      await measure('GET /skus?q=<name part>', 500, terms, (q) =>
        get(`/skus?q=${encodeURIComponent(q)}`),
      );
    });

    it('posts a 200 line receipt in under 2 s at p95', async () => {
      const [location] = await sample(`SELECT id FROM locations WHERE code = 'SCALE-1'`);
      const variants = await sample(
        `SELECT id FROM product_variants WHERE sku LIKE 'SCALE-%' ORDER BY id LIMIT 200`,
      );
      expect(variants).toHaveLength(200);
      const body = JSON.stringify({
        locationId: location?.id,
        reference: 'scale',
        lines: variants.map((v) => ({ skuId: v.id, quantity: 1, unitCost: '2.5' })),
      });
      const post = async () => {
        const response = await fetch(`${base}/api/stock-receipts`, {
          method: 'POST',
          headers: {
            cookie: admin,
            origin: base,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body,
        });
        expect(response.status).toBe(201);
      };
      await measure(
        'POST /stock-receipts (200 lines)',
        2_000,
        Array<string>(WARMUP + SAMPLES).fill(''),
        post,
      );
    });
  });
});
