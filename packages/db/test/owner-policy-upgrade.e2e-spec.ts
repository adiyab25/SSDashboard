import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/** Every policy row with all its attributes, in owner type order. */
const POLICY_ROWS = `SELECT owner_type, stock_owned_by_brand, handover_is_sale, sale_recorded_at,
  end_customer_refund_by, defective_piece_refund_by, tax_document, settlement_owner_type,
  can_sell_online, updated_at, updated_by FROM location_owner_policies ORDER BY owner_type`;

// Spec 0009 milestone 5, task 25 (owner ruling 2026-11-08, "Migration + checks"): an install
// migrated up to 0010 takes 0011 (the four policy CHECKs and `locked_terms_changed_at`, empty on
// every row) and 0012 (the app role's column grant) cleanly. Under 0010 the policy table holds
// exactly the three seeded rows and the app role may only read it (0002 revokes INSERT, UPDATE,
// DELETE, TRUNCATE), so the seeded rows are every row an install can legally hold; locations of
// every owner type, archived or selling online, sit beside them. The upgrade leaves every row as it
// was, and the CHECKs hold for it.
describe('the owner policy migrations upgrade an install at 0010', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let folder: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    // The history as it stood at 0010: a copy of the folder with the journal cut after it.
    folder = mkdtempSync(join(tmpdir(), 'ssd-migrations-'));
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 10);
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

  it('applies 0011 and 0012 over the rows of 0010, changing none, and the CHECKs hold', async () => {
    const appRole = (
      await owner.query<{ role: string }>(
        "SELECT coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app') AS role",
      )
    ).rows[0]?.role as string;
    // Under 0010 nobody but the owner may write a policy row.
    const writable = await owner.query<{ update: boolean; insert: boolean }>(
      `SELECT has_table_privilege($1, 'location_owner_policies', 'UPDATE') AS update,
              has_table_privilege($1, 'location_owner_policies', 'INSERT') AS insert`,
      [appRole],
    );
    expect(writable.rows[0]).toEqual({ update: false, insert: false });

    // Locations of every owner type beside the policies: active, archived, and selling online.
    const party = async (code: string, role: string) =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO parties (code, name, ${role}) VALUES ($1, 'P', true) RETURNING id`,
          [code],
        )
      ).rows[0]?.id as string;
    const partner = await party('UP-P', 'is_consignment_partner');
    const wholesale = await party('UP-W', 'is_wholesale_customer');
    await owner.query(
      `INSERT INTO locations (code, name, kind, owner_type, party_id, sellable_online, archived_at) VALUES
         ('UP-OWN', '{"en": "Own"}', 'shop', 'own', NULL, true, NULL),
         ('UP-OLD', '{"en": "Old"}', 'shop', 'own', NULL, false, now()),
         ('UP-PART', '{"en": "Partner"}', 'shop', 'consignment_partner', $1, false, NULL),
         ('UP-WHOLE', '{"en": "Wholesale"}', 'shop', 'wholesale_customer', $2, false, now())`,
      [partner, wholesale],
    );
    const before = (await owner.query(POLICY_ROWS)).rows;
    expect(before).toHaveLength(3);

    await runMigrations(url);

    expect((await owner.query(POLICY_ROWS)).rows).toEqual(before);
    // The new column starts empty: no locked term of a seeded row ever changed.
    const stamped = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM location_owner_policies WHERE locked_terms_changed_at IS NOT NULL',
    );
    expect(stamped.rows[0]?.n).toBe(0);
    const checks = await owner.query<{ conname: string; validated: boolean }>(
      `SELECT conname, convalidated AS validated FROM pg_constraint
       WHERE conrelid = 'location_owner_policies'::regclass AND contype = 'c' ORDER BY conname`,
    );
    expect(checks.rows).toEqual([
      { conname: 'location_owner_policies_consignment_settles_with_partner', validated: true },
      { conname: 'location_owner_policies_handover_is_sale', validated: true },
      { conname: 'location_owner_policies_online_needs_brand_stock', validated: true },
      { conname: 'location_owner_policies_sale_at_handover', validated: true },
    ]);
    const violating = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM location_owner_policies
       WHERE handover_is_sale <> NOT stock_owned_by_brand
          OR (sale_recorded_at = 'at_handover') <> handover_is_sale
          OR (can_sell_online AND NOT (stock_owned_by_brand AND settlement_owner_type IS NULL))
          OR (owner_type = 'consignment_partner' AND settlement_owner_type IS NULL)`,
    );
    expect(violating.rows[0]?.n).toBe(0);
    // The seeded consignment row settles with its partner, so the pin of 2026-11-08 holds for it.
    const consignment = await owner.query<{ settles: string | null }>(
      `SELECT settlement_owner_type::text AS settles FROM location_owner_policies
       WHERE owner_type = 'consignment_partner'`,
    );
    expect(consignment.rows).toEqual([{ settles: 'consignment_partner' }]);
    const granted = await owner.query<{
      refunds: boolean;
      locked: boolean;
      owner_type: boolean;
      insert: boolean;
    }>(
      `SELECT has_column_privilege($1, 'location_owner_policies', 'end_customer_refund_by', 'UPDATE') AS refunds,
              has_column_privilege($1, 'location_owner_policies', 'locked_terms_changed_at', 'UPDATE') AS locked,
              has_column_privilege($1, 'location_owner_policies', 'owner_type', 'UPDATE') AS owner_type,
              has_table_privilege($1, 'location_owner_policies', 'INSERT') AS insert`,
      [appRole],
    );
    expect(granted.rows[0]).toEqual({
      refunds: true,
      locked: true,
      owner_type: false,
      insert: false,
    });
  });
});
