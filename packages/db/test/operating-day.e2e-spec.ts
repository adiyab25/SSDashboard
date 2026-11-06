import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002, A3 (AC-17): the operating day is the brand's Cairo calendar day, stamped by trigger.
// The offset changes are found in the time zone data of the PostgreSQL under test, never hard coded.
describe('operating day (AC-17)', () => {
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

  /** `ssd_operating_day` of an instant, as `YYYY-MM-DD`. */
  async function dayOf(instant: string): Promise<string> {
    const { rows } = await owner.query<{ day: string }>(
      "SELECT to_char(ssd_operating_day($1::timestamptz), 'YYYY-MM-DD') AS day",
      [instant],
    );
    return rows[0]?.day ?? '';
  }

  /** The local calendar day of an instant in Cairo, computed independently of the function. */
  async function cairoDate(instant: string): Promise<string> {
    const { rows } = await owner.query<{ day: string }>(
      "SELECT to_char(($1::timestamptz AT TIME ZONE 'Africa/Cairo')::date, 'YYYY-MM-DD') AS day",
      [instant],
    );
    return rows[0]?.day ?? '';
  }

  async function setCutoff(hour: number): Promise<void> {
    await owner.query(
      "UPDATE settings SET value = to_jsonb($1::int) WHERE key = 'operating_day_cutoff_hour'",
      [hour],
    );
  }

  /** The instants (UTC, ISO) in the current year where Cairo's UTC offset changes, hourly stepped. */
  async function offsetChanges(): Promise<string[]> {
    const { rows } = await owner.query<{ at: string }>(`
      WITH hours AS (
        SELECT h,
               extract(epoch FROM (h AT TIME ZONE 'Africa/Cairo') - (h AT TIME ZONE 'UTC')) AS off,
               lag(extract(epoch FROM (h AT TIME ZONE 'Africa/Cairo') - (h AT TIME ZONE 'UTC'))) OVER (ORDER BY h) AS prev
        FROM generate_series(
          make_timestamptz(extract(year FROM now())::int, 1, 1, 0, 0, 0, 'UTC'),
          make_timestamptz(extract(year FROM now())::int + 1, 1, 1, 0, 0, 0, 'UTC'),
          interval '1 hour') AS h)
      SELECT to_char(h AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
      FROM hours WHERE prev IS NOT NULL AND off <> prev ORDER BY h`);
    return rows.map((row) => row.at);
  }

  it('is the Cairo calendar day on an ordinary day, at 23:59:59 and 00:00:00 local', async () => {
    // January: UTC+2 whenever Egypt is off summer time, +3 otherwise; ask the zone, not a constant.
    const { rows } = await owner.query<{ before: string; after: string }>(`
      SELECT to_char(('2026-01-15 23:59:59'::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS before,
             to_char(('2026-01-16 00:00:00'::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS after`);
    expect(await dayOf(rows[0]?.before ?? '')).toBe('2026-01-15');
    expect(await dayOf(rows[0]?.after ?? '')).toBe('2026-01-16');
  });

  it('follows the Cairo calendar one second before, at, and after every offset change', async () => {
    const changes = await offsetChanges();
    if (changes.length === 0) {
      console.info(
        'operating-day: no Cairo offset change found this year; transition cases skipped',
      );
    }
    for (const change of changes) {
      const at = new Date(change).getTime();
      for (const instant of [at - 1000, at, at + 1000].map((ms) => new Date(ms).toISOString())) {
        expect(await dayOf(instant), `at ${instant}`).toBe(await cairoDate(instant));
      }
    }
  });

  it('moves a 01:30 local instant to the previous day when the cutoff hour is 2', async () => {
    const { rows } = await owner.query<{ at: string }>(`
      SELECT to_char(('2026-01-16 01:30:00'::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`);
    const instant = rows[0]?.at ?? '';
    await setCutoff(2);
    try {
      expect(await dayOf(instant)).toBe('2026-01-15');
    } finally {
      await setCutoff(0);
    }
    expect(await dayOf(instant)).toBe('2026-01-16');
  });

  it('stamps movement groups and movements from effective_at, ignoring what a writer passes', async () => {
    const variant = await owner.query<{ id: string }>(
      `WITH p AS (INSERT INTO products (style_code, product_group_id, name)
                  VALUES ('OD-1', (SELECT id FROM product_groups WHERE code = 'MAIN'), '{"en": "x"}') RETURNING id)
       INSERT INTO product_variants (product_id, sku, base_uom_id)
       SELECT id, 'OD-1', (SELECT id FROM uoms WHERE code = 'pc') FROM p RETURNING id`,
    );
    const place = await owner.query<{ id: string }>(
      "INSERT INTO locations (code, name, kind) VALUES ('OD-WH', '{\"en\": \"x\"}', 'warehouse') RETURNING id",
    );
    const instant = '2026-01-15T22:30:00Z'; // 00:30 on the 16th in Cairo (UTC+2 in January)
    const group = await owner.query<{ id: string; day: string }>(
      `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at, operating_day)
       VALUES ('od-1', 'h', 'adjustment', uuidv7(), $1, '1999-01-01')
       RETURNING id, to_char(operating_day, 'YYYY-MM-DD') AS day`,
      [instant],
    );
    expect(group.rows[0]?.day).toBe(await dayOf(instant));
    const movement = await owner.query<{ day: string }>(
      `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, recorded_at)
       VALUES ($1, $2, $3, 1, 1, 1, $4, now()) RETURNING to_char(operating_day, 'YYYY-MM-DD') AS day`,
      [group.rows[0]?.id, variant.rows[0]?.id, place.rows[0]?.id, instant],
    );
    expect(movement.rows[0]?.day).toBe(await dayOf(instant));
    expect(movement.rows[0]?.day).toBe(await cairoDate(instant));
  });
});
