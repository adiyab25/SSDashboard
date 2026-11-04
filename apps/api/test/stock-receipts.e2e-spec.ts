import { randomUUID } from 'node:crypto';
import {
  SkuDetail,
  SkuListResponse,
  SkuStockResponse,
  StockListResponse,
  StockReceiptDetail,
} from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../src/inventory/ledger/reconciliation.service.js';
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

// Spec 0006, Milestone 1: the thin thread through the built api against PostgreSQL.
describe('core stock loop api', { timeout: 90_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let app: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let staff: string;
  let admin: string;
  const year = new Date().getUTCFullYear();

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    app = createDatabase(appUrl.toString(), { max: 2 });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
    });
    await waitForHttp(`${base}/api/health`, api);
    staff = await signInAs(base, owner.pool, { email: 'staff@example.com', role: 'staff' });
    admin = await signInAs(base, owner.pool, { email: 'admin@example.com', role: 'admin' });
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
      body: { code, name: { en: `Warehouse ${code}` }, type: 'warehouse' },
    });
    expect(status).toBe(201);
    return body as { id: string };
  }

  function receipt(key: string, body: unknown, cookie = staff) {
    return call('POST', '/stock-receipts', {
      cookie,
      body,
      headers: { 'idempotency-key': key },
    });
  }

  it('runs the thread: SKU, warehouse, receipt, stock on hand from the ledger (AC-17)', async () => {
    const sku = await newSku(' tee-blk-m ');
    expect(sku).toMatchObject({ code: 'TEE-BLK-M', price: '19.99', status: 'active' });
    const warehouse = await newLocation('wh-cai');

    const key = randomUUID();
    const posted = await receipt(key, {
      locationId: warehouse.id,
      reference: 'DN-1',
      lines: [{ skuId: sku.id, quantity: 10, unitCost: '5' }],
    });
    expect(posted.status).toBe(201);
    const detail = StockReceiptDetail.parse(posted.body);
    expect(detail).toMatchObject({ id: key, number: `SR-${year}-000001`, status: 'posted' });
    // Staff never see cost fields (AC-11).
    expect(detail.lines[0]).not.toHaveProperty('unitCost');
    expect(detail).not.toHaveProperty('referenceValue');

    const asAdmin = StockReceiptDetail.parse(
      (await call('GET', `/stock-receipts/${key}`, { cookie: admin })).body,
    );
    expect(asAdmin.lines[0]).toMatchObject({
      quantity: 10,
      unitCost: '5.0000',
      lineTotal: '50.00',
    });
    expect(asAdmin.referenceValue).toBe('50.00');

    // One movement in the posting group, linked to the line.
    const { rows } = await owner.pool.query<{ source_line_id: string; quantity: number }>(
      `SELECT m.source_line_id, m.quantity FROM stock_movements m
       JOIN stock_receipts r ON r.movement_group_id = m.group_id WHERE r.id = $1`,
      [key],
    );
    expect(rows).toEqual([{ source_line_id: asAdmin.lines[0]?.id, quantity: 10 }]);

    const stockAsStaff = StockListResponse.parse(
      (await call('GET', `/stock?locationId=${warehouse.id}`, { cookie: staff })).body,
    );
    expect(stockAsStaff.items).toHaveLength(1);
    expect(stockAsStaff.items[0]).toMatchObject({ onHand: 10, negative: false });
    expect(stockAsStaff.items[0]).not.toHaveProperty('totalValue');
    const stockAsAdmin = StockListResponse.parse(
      (await call('GET', `/stock?skuId=${sku.id}`, { cookie: admin })).body,
    );
    expect(stockAsAdmin.items[0]).toMatchObject({
      onHand: 10,
      avgUnitCost: '5.0000',
      totalValue: '50.00',
      sku: { code: 'TEE-BLK-M' },
    });

    const perLocation = SkuStockResponse.parse(
      (await call('GET', `/skus/${sku.id}/stock`, { cookie: admin })).body,
    );
    expect(perLocation).toMatchObject({ totalOnHand: 10, totalValue: '50.00' });

    expect(await new ReconciliationService(app).reconcile()).toBe(0);
  });

  it('replays the same key and body once, and refuses a changed body (AC-6)', async () => {
    const sku = await newSku('REPLAY-1');
    const warehouse = await newLocation('WH-REP');
    const key = randomUUID();
    const body = {
      locationId: warehouse.id,
      note: 'first',
      lines: [{ skuId: sku.id, quantity: 2, unitCost: '1.5' }],
    };

    const [a, b] = await Promise.all([receipt(key, body), receipt(key, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
    // An admin's replay of a staff receipt shows cost; a staff replay never does.
    expect((await receipt(key, body)).body).not.toHaveProperty('referenceValue');

    expect((await receipt(key, { ...body, note: 'second' })).body).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(
      (await receipt(key, { ...body, lines: [{ skuId: sku.id, quantity: 3, unitCost: '1.5' }] }))
        .status,
    ).toBe(409);

    const stock = StockListResponse.parse(
      (await call('GET', `/stock?skuId=${sku.id}`, { cookie: staff })).body,
    );
    expect(stock.items[0]?.onHand).toBe(2);
  });

  it('needs a UUID Idempotency-Key header', async () => {
    const response = await call('POST', '/stock-receipts', {
      cookie: staff,
      body: {
        locationId: randomUUID(),
        lines: [{ skuId: randomUUID(), quantity: 1, unitCost: '1' }],
      },
      headers: { 'idempotency-key': 'not-a-uuid' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('reports every line fault at once and posts nothing (AC-7)', async () => {
    const good = await newSku('LINE-OK');
    const archived = await newSku('LINE-OLD');
    await owner.pool.query('UPDATE product_variants SET archived_at = now() WHERE id = $1', [
      archived.id,
    ]);
    const warehouse = await newLocation('WH-LINES');

    const response = await receipt(randomUUID(), {
      locationId: warehouse.id,
      lines: [
        { skuId: good.id, quantity: 1, unitCost: '1' },
        { skuId: good.id, quantity: 1, unitCost: '1' },
        { skuId: archived.id, quantity: 1, unitCost: '1' },
        { skuId: randomUUID(), quantity: 1, unitCost: '1' },
      ],
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'INVALID_LINES',
      lineErrors: [
        { index: 1, code: 'DUPLICATE_SKU' },
        { index: 2, code: 'ARCHIVED' },
        { index: 3, code: 'UNKNOWN_SKU' },
      ],
    });

    const tooLarge = await receipt(randomUUID(), {
      locationId: warehouse.id,
      lines: [{ skuId: good.id, quantity: 1_000_000, unitCost: '10000' }],
    });
    expect(tooLarge.body).toMatchObject({
      code: 'INVALID_LINES',
      lineErrors: [{ index: 0, code: 'LINE_TOTAL_TOO_LARGE' }],
    });
    const { rows } = await owner.pool.query(
      `SELECT 1 FROM stock_receipt_lines WHERE variant_id = $1`,
      [good.id],
    );
    expect(rows).toEqual([]);
  });

  it('refuses a system location and a future date (AC-5, AC-7)', async () => {
    const sku = await newSku('PLACE-1');
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO locations (code, name, type) VALUES ('TR-X', '{"en": "Transit"}', 'transit') RETURNING id`,
    );
    const line = [{ skuId: sku.id, quantity: 1, unitCost: '1' }];
    expect(
      (await receipt(randomUUID(), { locationId: rows[0]?.id, lines: line })).body,
    ).toMatchObject({
      code: 'INVALID_LOCATION',
    });
    const warehouse = await newLocation('WH-DATE');
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    expect(
      (await receipt(randomUUID(), { locationId: warehouse.id, receiptDate: future, lines: line }))
        .body,
    ).toMatchObject({ code: 'FUTURE_DATE' });
  });

  it('dates an earlier day at 12:00 Cairo, numbered in that year (AC-5)', async () => {
    const sku = await newSku('BACK-1');
    const warehouse = await newLocation('WH-BACK');
    const key = randomUUID();
    const response = await receipt(key, {
      locationId: warehouse.id,
      receiptDate: '2025-12-31',
      lines: [{ skuId: sku.id, quantity: 1, unitCost: '1' }],
    });
    expect(response.status).toBe(201);
    const detail = StockReceiptDetail.parse(response.body);
    expect(detail.number).toBe('SR-2025-000001');
    // Cairo is UTC+2 in winter.
    expect(detail.effectiveAt).toBe('2025-12-31T10:00:00.000000Z');
  });

  it('stores nothing and gives the number back when a receipt write fails (AC-5)', async () => {
    const sku = await newSku('ATOM-1');
    const warehouse = await newLocation('WH-ATOM');
    // A test hook: fail the line insert for quantity 777, after the movements are written.
    await owner.pool.query(`
      CREATE FUNCTION fail_777() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.quantity = 777 THEN RAISE EXCEPTION 'test hook'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_777 BEFORE INSERT ON stock_receipt_lines
        FOR EACH ROW EXECUTE FUNCTION fail_777();`);
    try {
      const failing = await receipt(randomUUID(), {
        locationId: warehouse.id,
        lines: [{ skuId: sku.id, quantity: 777, unitCost: '1' }],
      });
      expect(failing.status).toBe(500);
      const { rows } = await owner.pool.query(
        `SELECT 1 FROM stock_levels WHERE variant_id = $1 AND on_hand <> 0`,
        [sku.id],
      );
      expect(rows).toEqual([]);
    } finally {
      await owner.pool.query(
        'DROP TRIGGER fail_777 ON stock_receipt_lines; DROP FUNCTION fail_777()',
      );
    }
    const { rows: last } = await owner.pool.query<{ number: string }>(
      `SELECT number FROM stock_receipts WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
      [`SR-${year}-%`],
    );
    const next = await receipt(randomUUID(), {
      locationId: warehouse.id,
      lines: [{ skuId: sku.id, quantity: 1, unitCost: '1' }],
    });
    const lastValue = Number(last[0]?.number.slice(-6) ?? 0);
    expect(StockReceiptDetail.parse(next.body).number).toBe(
      `SR-${year}-${String(lastValue + 1).padStart(6, '0')}`,
    );
  });

  it('answers 409 for a SKU or location code in use, and 403 for staff creating a location', async () => {
    await newSku('DUP-1');
    expect(
      (
        await call('POST', '/products', {
          cookie: staff,
          body: { name: { ar: 'قميص' }, variants: [{ sku: 'dup-1' }] },
        })
      ).body,
    ).toMatchObject({ code: 'SKU_TAKEN' });
    await newLocation('WH-DUP');
    expect(
      (
        await call('POST', '/locations', {
          cookie: admin,
          body: { code: 'wh-dup', name: { en: 'x' }, type: 'showroom' },
        })
      ).body,
    ).toMatchObject({ code: 'LOCATION_CODE_TAKEN' });
    expect(
      (
        await call('POST', '/locations', {
          cookie: staff,
          body: { code: 'WH-NO', name: { en: 'x' }, type: 'warehouse' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/products', {
          cookie: staff,
          body: { name: {}, variants: [{ sku: 'X' }] },
        })
      ).body,
    ).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('finds SKUs by code prefix and by Arabic name, escaping LIKE wildcards (AC-13)', async () => {
    await newSku('SRCH-ALPHA', { ar: 'قميص أزرق' });
    await newSku('SRCH-BETA', { en: '100% cotton' });
    const search = async (q: string) =>
      SkuListResponse.parse(
        (await call('GET', `/skus?limit=20&q=${encodeURIComponent(q)}`, { cookie: staff })).body,
      ).items.map((item) => item.code);
    expect(await search('srch-a')).toEqual(['SRCH-ALPHA']);
    expect(await search('أزرق')).toEqual(['SRCH-ALPHA']);
    expect(await search('0%')).toEqual(['SRCH-BETA']);
    expect(await search('%')).toEqual(['SRCH-BETA']);
  });

  it('answers 401 without a session', async () => {
    for (const path of [
      '/stock',
      '/skus',
      '/stock-receipts/00000000-0000-0000-0000-000000000000',
    ]) {
      expect((await call('GET', path)).status).toBe(401);
    }
  });
});
