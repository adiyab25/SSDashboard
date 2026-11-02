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

    expect(await countMigrations(url)).toBe('1');
  });

  it('does nothing when run again on an up to date database', async () => {
    const url = await freshDatabase();
    await runMigrations(url);

    await runMigrations(url);

    expect(await countMigrations(url)).toBe('1');
  });

  // Two installs' migrate containers (or a retry) must never apply the same migration twice.
  it('lets concurrent runs finish without applying a migration twice', async () => {
    const url = await freshDatabase();

    await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);

    expect(await countMigrations(url)).toBe('1');
  });

  it('releases the advisory lock when it finishes', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    const locks = await query(url, "SELECT 1 FROM pg_locks WHERE locktype = 'advisory'");
    expect(locks).toHaveLength(0);
  });

  it('rejects when the database cannot be reached', async () => {
    await expect(runMigrations('postgres://nobody:nothing@127.0.0.1:1/none')).rejects.toThrow();
  });
});
