import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0015 task 8 (security review M1 of the channel upsert, migration 0021): the product apply
// and delete read a product's variant mappings by `state->>'productId'`; the partial expression
// index serves that lookup instead of a scan of every mapping of the connection.
describe('connector mappings: the product variants lookup (0021)', () => {
  let name: string;
  let owner: pg.Client;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
  });

  it('has the partial expression index on (connection_id, state->>productId) for variants', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'connection_external_ids'
         AND indexname = 'connection_external_ids_product_variants_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(state ->> 'productId'::text)");
    expect(rows[0]?.indexdef).toContain("WHERE (entity = 'variant'::external_entity)");
  });

  it("is the plan for the product apply's variant lookup", async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL enable_seqscan = off');
      const { rows } = await owner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM connection_external_ids
         WHERE connection_id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'::uuid AND entity = 'variant'
           AND state->>'productId' = 'gid://shopify/Product/2220000081001'`,
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('connection_external_ids_product_variants_idx');
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
