import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

// Every migration in the journal, so adding one never makes this file stale.
const shipped = (
  JSON.parse(
    readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: unknown[] }
).entries.length;

const countMigrations = async (url: string) =>
  (await query<{ count: string }>(url, 'SELECT count(*) FROM drizzle.__drizzle_migrations'))[0]
    ?.count;

describe('runMigrations', () => {
  const scratch: string[] = [];

  async function freshDatabase(): Promise<string> {
    const db = await createScratchDatabase();
    scratch.push(db.name);
    return db.url;
  }

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dropScratchDatabase));
  });

  it('enables the pg_trgm and unaccent search extensions on an empty database', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    const extensions = await query<{ extname: string }>(url, 'SELECT extname FROM pg_extension');
    expect(extensions.map((row) => row.extname)).toEqual(
      expect.arrayContaining(['pg_trgm', 'unaccent']),
    );
  });

  it('records each applied migration once', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    expect(await countMigrations(url)).toBe(String(shipped));
  });

  it('does nothing when run again on an up to date database', async () => {
    const url = await freshDatabase();
    await runMigrations(url);

    await runMigrations(url);

    expect(await countMigrations(url)).toBe(String(shipped));
  });

  // Two installs' migrate containers (or a retry) must never apply the same migration twice.
  it('lets concurrent runs finish without applying a migration twice', async () => {
    const url = await freshDatabase();

    await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);

    expect(await countMigrations(url)).toBe(String(shipped));
  });

  it('releases the advisory lock when it finishes', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    const locks = await query(url, "SELECT 1 FROM pg_locks WHERE locktype = 'advisory'");
    expect(locks).toHaveLength(0);
  });

  // AC-22: existing postings that name no user are nulled out, the rest are kept, and the
  // ledger's append only trigger is back on afterwards.
  it('links posted_by to users, nulling orphans and keeping the append only trigger', async () => {
    const url = await freshDatabase();
    await runMigrations(url);
    const sqlFile = readFileSync(
      new URL('../migrations/0007_ledger_posted_by_user_fk.sql', import.meta.url),
      'utf8',
    );
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // Rewind to the state before 0007, then add one posting per kind of value.
      await client.query(
        'ALTER TABLE movement_groups DROP CONSTRAINT movement_groups_posted_by_users_id_fk',
      );
      const user = (
        await client.query<{ id: string }>(
          "INSERT INTO users (name, email) VALUES ('A', 'a@example.test') RETURNING id",
        )
      ).rows[0]?.id;
      const insertGroup = (key: string, postedBy: string | null) =>
        client.query(
          `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at, posted_by)
           VALUES ($1, 'h', 'count', uuidv7(), now(), $2)`,
          [key, postedBy],
        );
      await insertGroup('known', user ?? null);
      await insertGroup('orphan', '00000000-0000-4000-8000-000000000001');
      await insertGroup('none', null);

      await client.query('BEGIN');
      await client.query(sqlFile.replaceAll('--> statement-breakpoint', ''));
      await client.query('COMMIT');

      const rows = (
        await client.query<{ k: string; posted_by: string | null }>(
          'SELECT idempotency_key AS k, posted_by FROM movement_groups ORDER BY k',
        )
      ).rows;
      expect(rows).toEqual([
        { k: 'known', posted_by: user },
        { k: 'none', posted_by: null },
        { k: 'orphan', posted_by: null },
      ]);
      const constraint = await client.query(
        "SELECT convalidated FROM pg_constraint WHERE conname = 'movement_groups_posted_by_users_id_fk'",
      );
      expect(constraint.rows).toEqual([{ convalidated: true }]);
      const trigger = await client.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname = 'movement_groups_append_only'",
      );
      expect(trigger.rows).toEqual([{ tgenabled: 'O' }]);
      await expect(client.query('UPDATE movement_groups SET posted_by = NULL')).rejects.toThrow(
        /append only/,
      );
    } finally {
      await client.end();
    }
  });

  it('rejects when the database cannot be reached', async () => {
    await expect(runMigrations('postgres://nobody:nothing@127.0.0.1:1/none')).rejects.toThrow();
  });
});
