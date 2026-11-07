import { AUDIT_ACTION_CODES, AUDIT_ACTIONS, type AuditActionCode } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { pgArray } from '../src/database/sql.js';
import type { SeedStep } from './scale-seed.js';

// Simplifications of this seed (it loads volume and valid shapes, not a replayable history):
// - The entries of one correlation group (three in a row) share their actor and action; their
//   records differ. Nothing is undoable and nothing is undone.
// - `before` and `after` are small objects; no value is personal, so `personal_fields` stays empty.
// - The five indexes that are not unique are dropped before the load and rebuilt after it from
//   their own catalog definitions (`pg_get_indexdef`), so they are exactly the migrated ones,
//   but freshly packed rather than grown one insert at a time.

/**
 * How much audit history the scale seed loads (spec 0010, AC-17). `entries` must divide by
 * `chunk`; `people` are staff accounts the seed creates for the person actors.
 */
export interface AuditScaleSeed {
  entries: number;
  people: number;
  recordsPerType: number;
  operatingDays: number;
  chunk: number;
}

/**
 * The AC-17 load: 5,000,000 entries over about three years (1,095 operating days), 36 people,
 * and up to 250,000 records per record type, inserted 500,000 at a time.
 */
export const AUDIT_SCALE: AuditScaleSeed = {
  entries: 5_000_000,
  people: 36,
  recordsPerType: 250_000,
  operatingDays: 1_095,
  chunk: 500_000,
};

/** The hats a person entry carries, the same four the spec 0002 seed uses for tasks. */
const HATS = ['support', 'operations', 'warehouse', 'manager'];

/** The system jobs that write entries (names only; their job id is the correlation id). */
const JOBS = ['ledger.reconcile', 'connector.sync', 'settlement.match'];

/** Slots of the action spread: each code holds a share of them, at least one. */
const ACTION_SLOTS = 10_000;

/**
 * The registry's codes with how many of `ACTION_SLOTS` each holds: a Zipf spread with exponent
 * 2 in registry order, so the first code is common (about 60 in 100 entries) and the last ones
 * are rare (about 3 in 1,000), which gives the action and record type filters both a common and a
 * rare case.
 */
