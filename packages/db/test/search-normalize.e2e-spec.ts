import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0012, AC-1 and AC-2: one normalization of search text, and a per variant search document
// the database keeps true on every write path.
describe('catalog search text (spec 0012, AC-1, AC-2)', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
  });

  describe('ssd_search_normalize (AC-1)', () => {
    // Input and expected output; the first six are the AC-1 list.
    const FIXTURES: [string, string][] = [
      ['TEE-BLK-M', 'tee blk m'],
      ['قميص أسود', 'قميص اسود'],
      ['بِنطلون', 'بنطلون'],
      ['٢٠٤٤', '2044'],
      ['مدرسة', 'مدرسه'],
      ['  Round   Top ', 'round top'],
      ['۱۲۳ ۴۵۶۷۸۹۰', '123 4567890'],
      ['إسورة آخر ٱلعرض', 'اسوره اخر العرض'],
      ['مستشفى شاطئ مؤمن', 'مستشفي شاطي مومن'],
      ['جمـــيل', 'جميل'],
      ['مُوسَىٰ', 'موسي'],
      ['50% off_now\\x', '50 off now x'],
      ['BLACK/Tee, (XL)', 'black tee xl'],
      ['', ''],
      ['---', ''],
    ];

    it.each(FIXTURES)('normalizes %j to %j', async (input, expected) => {
      const { rows } = await owner.query<{ out: string }>(
        'SELECT ssd_search_normalize($1) AS out',
        [input],
      );
      expect(rows[0]?.out).toBe(expected);
    });

    it('answers null for null', async () => {
      const { rows } = await owner.query<{ out: string | null }>(
        'SELECT ssd_search_normalize(NULL) AS out',
      );
      expect(rows[0]?.out).toBeNull();
    });

    it('is a plain inlinable sql function: IMMUTABLE, PARALLEL SAFE, no SET clause', async () => {
      const { rows } = await owner.query<{
        lang: string;
        volatile: string;
        parallel: string;
        config: string[] | null;
      }>(`
        SELECT l.lanname AS lang, p.provolatile AS volatile, p.proparallel AS parallel,
               p.proconfig AS config
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.proname = 'ssd_search_normalize'`);
      expect(rows).toEqual([{ lang: 'sql', volatile: 'i', parallel: 's', config: null }]);
    });

    it('is inlined by the planner (the plan shows its body, not a call)', async () => {
      const { rows } = await owner.query<{ 'QUERY PLAN': string }>(
        'EXPLAIN (VERBOSE, COSTS OFF) SELECT ssd_search_normalize(sku) FROM product_variants',
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('btrim(regexp_replace(translate(lower(');
      expect(plan).not.toContain('ssd_search_normalize');
    });

    // Review of spec 0012 M1: pg_trgm picks word characters by the database's character type, so
    // an Arabic contains pattern only uses the trigram index where Arabic letters count as letters.
    // This pins it on the test database; feature 26 confirms the client database's ctype.
    it('extracts trigrams from an Arabic word on this database', async () => {
      const { rows } = await owner.query<{ trigrams: string[] }>(
        "SELECT show_trgm('قميص') AS trigrams",
      );
      // Four letters padded as one word give five trigrams; pg_trgm shows multibyte trigrams as
      // hashes, so the count is the check. Where Arabic letters are not word characters it is 0.
      expect(rows[0]?.trigrams ?? []).toHaveLength(5);
    });
  });

  describe('product_variants.search_text (AC-2)', () => {
    let style: string;
    let other: string;

    /** Every variant whose stored document differs from its recomputation (should be none). */
    async function drifted(): Promise<string[]> {
      const { rows } = await owner.query<{ sku: string }>(`
        SELECT sku FROM product_variants
        WHERE search_text IS DISTINCT FROM ssd_variant_search_text(product_id, sku, option_values)`);
      return rows.map((row) => row.sku);
    }

    async function documentOf(sku: string): Promise<string> {
      const { rows } = await owner.query<{ search_text: string }>(
        'SELECT search_text FROM product_variants WHERE sku = $1',
        [sku],
      );
      return rows[0]?.search_text ?? '';
    }

    async function newStyle(code: string, styleName: object): Promise<string> {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO products (style_code, product_group_id, name, status)
         VALUES ($1, (SELECT id FROM product_groups WHERE code = 'MAIN'), $2::jsonb, 'active')
         RETURNING id`,
        [code, JSON.stringify(styleName)],
      );
      return rows[0]?.id ?? '';
    }

    async function newVariant(styleId: string, sku: string, optionValues: object = {}) {
      await owner.query(
        `INSERT INTO product_variants (product_id, sku, option_values, base_uom_id)
         VALUES ($1, $2, $3::jsonb, (SELECT id FROM uoms WHERE code = 'pc'))`,
        [styleId, sku, JSON.stringify(optionValues)],
      );
    }

    beforeAll(async () => {
      style = await newStyle('TEE', { en: 'Round Tee', ar: 'تيشيرت أسود' });
      other = await newStyle('SHIRT', { en: 'Shirt' });
      await owner.query(
        `INSERT INTO product_options (product_id, name, position, values) VALUES
           ($1, '{"en": "Size", "ar": "المقاس"}', 0, '[{"en": "M"}, {"en": "L", "ar": "كبير"}]'),
           ($1, '{"en": "Color"}', 1, '[{"en": "Black", "ar": "أسود"}, {"en": "White"}]')`,
        [style],
      );
      await newVariant(style, 'TEE-BLK-M', { '0': 0, '1': 0 });
      await newVariant(style, 'TEE-WHT-L', { '0': 1, '1': 1 });
      await newVariant(other, 'SHIRT-1');
    });

    it('is the normalized style names, style code, SKU code, and option value labels on insert', async () => {
      expect(await documentOf('TEE-BLK-M')).toBe(
        'round tee تيشيرت اسود tee tee blk m m black اسود',
      );
      expect(await documentOf('TEE-WHT-L')).toBe(
        'round tee تيشيرت اسود tee tee wht l l كبير white',
      );
      expect(await documentOf('SHIRT-1')).toBe('shirt shirt shirt 1');
      expect(await drifted()).toEqual([]);
    });

    it("follows a variant's code, option values, and style", async () => {
      await owner.query("UPDATE product_variants SET sku = 'TEE-BLK-M2' WHERE sku = 'TEE-BLK-M'");
      await owner.query(
        `UPDATE product_variants SET option_values = '{"0": 1, "1": 0}' WHERE sku = 'TEE-BLK-M2'`,
      );
      expect(await documentOf('TEE-BLK-M2')).toContain('tee blk m2 l كبير black');
      await owner.query('UPDATE product_variants SET product_id = $1 WHERE sku = $2', [
        other,
        'SHIRT-1',
      ]);
      await owner.query('UPDATE product_variants SET product_id = $1 WHERE sku = $2', [
        style,
        'SHIRT-1',
      ]);
      expect(await documentOf('SHIRT-1')).toBe('round tee تيشيرت اسود tee shirt 1');
      expect(await drifted()).toEqual([]);
    });

    it('never keeps a value written straight into search_text', async () => {
      await owner.query("UPDATE product_variants SET search_text = 'forged' WHERE sku = 'SHIRT-1'");
      expect(await documentOf('SHIRT-1')).not.toBe('forged');
      expect(await drifted()).toEqual([]);
    });

    it("follows a style rename and recode, as the app role, without touching the variants' updated_at", async () => {
      const before = await owner.query<{ sku: string; updated_at: string }>(
        'SELECT sku, updated_at::text FROM product_variants WHERE product_id = $1 ORDER BY sku',
        [style],
      );
      await owner.query('BEGIN');
      await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await owner.query(
        `UPDATE products SET name = '{"en": "Boxy Top", "ar": "بلوزة"}', updated_at = now() WHERE id = $1`,
        [style],
      );
      await owner.query("UPDATE products SET style_code = 'TOP' WHERE id = $1", [style]);
      await owner.query('COMMIT');

      expect(await documentOf('TEE-WHT-L')).toBe('boxy top بلوزه top tee wht l l كبير white');
      const after = await owner.query<{ sku: string; updated_at: string }>(
        'SELECT sku, updated_at::text FROM product_variants WHERE product_id = $1 ORDER BY sku',
        [style],
      );
      expect(after.rows).toEqual(before.rows);
      expect(await drifted()).toEqual([]);
    });

    it("follows inserting, updating, moving, and deleting a style's options", async () => {
      await owner.query(
        `INSERT INTO product_options (product_id, name, position, values)
         VALUES ($1, '{"en": "Fit"}', 0, '[{"en": "Slim", "ar": "ضيق"}]')`,
        [other],
      );
      await owner.query(
        `UPDATE product_variants SET option_values = '{"0": 0}' WHERE sku = 'SHIRT-1'`,
      );
      await owner.query('UPDATE product_variants SET product_id = $1 WHERE sku = $2', [
        other,
        'SHIRT-1',
      ]);
      expect(await documentOf('SHIRT-1')).toBe('shirt shirt shirt 1 slim ضيق');

      await owner.query(
        `UPDATE product_options SET values = '[{"en": "Regular"}]' WHERE product_id = $1`,
        [other],
      );
      expect(await documentOf('SHIRT-1')).toBe('shirt shirt shirt 1 regular');

      await owner.query(
        `UPDATE product_options SET values = '[{"en": "Medium"}, {"en": "Large"}]'
         WHERE product_id = $1 AND position = 0`,
        [style],
      );
      expect(await documentOf('TEE-WHT-L')).toContain('tee wht l large white');

      // Moving an option from one style to another restamps both styles' variants.
      await owner.query('DELETE FROM product_options WHERE product_id = $1 AND position = 1', [
        style,
      ]);
      await owner.query(
        'UPDATE product_options SET product_id = $1, position = 1 WHERE product_id = $2',
        [style, other],
      );
      expect(await documentOf('SHIRT-1')).toBe('shirt shirt shirt 1');
      expect(await documentOf('TEE-WHT-L')).not.toContain('white');

      await owner.query('DELETE FROM product_options WHERE product_id = $1', [style]);
      expect(await documentOf('TEE-WHT-L')).toBe('boxy top بلوزه top tee wht l');
      expect(await drifted()).toEqual([]);
    });

    // Review of spec 0012 M1 (major): two overlapping transactions, a variant insert and a style
    // write (rename, or a new option), in both orders. Each must wait for the other, and the
    // stored document must equal its recomputation once both commit. Both run as the app role.
    describe('overlapping writes', () => {
      type StyleWrite = 'rename' | 'option';

      async function connectAsApp(): Promise<{ client: pg.Client; pid: number }> {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        await client.query(`SET ROLE ${APP_ROLE}`);
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return { client, pid: rows[0]?.pid ?? 0 };
      }

      /**
       * Waits until the statement settles or its session waits on a lock, so the test proceeds the
       * same way whether or not the triggers make it wait (the old trigger body did not).
       */
      async function settledOrBlocked(pid: number, statement: Promise<unknown>): Promise<void> {
        let settled = false;
        statement.then(
          () => (settled = true),
          () => (settled = true),
        );
        for (let attempt = 0; attempt < 250 && !settled; attempt += 1) {
          const { rows } = await owner.query<{ waiting: boolean }>(
            "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          if (rows[0]?.waiting) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!settled) throw new Error('the statement neither finished nor waited on a lock');
      }

      function styleWriteSql(write: StyleWrite): string {
        switch (write) {
          case 'rename':
            return `UPDATE products SET name = '{"en": "New Name"}' WHERE id = $1`;
          case 'option':
            return `INSERT INTO product_options (product_id, name, position, values)
                    VALUES ($1, '{"en": "Size"}', 0, '[{"en": "Small"}]')`;
        }
      }

      const insertVariant = `INSERT INTO product_variants (product_id, sku, option_values, base_uom_id)
        VALUES ($1, $2, '{"0": 0}', (SELECT id FROM uoms WHERE code = 'pc'))`;

      let a: { client: pg.Client; pid: number };
      let b: { client: pg.Client; pid: number };

      beforeAll(async () => {
        a = await connectAsApp();
        b = await connectAsApp();
      });

      afterAll(async () => {
        await a?.client.end();
        await b?.client.end();
      });

      it.each<StyleWrite>(['rename', 'option'])(
        'keeps a variant inserted first true when a style write (%s) commits while it is open',
        async (write) => {
          const id = await newStyle(`RACE-V-${write}`, { en: 'Old Name' });
          const sku = `RACE-V-${write}-1`;
          await a.client.query('BEGIN');
          await a.client.query(insertVariant, [id, sku]);
          const styleWrite = b.client.query(styleWriteSql(write), [id]);
          await settledOrBlocked(b.pid, styleWrite);
          await a.client.query('COMMIT');
          await styleWrite;

          expect(await documentOf(sku)).toContain(write === 'rename' ? 'new name' : 'small');
          expect(await drifted()).toEqual([]);
        },
      );

      it.each<StyleWrite>(['rename', 'option'])(
        'keeps a variant inserted while a style write (%s) is open true once both commit',
        async (write) => {
          const id = await newStyle(`RACE-S-${write}`, { en: 'Old Name' });
          const sku = `RACE-S-${write}-1`;
          await b.client.query('BEGIN');
          await b.client.query(styleWriteSql(write), [id]);
          const insert = (async () => {
            await a.client.query('BEGIN');
            await a.client.query(insertVariant, [id, sku]);
          })();
          await settledOrBlocked(a.pid, insert);
          await b.client.query('COMMIT');
          await insert;
          await a.client.query('COMMIT');

          expect(await documentOf(sku)).toContain(write === 'rename' ? 'new name' : 'small');
          expect(await drifted()).toEqual([]);
        },
      );
    });
  });
});
