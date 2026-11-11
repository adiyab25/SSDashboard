import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

// Spec 0011 milestone 1 (owner decision D3, review of 2026-11-08): an install migrated up to 0016
// that holds locations flagged online before the gate existed (a shop, a warehouse, an archived
// warehouse) takes 0017 to 0019 cleanly and ends with no online flag at all, so every brand turns
// its online location on again through the gate, and the new check and unique index never meet a
// row that breaks them.
describe('the online location migrations upgrade an install at 0016', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let folder: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    folder = mkdtempSync(join(tmpdir(), 'ssd-migrations-'));
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 16);
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

  it('clears every online flag, archived rows included, and keeps the rest of each row', async () => {
    await owner.query(
      `INSERT INTO locations (code, name, kind, sellable_online, archived_at) VALUES
         ('OF-SHOP', '{"en": "Shop"}', 'shop', true, NULL),
         ('OF-WH', '{"en": "Warehouse"}', 'warehouse', true, NULL),
         ('OF-WH2', '{"en": "Second"}', 'warehouse', true, NULL),
         ('OF-OLD', '{"en": "Archived"}', 'warehouse', true, now()),
         ('OF-OFF', '{"en": "Off"}', 'warehouse', false, NULL)`,
    );

    await runMigrations(url);

    const rows = await owner.query<{ code: string; online: boolean; archived: boolean }>(
      `SELECT code, sellable_online AS online, archived_at IS NOT NULL AS archived
       FROM locations WHERE code LIKE 'OF-%' ORDER BY code`,
    );
    expect(rows.rows).toEqual([
      { code: 'OF-OFF', online: false, archived: false },
      { code: 'OF-OLD', online: false, archived: true },
      { code: 'OF-SHOP', online: false, archived: false },
      { code: 'OF-WH', online: false, archived: false },
      { code: 'OF-WH2', online: false, archived: false },
    ]);
    const checks = await owner.query<{ conname: string; validated: boolean }>(
      `SELECT conname, convalidated AS validated FROM pg_constraint
       WHERE conrelid = 'locations'::regclass AND conname LIKE 'locations_online%' ORDER BY conname`,
    );
    expect(checks.rows).toEqual([
      { conname: 'locations_online_needs_warehouse', validated: true },
      { conname: 'locations_online_not_archived', validated: true },
    ]);
    // The rules now hold: an archived location cannot be online, a shop cannot, one warehouse can.
    await expect(
      owner.query("UPDATE locations SET sellable_online = true WHERE code = 'OF-OLD'"),
    ).rejects.toThrow(/locations_online_not_archived/);
    await expect(
      owner.query("UPDATE locations SET sellable_online = true WHERE code = 'OF-SHOP'"),
    ).rejects.toThrow(/locations_online_needs_warehouse/);
    await owner.query("UPDATE locations SET sellable_online = true WHERE code = 'OF-WH'");
    await expect(
      owner.query("UPDATE locations SET sellable_online = true WHERE code = 'OF-WH2'"),
    ).rejects.toThrow(/locations_one_online/);
  });
});
