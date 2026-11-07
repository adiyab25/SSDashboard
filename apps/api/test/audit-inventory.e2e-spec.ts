import {
  AuditEntryListResponse,
  LocationDetail,
  SkuDetail,
  type AuditEntryView,
} from '@ssdashboard/contracts';
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

// Spec 0010, milestone 2 task 10 (AC-5, AC-11): the inventory master data actions record their
// entry in their own transaction, through the built api. This file is the registry `proof` of
// sku.archived, sku.unarchived, sku.code_changed, location.edited, location.archived, and
// location.unarchived. A no op changes nothing and records nothing; a refused action records
// nothing.
describe('audit trail: SKU and location actions (spec 0010)', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let admin: string;
  let adminId: string;

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
    admin = await signInAs(base, owner.pool, {
      email: 'admin@example.com',
      access: { hats: ['manager'], costView: true },
    });
    const { rows } = await owner.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'admin@example.com'",
    );
    adminId = rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie: admin,
        origin: base,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
  }

  /** The entries of one record, oldest first. */
  async function entriesOf(type: string, id: string): Promise<AuditEntryView[]> {
    const page = await call('GET', `/audit/entries?recordType=${type}&recordId=${id}`);
    expect(page.status).toBe(200);
    return AuditEntryListResponse.parse(page.body).items.reverse();
  }

  const byAdmin = () => ({
    actor: { kind: 'person', userId: adminId, hat: 'manager', ref: null, jobId: null },
  });

  async function newSku(code: string): Promise<SkuDetail> {
    const created = await call('POST', '/products', {
      name: { en: code },
      variants: [{ sku: code, price: '10' }],
    });
    expect(created.status).toBe(201);
    return SkuDetail.parse(created.body);
  }

  it('records sku.code_changed with the old and new code, and nothing for the same code', async () => {
    const sku = await newSku('AUD-OLD');

    const changed = await call('PATCH', `/skus/${sku.id}/code`, {
      sku: 'AUD-NEW',
      updatedAt: sku.updatedAt,
    });
    expect(changed.status).toBe(200);
    const after = SkuDetail.parse(changed.body);
    const same = await call('PATCH', `/skus/${sku.id}/code`, {
      sku: 'AUD-NEW',
      updatedAt: after.updatedAt,
    });
    expect(same.status).toBe(200);

    expect(await entriesOf('sku', sku.id)).toEqual([
      expect.objectContaining({
        ...byAdmin(),
        action: 'sku.code_changed',
        record: { type: 'sku', id: sku.id, label: 'AUD-NEW' },
        before: { code: 'AUD-OLD' },
        after: { code: 'AUD-NEW' },
        reason: null,
        personalFields: [],
      }),
    ]);
  });

  it('records sku.archived and sku.unarchived, once each, with the code as label', async () => {
    const sku = await newSku('AUD-ARC');

    expect((await call('POST', `/skus/${sku.id}/archive`)).status).toBe(200);
    expect((await call('POST', `/skus/${sku.id}/archive`)).status).toBe(200);
    expect((await call('POST', `/skus/${sku.id}/unarchive`)).status).toBe(200);

    const entries = await entriesOf('sku', sku.id);
    expect(entries.map((entry) => entry.action)).toEqual(['sku.archived', 'sku.unarchived']);
    expect(entries[0]).toMatchObject({
      ...byAdmin(),
      record: { label: 'AUD-ARC' },
      before: { archived: false },
      after: { archived: true },
    });
    expect(entries[1]).toMatchObject({ before: { archived: true }, after: { archived: false } });
  });

  async function newLocation(code: string): Promise<LocationDetail> {
    const created = await call('POST', '/locations', {
      code,
      name: { en: `Store ${code}` },
      kind: 'warehouse',
    });
    expect(created.status).toBe(201);
    return LocationDetail.parse(created.body);
  }

  it('records location.edited with only the fields that changed', async () => {
    const location = await newLocation('AUD-L1');

    const edited = await call('PATCH', `/locations/${location.id}`, {
      updatedAt: location.updatedAt,
      name: { en: 'Store renamed', ar: 'مخزن' },
    });
    expect(edited.status).toBe(200);
    const after = LocationDetail.parse(edited.body);
    // Saving the same values again changes nothing, so it records nothing.
    const again = await call('PATCH', `/locations/${location.id}`, {
      updatedAt: after.updatedAt,
      name: { en: 'Store renamed', ar: 'مخزن' },
    });
    expect(again.status).toBe(200);

    expect(await entriesOf('location', location.id)).toEqual([
      expect.objectContaining({
        ...byAdmin(),
        action: 'location.edited',
        record: { type: 'location', id: location.id, label: 'AUD-L1' },
        before: { name: { en: 'Store AUD-L1' } },
        after: { name: { en: 'Store renamed', ar: 'مخزن' } },
      }),
    ]);
  });

  it('records location.archived and location.unarchived, once each', async () => {
    const location = await newLocation('AUD-L2');

    expect((await call('POST', `/locations/${location.id}/archive`)).status).toBe(200);
    expect((await call('POST', `/locations/${location.id}/archive`)).status).toBe(200);
    expect((await call('POST', `/locations/${location.id}/unarchive`)).status).toBe(200);

    const entries = await entriesOf('location', location.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      'location.archived',
      'location.unarchived',
    ]);
    expect(entries[0]).toMatchObject({
      ...byAdmin(),
      record: { label: 'AUD-L2' },
      before: { archived: false },
      after: { archived: true },
    });
  });

  it('records nothing when the action is refused', async () => {
    const sku = await newSku('AUD-STOCKED');
    const location = await newLocation('AUD-L3');
    const receipt = await fetch(`${base}/api/stock-receipts`, {
      method: 'POST',
      headers: {
        cookie: admin,
        origin: base,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        locationId: location.id,
        lines: [{ skuId: sku.id, quantity: 2, unitCost: '1' }],
      }),
    });
    expect(receipt.status).toBe(201);

    expect((await call('POST', `/skus/${sku.id}/archive`)).status).toBe(409);
    expect((await call('POST', `/locations/${location.id}/archive`)).status).toBe(409);

    expect(await entriesOf('sku', sku.id)).toEqual([]);
    expect(await entriesOf('location', location.id)).toEqual([]);
  });

  // Security review AS16: a SKU or location coded like a phone number is a code, not a phone.
  // Its actions succeed and the entry keeps the code, in the label and in the diff.
  it('archives and renames a SKU and a location coded 01012345678, keeping the codes', async () => {
    const sku = await newSku('01012345678');
    const renamed = await call('PATCH', `/skus/${sku.id}/code`, {
      sku: '01012345679',
      updatedAt: sku.updatedAt,
    });
    expect(renamed.status).toBe(200);
    expect((await call('POST', `/skus/${sku.id}/archive`)).status).toBe(200);

    expect(await entriesOf('sku', sku.id)).toEqual([
      expect.objectContaining({
        action: 'sku.code_changed',
        record: { type: 'sku', id: sku.id, label: '01012345679' },
        before: { code: '01012345678' },
        after: { code: '01012345679' },
        personalFields: [],
      }),
      expect.objectContaining({
        action: 'sku.archived',
        record: { type: 'sku', id: sku.id, label: '01012345679' },
      }),
    ]);

    const location = await newLocation('01012345678');
    const edited = await call('PATCH', `/locations/${location.id}`, {
      updatedAt: location.updatedAt,
      name: { en: 'Phone shaped store' },
    });
    expect(edited.status).toBe(200);
    expect((await call('POST', `/locations/${location.id}/archive`)).status).toBe(200);

    expect(await entriesOf('location', location.id)).toEqual([
      expect.objectContaining({
        action: 'location.edited',
        record: { type: 'location', id: location.id, label: '01012345678' },
      }),
      expect.objectContaining({
        action: 'location.archived',
        record: { type: 'location', id: location.id, label: '01012345678' },
      }),
    ]);
  });
});
