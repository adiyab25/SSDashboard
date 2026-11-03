import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerHarness, posting, type LedgerHarness } from './ledger.js';
import { randomScaleKeys, seedScale } from './scale-seed.js';

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
});
