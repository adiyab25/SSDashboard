import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTION_ROLE_NAMES } from '@ssdashboard/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

// Spec 0012 milestone 2, task 6: an install at 0014 takes 0015 (season and product group
// timestamps, the `option_role` enum and column, `product_variants_options_unique`) and 0016
// (the role backfill from each option's name). Every name of `OPTION_ROLE_NAMES`, in English or
// Arabic slot, typed with hamza, marks, or another case, gets its role; any other name `other`.
// So the migration's two lists and the contract agree.

/** A copy of the migration history cut after 0014, in a temporary folder the caller removes. */
function historyTo0014(): string {
  const folder = mkdtempSync(join(tmpdir(), 'ssd-migrations-'));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 14);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

describe('the catalog styles migrations upgrade an install at 0014', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let folder: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    folder = historyTo0014();
    await runMigrations(url, { migrationsFolder: folder });
    owner = new pg.Client({ connectionString: url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('backfills every option role from its name, keeps the rows, and stamps the timestamps', async () => {
    // One style per option, so up to 3 options per style never limits the fixture.
    const names: { name: Record<string, string>; role: string }[] = [
      ...OPTION_ROLE_NAMES.size.map((text) => ({ name: { en: text }, role: 'size' })),
      ...OPTION_ROLE_NAMES.color.map((text) => ({ name: { ar: text }, role: 'color' })),
      { name: { en: 'SIZE' }, role: 'size' },
      { name: { en: 'Colour', ar: 'لون' }, role: 'color' },
      { name: { ar: 'المَقاس' }, role: 'size' },
      { name: { ar: 'اللّون' }, role: 'color' },
      { name: { en: 'Fit' }, role: 'other' },
      { name: { en: 'Material', ar: 'الخامة' }, role: 'other' },
    ];
    const ids: string[] = [];
    for (const [i, option] of names.entries()) {
      const { rows } = await owner.query<{ id: string }>(
        `WITH style AS (
           INSERT INTO products (style_code, product_group_id, name)
           VALUES ($1, (SELECT id FROM product_groups WHERE code = 'MAIN'), '{"en":"Style"}')
           RETURNING id)
         INSERT INTO product_options (product_id, name, position, values)
         SELECT id, $2::jsonb, 0, '[]'::jsonb FROM style RETURNING id`,
        [`UP-${i}`, JSON.stringify(option.name)],
      );
      ids.push(rows[0]?.id as string);
    }

    // Row versions before the upgrade: 0016 must leave an option that stays `other` alone,
    // because every option update restamps its style's variants (review M2 minor 3).
    const versions = async () =>
      new Map(
        (
          await owner.query<{ id: string; xmin: string }>(
            'SELECT id, xmin::text AS xmin FROM product_options WHERE id = ANY($1::uuid[])',
            [ids],
          )
        ).rows.map((row) => [row.id, row.xmin]),
      );
    const before = await versions();

    // The rest of the history, from 0015 on.
    await runMigrations(url);

    const { rows } = await owner.query<{ id: string; role: string }>(
      'SELECT id, role::text AS role FROM product_options WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const roles = new Map(rows.map((row) => [row.id, row.role]));
    expect(ids.map((id) => roles.get(id))).toEqual(names.map((option) => option.role));
    const after = await versions();
    const untouched = ids.map((id) => before.get(id) === after.get(id));
    expect(untouched).toEqual(names.map((option) => option.role === 'other'));

    const stamped = await owner.query<{ missing: number }>(
      `SELECT (SELECT count(*) FROM seasons WHERE created_at IS NULL OR updated_at IS NULL)
            + (SELECT count(*) FROM product_groups WHERE created_at IS NULL OR updated_at IS NULL)
              AS missing`,
    );
    expect(Number(stamped.rows[0]?.missing)).toBe(0);
  });

  it('refuses two active variants of one style with the same option values, not archived ones', async () => {
    const style = (
      await owner.query<{ id: string }>(
        `INSERT INTO products (style_code, product_group_id, name)
         VALUES ('UP-PAIR', (SELECT id FROM product_groups WHERE code = 'MAIN'), '{"en":"Pair"}')
         RETURNING id`,
      )
    ).rows[0]?.id as string;
    const variant = (sku: string, archived: boolean) =>
      owner.query(
        `INSERT INTO product_variants (product_id, sku, option_values, base_uom_id, archived_at)
         VALUES ($1, $2, '{"0": 1}', (SELECT id FROM uoms WHERE code = 'pc'),
                 CASE WHEN $3::boolean THEN now() END)`,
        [style, sku, archived],
      );
    await variant('UP-PAIR-A', false);
    await variant('UP-PAIR-ARCHIVED', true);

    await expect(variant('UP-PAIR-B', false)).rejects.toMatchObject({
      constraint: 'product_variants_options_unique',
    });
  });
});

// Review M2 minor 6: an install whose catalog already holds two active variants of one style
// with the same option values (a hand planted or imported row; the api never made one) cannot
// take 0015's unique index. The migrate stops, changes nothing, and names the index and the
// duplicated key, which `packages/db/AGENTS.md` tells the operator how to resolve.
describe('0015 on an install with duplicate active option values', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let folder: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    folder = historyTo0014();
    await runMigrations(url, { migrationsFolder: folder });
    owner = new pg.Client({ connectionString: url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('refuses the upgrade with an error naming the index and the duplicated key', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO products (style_code, product_group_id, name)
       VALUES ('DUP', (SELECT id FROM product_groups WHERE code = 'MAIN'), '{"en":"Dup"}')
       RETURNING id`,
    );
    for (const sku of ['DUP-1', 'DUP-2']) {
      await owner.query(
        `INSERT INTO product_variants (product_id, sku, option_values, base_uom_id)
         VALUES ($1, $2, '{"0": 0}', (SELECT id FROM uoms WHERE code = 'pc'))`,
        [rows[0]?.id, sku],
      );
    }

    const failure: unknown = await runMigrations(url).then(
      () => null,
      (error: unknown) => error,
    );

    // The message and detail of the error and of each error it wraps.
    const parts: string[] = [];
    for (let current = failure; current && typeof current === 'object';) {
      const { message, detail, cause } = current as {
        message?: unknown;
        detail?: unknown;
        cause?: unknown;
      };
      for (const part of [message, detail]) if (typeof part === 'string') parts.push(part);
      current = cause;
    }
    const text = parts.join(' ');
    expect(text).toContain('product_variants_options_unique');
    expect(text).toContain('is duplicated');
    const index = await owner.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'product_variants_options_unique'",
    );
    expect(index.rows).toEqual([]);
  });
});
