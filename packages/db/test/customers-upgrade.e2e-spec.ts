import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

// Spec 0014 milestone 1, expand and contract: a database that already holds a flagged customer
// (migrated up to 0005, before the flag had a set time) must take 0006 to 0008. The check of
// 0008 would refuse the row if 0007 had not given it a set time first.
describe('customers by phone upgrades a database that holds a flagged customer', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let folder: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    // The history as it stood at 0005: a copy of the folder with the journal cut after it.
    folder = mkdtempSync(join(tmpdir(), 'ssd-migrations-'));
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 5);
    writeFileSync(journalPath, JSON.stringify(journal));
    await runMigrations(url, { migrationsFolder: folder });
    owner = new pg.Client({ connectionString: url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('gives the flagged customer the time of its last change, then enforces the check', async () => {
    const flagged = await owner.query<{ id: string }>(
      `INSERT INTO customers (risk_flag, risk_flag_source, created_at, updated_at)
       VALUES ('refuser', 'blacklist_import', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
       RETURNING id`,
    );
    const plain = await owner.query<{ id: string }>(
      'INSERT INTO customers DEFAULT VALUES RETURNING id',
    );

    await runMigrations(url);

    const after = await owner.query<{ id: string; at: Date | null }>(
      'SELECT id, risk_flag_set_at AS at FROM customers WHERE id = ANY($1::uuid[])',
      [[flagged.rows[0]?.id, plain.rows[0]?.id]],
    );
    const byId = new Map(after.rows.map((row) => [row.id, row.at]));
    expect(byId.get(flagged.rows[0]?.id as string)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(byId.get(plain.rows[0]?.id as string)).toBeNull();
    await expect(
      owner.query("INSERT INTO customers (risk_flag, risk_flag_source) VALUES ('fake', 'manual')"),
    ).rejects.toThrow(/customers_risk_flag_has_set_at/);
  });
});
