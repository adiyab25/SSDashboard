import { randomUUID } from 'node:crypto';
import {
  LocationDetail,
  LocationListResponse,
  SkuDetail,
  SkuListResponse,
  SkuMovementsResponse,
  SkuUsage,
  StockReceiptDetail,
} from '@ssdashboard/contracts';
import {
  APP_ROLE,
  createDatabase,
  runMigrations,
  sql,
  type DatabaseConnection,
} from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { ledgerTransaction, lockKey } from '../src/inventory/ledger/locks.js';
import { ReconciliationService } from '../src/inventory/ledger/reconciliation.service.js';
import { encodeKeyset } from '../src/platform/keyset-cursor.js';
import { SettingsService } from '../src/platform/settings/settings.service.js';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  signInAs,
  start,
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// Spec 0006, Milestone 3: master data in full, through the built api against PostgreSQL.
describe('master data api', { timeout: 90_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  /** The application role in this process, for what has no HTTP endpoint (rebuild, system postings). */
  let app: DatabaseConnection;
  let ledger: LedgerService;
  let reconciliation: ReconciliationService;
  let api: RunningProcess | undefined;
  let base: string;
  let staff: string;
  let admin: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 4 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    app = createDatabase(appUrl.toString(), { max: 8 });
    ledger = new LedgerService(app, new SettingsService(app));
    reconciliation = new ReconciliationService(app);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
    });
    await waitForHttp(`${base}/api/health`, api);
    staff = await signInAs(base, owner.pool, {
      email: 'staff@example.com',
      access: { hats: ['support', 'operations', 'warehouse'] },
    });
    admin = await signInAs(base, owner.pool, {
      email: 'admin@example.com',
      access: { hats: ['manager'], costView: true },
    });
  });

  afterAll(async () => {
    await stop(api);
    await app?.pool.end();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  async function call(
    method: string,
    path: string,
    options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: base,
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text ? JSON.parse(text) : null) as unknown,
    };
  }

  async function newSku(code: string, name: { en?: string; ar?: string } = { en: code }) {
    const { status, body } = await call('POST', '/products', {
      cookie: staff,
      body: { name, variants: [{ sku: code, price: '19.99' }] },
    });
    expect(status).toBe(201);
    return SkuDetail.parse(body);
  }

  async function newLocation(code: string) {
    const { status, body } = await call('POST', '/locations', {
      cookie: admin,
      body: { code, name: { en: `Warehouse ${code}` }, kind: 'warehouse' },
    });
    expect(status).toBe(201);
    return LocationDetail.parse(body);
  }

  function receipt(locationId: string, skuId: string, quantity: number, unitCost = '5') {
    return call('POST', '/stock-receipts', {
      cookie: staff,
      body: { locationId, lines: [{ skuId, quantity, unitCost }] },
      headers: { 'idempotency-key': randomUUID() },
    });
  }

  async function receiveOne(locationId: string, skuId: string, quantity: number, unitCost = '5') {
    const response = await receipt(locationId, skuId, quantity, unitCost);
    expect(response.status).toBe(201);
    return StockReceiptDetail.parse(response.body);
  }

  async function voidReceipt(id: string) {
    const response = await call('POST', `/stock-receipts/${id}/void`, {
      cookie: admin,
      body: { reason: 'Entered twice' },
    });
    expect(response.status).toBe(200);
  }

  const getSku = async (id: string) =>
    SkuDetail.parse((await call('GET', `/skus/${id}`, { cookie: staff })).body);

  const codes = async (query: string, cookie = staff) =>
    SkuListResponse.parse((await call('GET', `/skus${query}`, { cookie })).body).items.map(
      (item) => item.code,
    );

  /** Waits until this database has at least `count` lock waits. */
  async function waitForLockWaits(count: number) {
    const deadline = Date.now() + 4_000;
    for (;;) {
      const { rows } = await owner.pool.query<{ waiting: number }>(`
        SELECT count(*)::int AS waiting
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`);
      if ((rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`Fewer than ${count} lock waits`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Holds the ledger's advisory lock for one SKU and location until `release` is called. */
  async function holdPair(variantId: string, locationId: string) {
    const client = await owner.pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      lockKey(variantId, locationId).toString(),
    ]);
    return async () => {
      await client.query('COMMIT');
      client.release();
    };
  }

  /** Holds `FOR UPDATE` on a row from outside the api until `release` is called. */
  async function holdRow(table: 'products' | 'locations', id: string) {
    const client = await owner.pool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    return async () => {
      await client.query('COMMIT');
      client.release();
    };
  }

  /** Whether a promise has settled within 100 ms. */
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    return done;
  }

  /**
   * Stock posted by a receipt, then its balance drifted to 0 behind the ledger's back (test
   * only, as the owner), with an open balance discrepancy, so a rebuild restores the stock.
   */
  async function driftedToZero(variantId: string, locationId: string, quantity: number) {
    await receiveOne(locationId, variantId, quantity);
    const { rows } = await owner.pool.query<{ id: string }>(
      `UPDATE stock_levels SET on_hand = 0, total_value = 0
       WHERE variant_id = $1 AND location_id = $2 RETURNING id`,
      [variantId, locationId],
    );
    const discrepancy = await owner.pool.query<{ id: string }>(
      `INSERT INTO stock_level_discrepancies (stock_level_id, variant_id, location_id, kind,
                                              expected, actual)
       VALUES ($1, $2, $3, 'balance', $4, '{"onHand": 0, "totalValue": "0.00"}')
       RETURNING id`,
      [rows[0]?.id, variantId, locationId, JSON.stringify({ onHand: quantity })],
    );
    return discrepancy.rows[0]?.id ?? '';
  }

  describe('creating a product (spec 0002, AC-30)', () => {
    it('makes the product a style whose style code is the SKU code, in the MAIN group', async () => {
      const sku = await newSku('STYLE-1');
      const { rows } = await owner.pool.query<{ style_code: string; code: string }>(
        `SELECT p.style_code, g.code FROM products p
           JOIN product_groups g ON g.id = p.product_group_id WHERE p.id = $1`,
        [sku.productId],
      );
      expect(rows[0]).toEqual({ style_code: 'STYLE-1', code: 'MAIN' });
    });

    it('frees the old code when a SKU is renamed, because the style code follows it', async () => {
      const sku = await newSku('REN-A');
      const renamed = await call('PATCH', `/skus/${sku.id}/code`, {
        cookie: admin,
        body: { updatedAt: sku.updatedAt, sku: 'REN-B' },
      });
      expect(renamed.status).toBe(200);
      const { rows } = await owner.pool.query<{ style_code: string }>(
        'SELECT style_code FROM products WHERE id = $1',
        [sku.productId],
      );
      expect(rows[0]?.style_code).toBe('REN-B');

      // The freed code can be used again: no stale style code is left behind.
      expect((await newSku('REN-A')).code).toBe('REN-A');
    });

    it('answers STYLE_CODE_TAKEN, not SKU_TAKEN, when only another style holds the new code', async () => {
      const other = await newSku('STY-OTHER');
      await owner.pool.query("UPDATE products SET style_code = 'STYLE-ONLY' WHERE id = $1", [
        other.productId,
      ]);
      const sku = await newSku('STY-MINE');

      const renamed = await call('PATCH', `/skus/${sku.id}/code`, {
        cookie: admin,
        body: { updatedAt: sku.updatedAt, sku: 'STYLE-ONLY' },
      });

      expect(renamed.status).toBe(409);
      expect(renamed.body).toMatchObject({ code: 'STYLE_CODE_TAKEN' });
      expect((await getSku(sku.id)).code).toBe('STY-MINE');
    });

    it('answers SKU_TAKEN when the code is a variant code or a style code already', async () => {
      await newSku('STYLE-DUP');
      const again = await call('POST', '/products', {
        cookie: staff,
        body: { name: { en: 'x' }, variants: [{ sku: 'STYLE-DUP' }] },
      });
      expect(again.body).toMatchObject({ code: 'SKU_TAKEN' });
    });
  });

  describe('the SKU list (AC-13)', () => {
    it('pages 50 by default, walks every row once, and shows archived SKUs only under the filter', async () => {
      for (const code of ['PAGE-A', 'PAGE-B', 'PAGE-C']) await newSku(code);
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const page: SkuListResponse = SkuListResponse.parse(
          (
            await call('GET', `/skus?q=page-&limit=1${cursor ? `&cursor=${cursor}` : ''}`, {
              cookie: staff,
            })
          ).body,
        );
        expect(page.items.length).toBeLessThanOrEqual(1);
        walked.push(...page.items.map((item) => item.code));
        cursor = page.nextCursor;
      } while (cursor);
      expect(walked).toEqual(['PAGE-A', 'PAGE-B', 'PAGE-C']);

      const old = await newSku('PAGE-OLD');
      expect((await call('POST', `/skus/${old.id}/archive`, { cookie: admin })).status).toBe(200);
      expect(await codes('?q=page-')).toEqual(['PAGE-A', 'PAGE-B', 'PAGE-C']);
      expect(await codes('?q=page-&status=archived')).toEqual(['PAGE-OLD']);
      expect((await call('GET', '/skus?status=gone', { cookie: staff })).body).toMatchObject({
        code: 'INVALID_QUERY',
      });
      expect((await call('GET', '/skus?cursor=nope', { cookie: staff })).status).toBe(400);
    });

    it('lists a SKU matching by code and by name once, in code order, across pages', async () => {
      await newSku('DUPQ-1', { en: 'dupq-1 shirt' });
      await newSku('DUPQ-2', { en: 'Shirt' });
      await newSku('XDUPQ-3', { en: 'Has dupq inside' });
      expect(await codes('?q=dupq')).toEqual(['DUPQ-1', 'DUPQ-2', 'XDUPQ-3']);
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const page: SkuListResponse = SkuListResponse.parse(
          (
            await call('GET', `/skus?q=dupq&limit=1${cursor ? `&cursor=${cursor}` : ''}`, {
              cookie: staff,
            })
          ).body,
        );
        walked.push(...page.items.map((item) => item.code));
        cursor = page.nextCursor;
      } while (cursor);
      expect(walked).toEqual(['DUPQ-1', 'DUPQ-2', 'XDUPQ-3']);
    });

    // Spec 0012 AC-3: the code prefix branch takes %, _, and a backslash literally; the contains
    // branch matches normalized words, in which they are word breaks, never wildcards.
    it('treats %, _, and a backslash in q as plain characters', async () => {
      await newSku('ES_1', { en: 'Under score' });
      await newSku('ESX1', { en: 'Plain one' });
      await newSku('ESC-SLASH', { en: 'Back\\slash tee' });
      await newSku('ESC-PCT', { en: '50% off' });
      expect(await codes(`?q=${encodeURIComponent('es_')}`)).toEqual(['ES_1']);
      expect(await codes(`?q=${encodeURIComponent('%')}`)).toEqual([]);
      expect(await codes(`?q=${encodeURIComponent('_')}`)).toEqual([]);
      expect(await codes(`?q=${encodeURIComponent('back\\slash')}`)).toEqual(['ESC-SLASH']);
      expect(await codes(`?q=${encodeURIComponent('off%')}`)).toEqual(['ESC-PCT']);
    });
  });

  describe('search and filters (spec 0012, AC-3, AC-4)', () => {
    let season: string;
    let tee: string;
    let polo: string;
    let qamis: string;
    const variants = new Map<string, string>();

    /** A style planted as the owner (the style routes come with milestone 2), with its options. */
    async function plantStyle(
      code: string,
      name: { en?: string; ar?: string },
      options: { name: { en?: string; ar?: string }; values: { en?: string; ar?: string }[] }[],
      seasonId: string | null = null,
    ): Promise<string> {
      const { rows } = await owner.pool.query<{ id: string }>(
        `INSERT INTO products (style_code, product_group_id, name, status, season_id)
         VALUES ($1, (SELECT id FROM product_groups WHERE code = 'MAIN'), $2::jsonb, 'active', $3)
         RETURNING id`,
        [code, JSON.stringify(name), seasonId],
      );
      const id = rows[0]?.id ?? '';
      for (const [position, option] of options.entries()) {
        await owner.pool.query(
          `INSERT INTO product_options (product_id, name, position, values)
           VALUES ($1, $2::jsonb, $3, $4::jsonb)`,
          [id, JSON.stringify(option.name), position, JSON.stringify(option.values)],
        );
      }
      return id;
    }

    /** A variant of a planted style, with an optional barcode. */
    async function plantVariant(
      styleId: string,
      sku: string,
      optionValues: Record<string, number>,
      barcode?: string,
    ): Promise<void> {
      const { rows } = await owner.pool.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, option_values, base_uom_id, price)
         VALUES ($1, $2, $3::jsonb, (SELECT id FROM uoms WHERE code = 'pc'), 25)
         RETURNING id`,
        [styleId, sku, JSON.stringify(optionValues)],
      );
      const id = rows[0]?.id ?? '';
      variants.set(sku, id);
      if (barcode) {
        await owner.pool.query(
          `INSERT INTO barcodes (variant_id, uom_id, code)
           VALUES ($1, (SELECT id FROM uoms WHERE code = 'pc'), $2)`,
          [id, barcode],
        );
      }
    }

    const search = (q: string, more = '') => codes(`?q=${encodeURIComponent(q)}${more}`);

    beforeAll(async () => {
      const planted = await owner.pool.query<{ id: string }>(
        `INSERT INTO seasons (code, name) VALUES ('SS26', '{"en": "Spring 26"}') RETURNING id`,
      );
      season = planted.rows[0]?.id ?? '';
      const size = { name: { en: 'Size', ar: 'المقاس' }, values: [{ en: 'M' }, { en: 'L' }] };
      tee = await plantStyle(
        'TEE',
        { en: 'Tee' },
        [size, { name: { en: 'Color' }, values: [{ en: 'Black', ar: 'أسود' }, { en: 'White' }] }],
        season,
      );
      await plantVariant(tee, 'TEE-BLK-M', { '0': 0, '1': 0 });
      await plantVariant(tee, 'TEE-WHT-M', { '0': 0, '1': 1 }, '6221234567890');
      polo = await plantStyle('POLO', { en: 'Polo' }, [size]);
      await plantVariant(polo, '2044-BLK-M', { '0': 0 }, '6221234567891');
      qamis = await plantStyle('QAMIS', { ar: 'قميص أسود' }, []);
      await plantVariant(qamis, 'QAMIS-1', {});
      await plantVariant(await plantStyle('MX', { en: 'Mx' }, []), 'MX-1', {});
    });

    it('finds an Arabic name typed without hamza', async () => {
      expect(await search('اسود')).toEqual(['QAMIS-1', 'TEE-BLK-M']);
      expect(await search('قميص اسود')).toEqual(['QAMIS-1']);
    });

    it('finds a code typed in Arabic digits', async () => {
      expect(await search('٢٠٤٤')).toEqual(['2044-BLK-M']);
    });

    it('finds two words in any order across the style name and an option value', async () => {
      expect(await search('black tee')).toEqual(['TEE-BLK-M']);
      expect(await search('tee black')).toEqual(['TEE-BLK-M']);
      expect(await search('Tee   BLACK!')).toEqual(['TEE-BLK-M']);
    });

    it('finds a hyphenated code fragment', async () => {
      expect(await search('blk-m')).toEqual(['2044-BLK-M', 'TEE-BLK-M']);
    });

    it('returns exactly the variant of a scanned barcode, in either digit set', async () => {
      expect(await search('6221234567890')).toEqual(['TEE-WHT-M']);
      expect(await search(' ٦٢٢١٢٣٤٥٦٧٨٩١ ')).toEqual(['2044-BLK-M']);
    });

    it('searches only barcodes and code prefixes for a word under 3 characters', async () => {
      const found = await search('m');
      expect(found).toContain('MX-1');
      expect(found.every((code) => code.startsWith('M'))).toBe(true);
      expect(await search('m', `&styleId=${tee}`)).toEqual([]);
      expect(await search('tw')).toEqual([]);
    });

    it('answers archived variants only under status=archived', async () => {
      const id = variants.get('TEE-WHT-M') ?? '';
      const ofTee = `&styleId=${tee}`;
      expect((await call('POST', `/skus/${id}/archive`, { cookie: admin })).status).toBe(200);
      expect(await search('6221234567890')).toEqual([]);
      expect(await search('tee', ofTee)).toEqual(['TEE-BLK-M']);
      expect(await search('6221234567890', '&status=archived')).toEqual(['TEE-WHT-M']);
      expect(await search('white', `&status=archived${ofTee}`)).toEqual(['TEE-WHT-M']);
      expect((await call('POST', `/skus/${id}/unarchive`, { cookie: admin })).status).toBe(200);
    });

    it('filters by season, no season, product group, and style, combined with q', async () => {
      expect(await search('blk', `&seasonId=${season}`)).toEqual(['TEE-BLK-M']);
      expect(await search('blk', '&seasonId=none')).toEqual(['2044-BLK-M']);
      expect(await codes(`?seasonId=${season}`)).toEqual(['TEE-BLK-M', 'TEE-WHT-M']);
      expect(await codes(`?styleId=${polo}`)).toEqual(['2044-BLK-M']);
      const main = (
        await owner.pool.query<{ id: string }>("SELECT id FROM product_groups WHERE code = 'MAIN'")
      ).rows[0]?.id;
      expect(await search('blk', `&productGroupId=${main}`)).toEqual(['2044-BLK-M', 'TEE-BLK-M']);
      expect(await search('blk', `&productGroupId=${randomUUID()}`)).toEqual([]);
      for (const bad of ['seasonId=SS26', 'productGroupId=MAIN', 'styleId=1']) {
        expect((await call('GET', `/skus?${bad}`, { cookie: staff })).body).toMatchObject({
          code: 'INVALID_QUERY',
        });
      }
    });

    it('pages a search by code without skipping or repeating a row', async () => {
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const page: SkuListResponse = SkuListResponse.parse(
          (
            await call('GET', `/skus?q=blk&limit=1${cursor ? `&cursor=${cursor}` : ''}`, {
              cookie: staff,
            })
          ).body,
        );
        walked.push(...page.items.map((item) => item.code));
        cursor = page.nextCursor;
      } while (cursor);
      expect(walked).toEqual(['2044-BLK-M', 'TEE-BLK-M']);
    });

    // Review of spec 0012 M1: the PGX-* rows match both the code prefix and the contains branch,
    // AAA-PGX and JKT-1 only the contains branch, so every page edge sits on a row the UNION must
    // list once and every branch must cut after the cursor.
    it('pages a search whose branches overlap without skipping or repeating a row', async () => {
      const pgx = await plantStyle('PGX', { en: 'Plain' }, []);
      for (const sku of ['PGX-1', 'PGX-2', 'PGX-3', 'AAA-PGX']) await plantVariant(pgx, sku, {});
      await plantVariant(await plantStyle('JKT', { en: 'Pgx Jacket' }, []), 'JKT-1', {});
      const expected = ['AAA-PGX', 'JKT-1', 'PGX-1', 'PGX-2', 'PGX-3'];
      expect(await search('pgx')).toEqual(expected);

      for (const limit of [1, 2]) {
        const walked: string[] = [];
        let cursor: string | null = null;
        do {
          const page: SkuListResponse = SkuListResponse.parse(
            (
              await call('GET', `/skus?q=pgx&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, {
                cookie: staff,
              })
            ).body,
          );
          expect(page.items.length).toBeLessThanOrEqual(limit);
          walked.push(...page.items.map((item) => item.code));
          cursor = page.nextCursor;
        } while (cursor);
        expect(walked).toEqual(expected);
      }
    });

    it('carries the style, season, group, and option values on each row', async () => {
      const page = SkuListResponse.parse(
        (await call('GET', '/skus?q=tee-blk-m', { cookie: staff })).body,
      );
      expect(page.items).toEqual([
        expect.objectContaining({
          code: 'TEE-BLK-M',
          style: { id: tee, code: 'TEE', name: { en: 'Tee' } },
          season: { id: season, code: 'SS26', name: { en: 'Spring 26' } },
          productGroup: expect.objectContaining({ code: 'MAIN' }) as unknown,
          options: [
            { name: { en: 'Size', ar: 'المقاس' }, value: { en: 'M' } },
            { name: { en: 'Color' }, value: { en: 'Black', ar: 'أسود' } },
          ],
          price: '25.00',
          archived: false,
        }),
      ]);
      const qamisRow = SkuListResponse.parse(
        (await call('GET', `/skus?styleId=${qamis}`, { cookie: staff })).body,
      ).items[0];
      expect(qamisRow).toMatchObject({ season: null, options: [] });
    });

    it('adds the barcodes to the SKU detail', async () => {
      const detail = await getSku(variants.get('TEE-WHT-M') ?? '');
      expect(detail).toMatchObject({
        code: 'TEE-WHT-M',
        style: { code: 'TEE' },
        season: { code: 'SS26' },
        options: [
          { name: { en: 'Size', ar: 'المقاس' }, value: { en: 'M' } },
          { name: { en: 'Color' }, value: { en: 'White' } },
        ],
        barcodes: [{ id: expect.any(String) as unknown, code: '6221234567890' }],
      });
      expect((await getSku(variants.get('QAMIS-1') ?? '')).barcodes).toEqual([]);
    });

    it('follows a style rename through the API into search', async () => {
      const id = variants.get('QAMIS-1') ?? '';
      const before = await getSku(id);
      const renamed = await call('PATCH', `/skus/${id}`, {
        cookie: staff,
        body: { updatedAt: before.updatedAt, name: { en: 'Linen shirt', ar: 'قميص كتان' } },
      });
      expect(renamed.status).toBe(200);
      expect(await search('linen')).toEqual(['QAMIS-1']);
      expect(await search('كتان')).toEqual(['QAMIS-1']);
      expect(await search('اسود')).toEqual(['TEE-BLK-M']);
    });
  });

  describe('SKU edits (AC-2)', () => {
    it('round trips updatedAt to the microsecond: an edit with the value just read always succeeds', async () => {
      let sku = await newSku('EDIT-1');
      expect(sku.updatedAt).toMatch(MICROSECONDS);
      for (let round = 0; round < 5; round += 1) {
        const response = await call('PATCH', `/skus/${sku.id}`, {
          cookie: staff,
          body: { updatedAt: sku.updatedAt, price: `${round + 1}.50` },
        });
        expect(response.status).toBe(200);
        sku = SkuDetail.parse(response.body);
        expect(sku.price).toBe(`${round + 1}.50`);
      }
      // The value a fresh read returns works too.
      const read = await getSku(sku.id);
      const renamed = await call('PATCH', `/skus/${sku.id}`, {
        cookie: staff,
        body: { updatedAt: read.updatedAt, name: { ar: 'قميص' }, price: null },
      });
      expect(SkuDetail.parse(renamed.body)).toMatchObject({ name: { ar: 'قميص' }, price: null });
    });

    it('lets one of two edits from the same updatedAt win; the other is STALE_RECORD and changes nothing', async () => {
      const sku = await newSku('EDIT-RACE');
      const edit = (price: string) =>
        call('PATCH', `/skus/${sku.id}`, {
          cookie: staff,
          body: { updatedAt: sku.updatedAt, price },
        });
      const results = await Promise.all([edit('1.00'), edit('2.00')]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const loser = results.find((result) => result.status === 409);
      const winner = SkuDetail.parse(results.find((result) => result.status === 200)?.body);
      expect(loser?.body).toMatchObject({ code: 'STALE_RECORD' });
      expect((await getSku(sku.id)).price).toBe(winner.price);
    });

    it('answers 404 for an unknown SKU and 400 without updatedAt', async () => {
      const unknown = await call('PATCH', `/skus/${randomUUID()}`, {
        cookie: staff,
        body: { updatedAt: '2026-01-01T00:00:00.000000Z', price: '1.00' },
      });
      expect(unknown.status).toBe(404);
      const sku = await newSku('EDIT-BAD');
      expect(
        (await call('PATCH', `/skus/${sku.id}`, { cookie: staff, body: { price: '1.00' } })).body,
      ).toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('SKU code, archive, and delete rules (AC-2, AC-3)', () => {
    it('changes the code of an unposted SKU, then locks it once stock was posted', async () => {
      const sku = await newSku('CODE-1');
      const warehouse = await newLocation('WH-CODE');
      const usage = async () =>
        SkuUsage.parse((await call('GET', `/skus/${sku.id}/usage`, { cookie: staff })).body);
      expect(await usage()).toEqual({ codeLocked: false, canArchive: true });

      expect(
        (
          await call('PATCH', `/skus/${sku.id}/code`, {
            cookie: staff,
            body: { updatedAt: sku.updatedAt, sku: 'CODE-2' },
          })
        ).status,
      ).toBe(403);
      await newSku('CODE-TAKEN');
      expect(
        (
          await call('PATCH', `/skus/${sku.id}/code`, {
            cookie: admin,
            body: { updatedAt: sku.updatedAt, sku: 'code-taken' },
          })
        ).body,
      ).toMatchObject({ code: 'SKU_TAKEN' });
      const changed = await call('PATCH', `/skus/${sku.id}/code`, {
        cookie: admin,
        body: { updatedAt: sku.updatedAt, sku: ' code-2 ' },
      });
      expect(changed.status).toBe(200);
      const renamed = SkuDetail.parse(changed.body);
      expect(renamed.code).toBe('CODE-2');
      // The read it came from is now stale.
      expect(
        (
          await call('PATCH', `/skus/${sku.id}/code`, {
            cookie: admin,
            body: { updatedAt: sku.updatedAt, sku: 'CODE-3' },
          })
        ).body,
      ).toMatchObject({ code: 'STALE_RECORD' });

      await receiveOne(warehouse.id, sku.id, 10);
      expect(await usage()).toEqual({ codeLocked: true, canArchive: false });
      const locked = await call('PATCH', `/skus/${sku.id}/code`, {
        cookie: admin,
        body: { updatedAt: (await getSku(sku.id)).updatedAt, sku: 'CODE-3' },
      });
      expect(locked.status).toBe(409);
      expect(locked.body).toMatchObject({ code: 'CODE_LOCKED' });
      expect((await getSku(sku.id)).code).toBe('CODE-2');
      expect((await call('GET', `/skus/${randomUUID()}/usage`, { cookie: staff })).status).toBe(
        404,
      );
    });

    it('refuses to archive with stock on hand; after a void it archives, leaves the picker, and comes back', async () => {
      const sku = await newSku('ARCH-1');
      const warehouse = await newLocation('WH-ARCH');
      const posted = await receiveOne(warehouse.id, sku.id, 10);

      expect((await call('POST', `/skus/${sku.id}/archive`, { cookie: staff })).status).toBe(403);
      const refused = await call('POST', `/skus/${sku.id}/archive`, { cookie: admin });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'STOCK_ON_HAND' });

      await voidReceipt(posted.id);
      const archived = await call('POST', `/skus/${sku.id}/archive`, { cookie: admin });
      expect(archived.status).toBe(200);
      expect(SkuDetail.parse(archived.body)).toMatchObject({ status: 'archived', archived: true });
      expect(await codes('?q=arch-1&limit=20')).toEqual([]);
      expect(await codes('?q=arch-1&status=archived')).toEqual(['ARCH-1']);
      // A receipt now refuses it, and its history stays.
      const blocked = await receipt(warehouse.id, sku.id, 1);
      expect(blocked.body).toMatchObject({
        code: 'INVALID_LINES',
        lineErrors: [{ index: 0, code: 'ARCHIVED' }],
      });
      const history = SkuMovementsResponse.parse(
        (await call('GET', `/skus/${sku.id}/movements`, { cookie: staff })).body,
      );
      expect(history.items).toHaveLength(2);

      expect((await call('POST', `/skus/${sku.id}/unarchive`, { cookie: staff })).status).toBe(403);
      const back = await call('POST', `/skus/${sku.id}/unarchive`, { cookie: admin });
      expect(SkuDetail.parse(back.body).status).toBe('active');
      expect(await codes('?q=arch-1')).toEqual(['ARCH-1']);
      expect((await call('POST', `/skus/${randomUUID()}/archive`, { cookie: admin })).status).toBe(
        404,
      );
    });

    it('deletes an unposted SKU and its product; a posted one is IN_USE', async () => {
      const unposted = await newSku('DEL-1');
      expect((await call('DELETE', `/skus/${unposted.id}`, { cookie: staff })).status).toBe(403);
      expect((await call('DELETE', `/skus/${unposted.id}`, { cookie: admin })).status).toBe(204);
      expect((await call('GET', `/skus/${unposted.id}`, { cookie: staff })).status).toBe(404);
      const { rows } = await owner.pool.query('SELECT 1 FROM products WHERE id = $1', [
        unposted.productId,
      ]);
      expect(rows).toEqual([]);

      const posted = await newSku('DEL-2');
      const warehouse = await newLocation('WH-DEL');
      await voidReceipt((await receiveOne(warehouse.id, posted.id, 1)).id);
      const inUse = await call('DELETE', `/skus/${posted.id}`, { cookie: admin });
      expect(inUse.status).toBe(409);
      expect(inUse.body).toMatchObject({ code: 'IN_USE' });
      expect((await getSku(posted.id)).code).toBe('DEL-2');
      expect((await call('DELETE', `/skus/${randomUUID()}`, { cookie: admin })).status).toBe(404);
    });
  });

  describe('the archive race (AC-3)', () => {
    it('a posting in flight first: the archive waits, then fails STOCK_ON_HAND', async () => {
      const sku = await newSku('RACE-POST');
      const warehouse = await newLocation('WH-RACE1');
      const release = await holdPair(sku.id, warehouse.id);
      let posting: ReturnType<typeof receipt> | undefined;
      let archive: ReturnType<typeof call> | undefined;
      try {
        // The posting takes FOR SHARE on the SKU, then waits on the held pair lock.
        posting = receipt(warehouse.id, sku.id, 10);
        await waitForLockWaits(1);
        // The archive's FOR UPDATE waits behind the posting's FOR SHARE.
        archive = call('POST', `/skus/${sku.id}/archive`, { cookie: admin });
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [posted, archived] = await Promise.all([posting, archive]);
      expect(posted?.status).toBe(201);
      expect(archived?.status).toBe(409);
      expect(archived?.body).toMatchObject({ code: 'STOCK_ON_HAND' });
      expect((await getSku(sku.id)).status).toBe('active');
    });

    it('an archive in flight first: the posting waits, then fails ARCHIVED', async () => {
      const sku = await newSku('RACE-ARCH');
      const warehouse = await newLocation('WH-RACE2');
      // The archive takes FOR UPDATE on the SKU row, then waits to update the held product row.
      const release = await holdRow('products', sku.productId);
      let archive: ReturnType<typeof call> | undefined;
      let posting: ReturnType<typeof receipt> | undefined;
      try {
        archive = call('POST', `/skus/${sku.id}/archive`, { cookie: admin });
        await waitForLockWaits(1);
        // The posting passed its pre check; its FOR SHARE waits behind the archive.
        posting = receipt(warehouse.id, sku.id, 5);
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [archived, posted] = await Promise.all([archive, posting]);
      expect(archived?.status).toBe(200);
      expect(posted?.status).toBe(422);
      expect(posted?.body).toMatchObject({ code: 'ARCHIVED' });
      const { rows } = await owner.pool.query(
        'SELECT on_hand FROM stock_levels WHERE variant_id = $1',
        [sku.id],
      );
      expect(rows).toEqual([]);
    });

    it('a location archive waits behind an in flight posting, then fails STOCK_ON_HAND', async () => {
      const sku = await newSku('RACE-LOC');
      const warehouse = await newLocation('WH-RACE3');
      const release = await holdPair(sku.id, warehouse.id);
      let posting: ReturnType<typeof receipt> | undefined;
      let archive: ReturnType<typeof call> | undefined;
      try {
        // The posting takes FOR SHARE on the location, then waits on the held pair lock.
        posting = receipt(warehouse.id, sku.id, 4);
        await waitForLockWaits(1);
        // The archive's FOR UPDATE on the location waits behind the posting's FOR SHARE.
        archive = call('POST', `/locations/${warehouse.id}/archive`, { cookie: admin });
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [posted, archived] = await Promise.all([posting, archive]);
      expect(posted?.status).toBe(201);
      expect(archived?.status).toBe(409);
      expect(archived?.body).toMatchObject({ code: 'STOCK_ON_HAND' });
    });
  });

  describe('code change race (AC-2)', () => {
    it('a SKU code change waits behind an in flight posting, then answers CODE_LOCKED', async () => {
      const sku = await newSku('CRACE-SKU');
      const warehouse = await newLocation('WH-CRACE1');
      const release = await holdPair(sku.id, warehouse.id);
      let posting: ReturnType<typeof receipt> | undefined;
      let change: ReturnType<typeof call> | undefined;
      try {
        posting = receipt(warehouse.id, sku.id, 2);
        await waitForLockWaits(1);
        // The code change's FOR UPDATE waits behind the posting's FOR SHARE on the SKU.
        change = call('PATCH', `/skus/${sku.id}/code`, {
          cookie: admin,
          body: { updatedAt: sku.updatedAt, sku: 'CRACE-SKU-2' },
        });
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [posted, changed] = await Promise.all([posting, change]);
      expect(posted?.status).toBe(201);
      expect(changed?.status).toBe(409);
      expect(changed?.body).toMatchObject({ code: 'CODE_LOCKED' });
      expect((await getSku(sku.id)).code).toBe('CRACE-SKU');
    });

    it('a location code change waits behind an in flight posting, then answers CODE_LOCKED', async () => {
      const sku = await newSku('CRACE-LOC');
      const warehouse = await newLocation('WH-CRACE2');
      const release = await holdPair(sku.id, warehouse.id);
      let posting: ReturnType<typeof receipt> | undefined;
      let change: ReturnType<typeof call> | undefined;
      try {
        posting = receipt(warehouse.id, sku.id, 2);
        await waitForLockWaits(1);
        change = call('PATCH', `/locations/${warehouse.id}`, {
          cookie: admin,
          body: { updatedAt: warehouse.updatedAt, code: 'WH-CRACE2B' },
        });
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [posted, changed] = await Promise.all([posting, change]);
      expect(posted?.status).toBe(201);
      expect(changed?.status).toBe(409);
      expect(changed?.body).toMatchObject({ code: 'CODE_LOCKED' });
      const { rows } = await owner.pool.query('SELECT code FROM locations WHERE id = $1', [
        warehouse.id,
      ]);
      expect(rows).toEqual([{ code: 'WH-CRACE2' }]);
    });
  });

  describe('rebuild race (AC-3, AC-17)', () => {
    it('a rebuild in flight first: a SKU archive waits, then sees the rebuilt stock', async () => {
      const sku = await newSku('RB-SKU');
      const warehouse = await newLocation('WH-RB1');
      const discrepancyId = await driftedToZero(sku.id, warehouse.id, 5);
      const release = await holdPair(sku.id, warehouse.id);
      let rebuild: Promise<unknown> | undefined;
      let archive: ReturnType<typeof call> | undefined;
      try {
        // The rebuild reads the SKU and location FOR SHARE, then waits on the held pair lock.
        rebuild = reconciliation.rebuildLevel({ discrepancyId, resolvedBy: randomUUID() });
        await waitForLockWaits(1);
        // Without the rebuild's FOR SHARE the archive would read the drifted 0 and archive.
        archive = call('POST', `/skus/${sku.id}/archive`, { cookie: admin });
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [rebuilt, archived] = await Promise.all([rebuild, archive]);
      expect(rebuilt).toMatchObject({ onHand: 5 });
      expect(archived?.status).toBe(409);
      expect(archived?.body).toMatchObject({ code: 'STOCK_ON_HAND' });
    });

    it('a rebuild in flight first: a location archive waits, then sees the rebuilt stock', async () => {
      const sku = await newSku('RB-LOC');
      const warehouse = await newLocation('WH-RB2');
      const discrepancyId = await driftedToZero(sku.id, warehouse.id, 3);
      const release = await holdPair(sku.id, warehouse.id);
      let rebuild: Promise<unknown> | undefined;
      let archive: ReturnType<typeof call> | undefined;
      try {
        rebuild = reconciliation.rebuildLevel({ discrepancyId, resolvedBy: randomUUID() });
        await waitForLockWaits(1);
        archive = call('POST', `/locations/${warehouse.id}/archive`, { cookie: admin });
        await waitForLockWaits(2);
      } finally {
        await release();
      }
      const [rebuilt, archived] = await Promise.all([rebuild, archive]);
      expect(rebuilt).toMatchObject({ onHand: 3 });
      expect(archived?.status).toBe(409);
      expect(archived?.body).toMatchObject({ code: 'STOCK_ON_HAND' });
    });

    it('a SKU archive in flight first: the rebuild waits until the archive commits', async () => {
      const sku = await newSku('RB-SKU-REV');
      const warehouse = await newLocation('WH-RB3');
      const discrepancyId = await driftedToZero(sku.id, warehouse.id, 2);
      // The archive takes FOR UPDATE on the SKU row, then waits to update the held product row.
      const release = await holdRow('products', sku.productId);
      let archive: ReturnType<typeof call> | undefined;
      let rebuild: Promise<unknown> | undefined;
      try {
        archive = call('POST', `/skus/${sku.id}/archive`, { cookie: admin });
        await waitForLockWaits(1);
        rebuild = reconciliation.rebuildLevel({ discrepancyId, resolvedBy: randomUUID() });
        await waitForLockWaits(2);
        expect(await settled(rebuild)).toBe(false);
      } finally {
        await release();
      }
      const [archived, rebuilt] = await Promise.all([archive, rebuild]);
      expect(archived?.status).toBe(200);
      expect(rebuilt).toMatchObject({ onHand: 2 });
    });

    it('a location archive holding the row first: the rebuild waits until it commits', async () => {
      const sku = await newSku('RB-LOC-REV');
      const warehouse = await newLocation('WH-RB4');
      const discrepancyId = await driftedToZero(sku.id, warehouse.id, 2);
      // An archive transaction stopped right after `lockForArchive`, before its commit.
      let open = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      let locked = () => {};
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const archive = ledgerTransaction(app.db, async (tx) => {
        const row = await ledger.lockForArchive(tx, { locationId: warehouse.id });
        locked();
        await gate;
        return row;
      });
      let rebuild: Promise<unknown> | undefined;
      try {
        await holding;
        rebuild = reconciliation.rebuildLevel({ discrepancyId, resolvedBy: randomUUID() });
        await waitForLockWaits(1);
        expect(await settled(rebuild)).toBe(false);
      } finally {
        open();
      }
      expect(await archive).toEqual({ id: warehouse.id, archived: false });
      expect(await rebuild).toMatchObject({ onHand: 2 });
    });
  });

  describe('location management (AC-4, AC-15)', () => {
    it('answers 503 BUSY with Retry-After when a location create waits too long for its party', async () => {
      const party = await owner.pool.query<{ id: string }>(
        "INSERT INTO parties (code, name, is_consignment_partner) VALUES ('BUSY-P', 'Partner', true) RETURNING id",
      );
      const holder = await owner.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM parties WHERE id = $1 FOR UPDATE', [party.rows[0]?.id]);

        const answer = await call('POST', '/locations', {
          cookie: admin,
          body: {
            code: 'BUSY-1',
            name: { en: 'Busy' },
            kind: 'shop',
            ownerType: 'consignment_partner',
            partyId: party.rows[0]?.id,
          },
        });

        expect(answer.status).toBe(503);
        expect(answer.body).toMatchObject({ code: 'BUSY' });
        expect(answer.headers.get('retry-after')).not.toBeNull();
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    const locations = async (query: string, cookie = admin) =>
      call('GET', `/locations${query}`, { cookie });

    it('lists with codeLocked and updatedAt, archived ones for admins only', async () => {
      const fresh = await newLocation('LST-FRESH');
      const used = await newLocation('LST-USED');
      const sku = await newSku('LST-SKU');
      await receiveOne(used.id, sku.id, 1);
      const page = LocationListResponse.parse((await locations('', staff)).body);
      const byCode = new Map(page.items.map((item) => [item.code, item]));
      expect(byCode.get('LST-FRESH')).toMatchObject({ codeLocked: false, archived: false });
      expect(byCode.get('LST-USED')).toMatchObject({ codeLocked: true });
      expect(byCode.get('LST-FRESH')?.updatedAt).toMatch(MICROSECONDS);
      // The seeded system locations never appear.
      expect(byCode.has('TRANSIT')).toBe(false);
      expect(byCode.has('SCRAP')).toBe(false);

      const archivedForStaff = await locations('?status=archived', staff);
      expect(archivedForStaff.status).toBe(403);
      expect(archivedForStaff.body).toMatchObject({ code: 'FORBIDDEN' });
      expect((await call('POST', `/locations/${fresh.id}/archive`, { cookie: admin })).status).toBe(
        200,
      );
      const archived = LocationListResponse.parse((await locations('?status=archived')).body);
      expect(archived.items.map((item) => item.code)).toContain('LST-FRESH');
      const active = LocationListResponse.parse((await locations('')).body);
      expect(active.items.map((item) => item.code)).not.toContain('LST-FRESH');
    });

    it('edits name, type, and code with the stale check; the code locks after a receipt', async () => {
      const place = await newLocation('ED-1');
      expect(
        (
          await call('PATCH', `/locations/${place.id}`, {
            cookie: staff,
            body: { updatedAt: place.updatedAt, name: { en: 'x' } },
          })
        ).status,
      ).toBe(403);
      const edit = (body: object) =>
        call('PATCH', `/locations/${place.id}`, { cookie: admin, body });
      const first = await edit({
        updatedAt: place.updatedAt,
        name: { en: 'Front store', ar: 'المتجر' },
        kind: 'shop',
        code: 'ed-2',
      });
      expect(first.status).toBe(200);
      const edited = LocationDetail.parse(first.body);
      expect(edited).toMatchObject({ code: 'ED-2', kind: 'shop', codeLocked: false });
      expect((await edit({ updatedAt: place.updatedAt, name: { en: 'Late' } })).body).toMatchObject(
        { code: 'STALE_RECORD' },
      );
      await newLocation('ED-TAKEN');
      expect((await edit({ updatedAt: edited.updatedAt, code: 'ED-TAKEN' })).body).toMatchObject({
        code: 'LOCATION_CODE_TAKEN',
      });

      const sku = await newSku('ED-SKU');
      await receiveOne(place.id, sku.id, 1);
      const current = LocationListResponse.parse((await locations('')).body).items.find(
        (item) => item.id === place.id,
      );
      expect(current?.codeLocked).toBe(true);
      const locked = await edit({ updatedAt: current?.updatedAt, code: 'ED-3' });
      expect(locked.status).toBe(409);
      expect(locked.body).toMatchObject({ code: 'CODE_LOCKED' });
      // The same code and a name change still go through.
      const renamed = await edit({
        updatedAt: current?.updatedAt,
        code: 'ED-2',
        name: { en: 'R' },
      });
      expect(renamed.status).toBe(200);
    });

    it('lets one of two edits from the same updatedAt win; the other is STALE_RECORD', async () => {
      const place = await newLocation('ED-RACE');
      const edit = (en: string) =>
        call('PATCH', `/locations/${place.id}`, {
          cookie: admin,
          body: { updatedAt: place.updatedAt, name: { en } },
        });
      const results = await Promise.all([edit('First'), edit('Second')]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const loser = results.find((result) => result.status === 409);
      const winner = LocationDetail.parse(results.find((result) => result.status === 200)?.body);
      expect(loser?.body).toMatchObject({ code: 'STALE_RECORD' });
      const current = LocationListResponse.parse((await locations('')).body).items.find(
        (item) => item.id === place.id,
      );
      expect(current?.name).toEqual(winner.name);
      expect(current?.updatedAt).toBe(winner.updatedAt);
    });

    it('archives only an empty location, unarchives it, and deletes only an unused one', async () => {
      const stocked = await newLocation('AR-STOCK');
      const sku = await newSku('AR-SKU');
      await receiveOne(stocked.id, sku.id, 3);
      expect(
        (await call('POST', `/locations/${stocked.id}/archive`, { cookie: staff })).status,
      ).toBe(403);
      const refused = await call('POST', `/locations/${stocked.id}/archive`, { cookie: admin });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'STOCK_ON_HAND' });
      const inUse = await call('DELETE', `/locations/${stocked.id}`, { cookie: admin });
      expect(inUse.status).toBe(409);
      expect(inUse.body).toMatchObject({ code: 'IN_USE' });

      const empty = await newLocation('AR-EMPTY');
      const archived = await call('POST', `/locations/${empty.id}/archive`, { cookie: admin });
      expect(LocationDetail.parse(archived.body).archived).toBe(true);
      // An archived location takes no receipt.
      expect((await receipt(empty.id, sku.id, 1)).body).toMatchObject({ code: 'INVALID_LOCATION' });
      const back = await call('POST', `/locations/${empty.id}/unarchive`, { cookie: admin });
      expect(LocationDetail.parse(back.body).archived).toBe(false);

      const binned = await newLocation('AR-BIN');
      await owner.pool.query(`INSERT INTO bins (location_id, code) VALUES ($1, 'A-1')`, [
        binned.id,
      ]);
      expect(
        (await call('DELETE', `/locations/${binned.id}`, { cookie: admin })).body,
      ).toMatchObject({ code: 'IN_USE' });

      expect((await call('DELETE', `/locations/${empty.id}`, { cookie: staff })).status).toBe(403);
      expect((await call('DELETE', `/locations/${empty.id}`, { cookie: admin })).status).toBe(204);
      expect((await call('DELETE', `/locations/${empty.id}`, { cookie: admin })).status).toBe(404);
    });

    it('answers 404 for the seeded transit and virtual locations on every management endpoint', async () => {
      const { rows } = await owner.pool.query<{ id: string; updated_at: string }>(
        `SELECT id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM locations WHERE kind IN ('transit', 'virtual')`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        const answers = await Promise.all([
          call('PATCH', `/locations/${row.id}`, {
            cookie: admin,
            body: { updatedAt: row.updated_at, name: { en: 'Mine' } },
          }),
          call('POST', `/locations/${row.id}/archive`, { cookie: admin }),
          call('POST', `/locations/${row.id}/unarchive`, { cookie: admin }),
          call('DELETE', `/locations/${row.id}`, { cookie: admin }),
        ]);
        expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404]);
      }
      // A malformed id is a location that does not exist.
      expect((await call('POST', '/locations/not-a-uuid/archive', { cookie: admin })).status).toBe(
        404,
      );
    });
  });

  describe('SKU detail history (AC-10, AC-11)', () => {
    it('lists movements newest first with the receipt number, the void row, and who posted', async () => {
      const sku = await newSku('HIST-1');
      const warehouse = await newLocation('WH-HIST');
      const posted = await receiveOne(warehouse.id, sku.id, 10, '5');
      await voidReceipt(posted.id);

      const asStaff = SkuMovementsResponse.parse(
        (await call('GET', `/skus/${sku.id}/movements`, { cookie: staff })).body,
      );
      expect(asStaff.items).toHaveLength(2);
      expect(asStaff.items[0]).toMatchObject({
        quantity: -10,
        isReversal: true,
        sourceType: 'stock_receipt',
        source: { id: posted.id, number: posted.number },
        location: { code: 'WH-HIST' },
        postedBy: { name: 'Test Person' },
      });
      expect(asStaff.items[1]).toMatchObject({
        quantity: 10,
        isReversal: false,
        source: { number: posted.number },
      });
      expect(asStaff.items[0]?.effectiveAt).toMatch(MICROSECONDS);
      for (const item of asStaff.items) {
        expect(item).not.toHaveProperty('unitCost');
        expect(item).not.toHaveProperty('totalCost');
      }

      const asAdmin = SkuMovementsResponse.parse(
        (await call('GET', `/skus/${sku.id}/movements`, { cookie: admin })).body,
      );
      expect(asAdmin.items[1]).toMatchObject({ unitCost: '5.0000', totalCost: '50.00' });
      expect(asAdmin.items[0]).toMatchObject({ totalCost: '-50.00' });
    });

    it('shows a system posting as System (null) with no link, and pages with load more', async () => {
      const sku = await newSku('HIST-2');
      const warehouse = await newLocation('WH-HIST2');
      await receiveOne(warehouse.id, sku.id, 1);
      await receiveOne(warehouse.id, sku.id, 2);
      await receiveOne(warehouse.id, sku.id, 3);
      // A system posting: no person, and a source with no page to link to.
      await ledger.post({
        idempotencyKey: randomUUID(),
        sourceType: 'adjustment',
        sourceId: randomUUID(),
        postedBy: null,
        lines: [{ variantId: sku.id, locationId: warehouse.id, quantity: 4, unitCost: '1' }],
      });
      const newest = SkuMovementsResponse.parse(
        (await call('GET', `/skus/${sku.id}/movements?limit=1`, { cookie: staff })).body,
      ).items[0];
      expect(newest).toMatchObject({
        quantity: 4,
        sourceType: 'adjustment',
        isReversal: false,
        source: null,
        postedBy: null,
      });

      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page: SkuMovementsResponse = SkuMovementsResponse.parse(
          (
            await call(
              'GET',
              `/skus/${sku.id}/movements?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
              { cookie: staff },
            )
          ).body,
        );
        seen.push(...page.items.map((item) => item.quantity));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([4, 3, 2, 1]);

      const bad = await call('GET', `/skus/${sku.id}/movements?cursor=nope`, { cookie: staff });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'INVALID_QUERY' });
      // Well formed base64url JSON, but not a timestamp and an id: 400, never a cast error.
      const forged = encodeKeyset(['x', 'y']);
      for (const path of [
        `/skus/${sku.id}/movements?cursor=${forged}`,
        `/stock?cursor=${forged}`,
      ]) {
        const answer = await call('GET', path, { cookie: staff });
        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({ code: 'INVALID_QUERY' });
      }
      expect(
        (await call('GET', `/skus/${sku.id}/movements?limit=51`, { cookie: staff })).status,
      ).toBe(400);
      expect((await call('GET', `/skus/${randomUUID()}/movements`, { cookie: staff })).status).toBe(
        404,
      );
    });

    it('gives staff the per location stock without value, admins with it', async () => {
      const sku = await newSku('HIST-3');
      const north = await newLocation('WH-H3N');
      const south = await newLocation('WH-H3S');
      await receiveOne(north.id, sku.id, 4, '2');
      await receiveOne(south.id, sku.id, 6, '1');
      const asStaff = (await call('GET', `/skus/${sku.id}/stock`, { cookie: staff })).body;
      expect(asStaff).toMatchObject({ totalOnHand: 10 });
      expect(asStaff).not.toHaveProperty('totalValue');
      expect(JSON.stringify(asStaff)).not.toMatch(/avgUnitCost|totalValue/);
      expect((await call('GET', `/skus/${sku.id}/stock`, { cookie: admin })).body).toMatchObject({
        totalOnHand: 10,
        totalValue: '14.00',
      });
    });
  });

  describe('archive at scale (AC-3, AC-4)', () => {
    it('archives a location with 10,000 zero balance rows, with no advisory lock and a flat lock count', async () => {
      const bulk = await newLocation('WH-BULK');
      const empty = await newLocation('WH-BULK-EMPTY');
      // Test only: 10,000 SKUs with a zero balance at the location, and some released reservations.
      await owner.pool.query(
        `WITH p AS (
           INSERT INTO products (style_code, product_group_id, name)
           SELECT 'ZBULK-STYLE-' || g, (SELECT id FROM product_groups WHERE code = 'MAIN'), jsonb_build_object('en', 'Bulk product ' || g) FROM generate_series(1, 10000) g
           RETURNING id
         ), v AS (
           INSERT INTO product_variants (product_id, sku, base_uom_id)
           SELECT id, 'ZBULK-' || id, (SELECT id FROM uoms WHERE code = 'pc') FROM p
           RETURNING id
         )
         INSERT INTO stock_levels (variant_id, location_id) SELECT id, $1 FROM v`,
        [bulk.id],
      );
      await owner.pool.query(
        `INSERT INTO reservations (variant_id, location_id, quantity, open_quantity, status,
                                   source_type, source_id, source_line_id, closed_at)
         SELECT variant_id, location_id, 1, 0, 'released', 'sales_order', uuidv7(), uuidv7(), now()
         FROM stock_levels WHERE location_id = $1 LIMIT 100`,
        [bulk.id],
      );
      await owner.pool.query('ANALYZE stock_levels');

      // The locks an archive transaction holds after `lockForArchive` and `usage`.
      const locksHeld = (locationId: string) =>
        ledgerTransaction(app.db, async (tx) => {
          await ledger.lockForArchive(tx, { locationId });
          const usage = (await ledger.usage({ locationIds: [locationId] }, tx)).get(locationId);
          const { rows } = await tx.execute<{ total: number; advisory: number }>(sql`
            SELECT count(*)::int AS total,
                   (count(*) FILTER (WHERE locktype = 'advisory'))::int AS advisory
            FROM pg_locks WHERE pid = pg_backend_pid()`);
          return { usage, locks: rows[0] };
        });
      const atScale = await locksHeld(bulk.id);
      const baseline = await locksHeld(empty.id);
      expect(atScale.usage).toEqual({
        hasBalance: true,
        onHandNonZero: false,
        activeReserved: false,
      });
      expect(atScale.locks?.advisory).toBe(0);
      expect(atScale.locks?.total).toBe(baseline.locks?.total);

      const archived = await call('POST', `/locations/${bulk.id}/archive`, { cookie: admin });
      expect(archived.status).toBe(200);
      expect(LocationDetail.parse(archived.body)).toMatchObject({
        archived: true,
        codeLocked: true,
      });
    });
  });

  it('answers 401 on every new endpoint without a session', async () => {
    const id = randomUUID();
    const answers = await Promise.all([
      call('PATCH', `/skus/${id}`, { body: {} }),
      call('PATCH', `/skus/${id}/code`, { body: {} }),
      call('POST', `/skus/${id}/archive`),
      call('POST', `/skus/${id}/unarchive`),
      call('DELETE', `/skus/${id}`),
      call('GET', `/skus/${id}/usage`),
      call('GET', `/skus/${id}/movements`),
      call('GET', '/locations?status=archived'),
      call('PATCH', `/locations/${id}`, { body: {} }),
      call('POST', `/locations/${id}/archive`),
      call('POST', `/locations/${id}/unarchive`),
      call('DELETE', `/locations/${id}`),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual(answers.map(() => 401));
  });
});