export function auditActionSpread(): { action: AuditActionCode; slots: number }[] {
  const weights = AUDIT_ACTION_CODES.map((_, i) => 1 / (i + 1) ** 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return AUDIT_ACTION_CODES.map((action, i) => ({
    action,
    slots: Math.max(1, Math.round((ACTION_SLOTS * (weights[i] ?? 0)) / total)),
  }));
}

/**
 * SQL for a stable version 4 uuid from a text: its md5 with the version and variant digits set,
 * so the contract's `z.uuid()` filters accept it (a bare md5 cast to uuid has neither).
 */
const uuidFrom = (text: string): string =>
  `overlay(overlay(md5(${text}) placing '4' from 13) placing '8' from 17)::uuid`;

function whole(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a whole number`);
  return value;
}

/**
 * Loads the spec 0010 audit load into `audit_entries` as the owner role on a scratch database,
 * in `INSERT ... SELECT generate_series` statements: staff accounts for the person actors, then
 * the entries in time order over `operatingDays` days up to now. Every check, the foreign key,
 * and the append only and undo triggers still run; only the three stamp triggers
 * (`audit_entries_0_stamp_recorded_at`, `audit_entries_1_stamp_id`,
 * `audit_entries_stamp_operating_day`) are turned off for the insert, so planted instants and
 * time ordered ids can spread over three years (spec 0010 task 1 note), and they are always turned
 * back on. The seed fills `operating_day` with `ssd_operating_day`, the function the trigger
 * calls, so each day is the one the trigger would stamp (the triggers, plpgsql with their own
 * `search_path`, cost about five times the rest of an insert). Actors: 70 in 100 groups a person under a hat, 15 a
 * system job, 5 each a carrier, an import, and a portal customer. Returns the time each step took.
 */
export async function seedAuditScale(
  owner: DatabaseConnection,
  seed: AuditScaleSeed,
): Promise<SeedStep[]> {
  const entries = whole('entries', seed.entries);
  const chunk = whole('chunk', seed.chunk);
  if (entries % chunk !== 0) throw new Error('entries must divide by chunk');
  const people = whole('people', seed.people);
  const records = whole('recordsPerType', seed.recordsPerType);
  const spanSeconds = whole('operatingDays', seed.operatingDays) * 86_400;
  const spread = auditActionSpread();
  const slotCount = spread.reduce((sum, code) => sum + code.slots, 0);
  const steps: SeedStep[] = [];

  const client = await owner.pool.connect();
  try {
    await client.query('SET synchronous_commit = off');
    await client.query("SET maintenance_work_mem = '512MB'");
    const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
      const started = performance.now();
      await run();
      steps.push({ name, seconds: (performance.now() - started) / 1000 });
    };

    await step('audit people', () =>
      client.query(
        `INSERT INTO users (name, email)
         SELECT 'Scale auditor ' || g, 'scale-auditor-' || lpad(g::text, 3, '0') || '@example.test'
         FROM generate_series(1, ${people}) g`,
      ),
    );

    const { rows: indexes } = await client.query<{ name: string; definition: string }>(
      `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'audit_entries'::regclass AND NOT i.indisunique ORDER BY c.relname`,
    );
    await step('audit drop indexes', () =>
      client.query(indexes.map((index) => `DROP INDEX "${index.name}"`).join('; ')),
    );

    const { rows: clock } = await client.query<{ now: string }>('SELECT now()::text AS now');
    const end = clock[0]?.now;
    if (!end) throw new Error('no clock reading');

    // Security review AS1: an entry's instant and id belong to the database. The seed plants a
    // history spread over three years, so it turns the stamps off as the owner for this load and
    // always turns them back on.
    await client.query(
      `ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_0_stamp_recorded_at,
                                 DISABLE TRIGGER audit_entries_1_stamp_id,
                                 DISABLE TRIGGER audit_entries_stamp_operating_day`,
    );
    try {
      await step('audit entries', async () => {
        for (let from = 1; from <= entries; from += chunk) {
          await client.query(
            `WITH acts AS (
               SELECT a.action, a.record_type, a.slots,
                      coalesce(sum(a.slots) OVER (ORDER BY a.ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS lo
               FROM unnest($2::text[], $3::text[], $4::int[]) WITH ORDINALITY AS a(action, record_type, slots, ord)
             ),
             slots AS (
               SELECT s AS slot, acts.action, acts.record_type
               FROM acts CROSS JOIN LATERAL generate_series(acts.lo, acts.lo + acts.slots - 1) s
             ),
             people AS (
               SELECT array_agg(id ORDER BY email) AS a FROM users WHERE email LIKE 'scale-auditor-%'
             ),
             e AS (
               SELECT n, n / 3 AS g,
                      ((${entries} - n)::float8 * ${spanSeconds}.0 / ${entries}) * interval '1 second' AS ago
               FROM generate_series(${from}::bigint, ${from + chunk - 1}::bigint) n
             ),
             x AS (
               SELECT e.n, e.g, e.ago, ((e.g * 2654435761) % ${slotCount})::int AS slot,
                      (e.g % 20)::int AS who,
                      ${uuidFrom("'scale-correlation:' || e.g")} AS correlation_id,
                      (e.n * 40503 + 7) % ${records} AS r
               FROM e
             )
             INSERT INTO audit_entries (id, recorded_at, operating_day, correlation_id, actor_kind, actor_user_id,
                                        actor_ref, job_id, actor_hat, action, record_type, record_id,
                                        record_label, before, after, reason)
             SELECT uuidv7(-x.ago), $1::timestamptz - x.ago,
                    public.ssd_operating_day($1::timestamptz - x.ago), x.correlation_id,
                    CASE WHEN x.who < 14 THEN 'person' WHEN x.who < 17 THEN 'system_job'
                         WHEN x.who = 17 THEN 'carrier' WHEN x.who = 18 THEN 'import'
                         ELSE 'portal_customer' END,
                    CASE WHEN x.who < 14 THEN p.a[(1 + (x.g * 7919) % ${people})::int] END,
                    CASE WHEN x.who < 14 THEN NULL
                         WHEN x.who < 17 THEN ($5::text[])[(1 + x.g % ${JOBS.length})::int]
                         WHEN x.who = 17 THEN 'bosta'
                         WHEN x.who = 18 THEN 'scale-import-' || (x.g / 1000)
                         ELSE ${uuidFrom("'scale-customer:' || x.g % 50000")}::text END,
                    CASE WHEN x.who BETWEEN 14 AND 16 THEN x.correlation_id END,
                    CASE WHEN x.who < 14 THEN ($6::text[])[(1 + x.g % ${HATS.length})::int] END,
                    s.action, s.record_type, ${uuidFrom("s.record_type || ':' || x.r")},
                    'SCALE-' || x.r,
                    CASE WHEN x.n % 5 <> 0 THEN jsonb_build_object('status', 'draft', 'quantity', x.n % 97) END,
                    jsonb_build_object('status', 'posted', 'quantity', (x.n + 1) % 97),
                    CASE WHEN x.n % 4 = 0 THEN 'Scale reason ' || x.n % 100 END
             FROM x JOIN slots s ON s.slot = x.slot CROSS JOIN people p
             ORDER BY x.n`,
            [
              end,
              pgArray(spread.map((code) => code.action)),
              pgArray(spread.map((code) => AUDIT_ACTIONS[code.action].recordType)),
              pgArray(spread.map((code) => code.slots)),
              pgArray(JOBS),
              pgArray(HATS),
            ],
          );
        }
      });
    } finally {
      await client.query(
        `ALTER TABLE audit_entries ENABLE TRIGGER audit_entries_0_stamp_recorded_at,
                                   ENABLE TRIGGER audit_entries_1_stamp_id,
                                   ENABLE TRIGGER audit_entries_stamp_operating_day`,
      );
    }

    await step('audit rebuild indexes', async () => {
      for (const index of indexes) await client.query(index.definition);
    });
    await step('audit analyze', () => client.query('ANALYZE audit_entries'));
  } finally {
    client.release();
  }
  return steps;
}
