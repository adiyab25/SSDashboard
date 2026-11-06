import { randomUUID } from 'node:crypto';
import { SkuDetail } from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Spec 0004 AC-18: Arabic digits are normalized at the api edge by the contract helpers.
describe('Arabic digit input at the api edge', { timeout: 90_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let staff: string;
  let admin: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
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
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  async function call(
    method: string,
    path: string,
    cookie: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', origin: base, ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
  }

  it('stores an Arabic digit SKU price as 1234.50 and refuses 1,5 with the field error', async () => {
    const created = await call('POST', '/products', staff, {
      name: { en: 'Digit tee' },
      variants: [{ sku: 'DIGIT-1', price: '١٢٣٤٫٥٠' }],
    });
    expect(created.status).toBe(201);
    const sku = SkuDetail.parse(created.body);
    const { rows } = await owner.pool.query<{ price: string }>(
      'SELECT price FROM product_variants WHERE id = $1',
      [sku.id],
    );
    expect(rows[0]?.price).toBe('1234.50');

    const refused = await call('POST', '/products', staff, {
      name: { en: 'Bad price' },
      variants: [{ sku: 'DIGIT-2', price: '1,5' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'INVALID_INPUT',
      issues: [{ path: 'variants.0.price' }],
    });
  });

  it('stores an Arabic digit receipt line as the integer 3 at cost 12.5000', async () => {
    const sku = SkuDetail.parse(
      (
        await call('POST', '/products', staff, {
          name: { en: 'Receipt tee' },
          variants: [{ sku: 'DIGIT-3' }],
        })
      ).body,
    );
    const warehouse = (
      await call('POST', '/locations', admin, {
        code: 'wh-dig',
        name: { en: 'Digit warehouse' },
        kind: 'warehouse',
      })
    ).body as { id: string };

    const posted = await call(
      'POST',
      '/stock-receipts',
      staff,
      { locationId: warehouse.id, lines: [{ skuId: sku.id, quantity: '٣', unitCost: '١٢٫٥٠' }] },
      { 'idempotency-key': randomUUID() },
    );
    expect(posted.status).toBe(201);
    const { rows } = await owner.pool.query<{ quantity: number; unit_cost: string }>(
      'SELECT quantity, unit_cost FROM stock_receipt_lines WHERE variant_id = $1',
      [sku.id],
    );
    expect(rows).toEqual([{ quantity: 3, unit_cost: '12.5000' }]);

    const refused = await call(
      'POST',
      '/stock-receipts',
      staff,
      { locationId: warehouse.id, lines: [{ skuId: sku.id, quantity: 1, unitCost: '1,5' }] },
      { 'idempotency-key': randomUUID() },
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ issues: [{ path: 'lines.0.unitCost' }] });
  });
});
