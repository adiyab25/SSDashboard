import { randomUUID } from 'node:crypto';
import {
  COST_FIELD_KEYS,
  MeResponse,
  SkuDetail,
  SkuMovementsResponse,
  SkuStockResponse,
  StockListResponse,
  StockReceiptDetail,
} from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  giveHats,
  signInAs,
  start,
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

/** Every key, at any depth, of a JSON answer. */
function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(value);
  return keys;
}

const costKeysIn = (value: unknown): string[] => {
  const keys = keysOf(value);
  return COST_FIELD_KEYS.filter((key) => keys.has(key));
};

// Spec 0008, milestone 1 item 8: the warehouse and manager thread through the built api. A person
// wearing only `warehouse` posts a receipt and sees stock without cost; a manager with the
// `cost.view` grant sees cost; the warehouse person gets 403 on `/api/staff`; and the cost grant
// acts on the next request with the same cookie (AC-2, AC-6).
describe('hats and permissions on the api', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let warehouse: string;
  let manager: string;
  let managerWithoutCost: string;
  let both: string;

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
    warehouse = await signInAs(base, owner.pool, {
      email: 'warehouse@example.com',
      access: { hats: ['warehouse'] },
    });
    manager = await signInAs(base, owner.pool, {
      email: 'manager@example.com',
      access: { hats: ['manager'], costView: true },
    });
    managerWithoutCost = await signInAs(base, owner.pool, {
      email: 'manager.nocost@example.com',
      access: { hats: ['manager'] },
    });
    both = await signInAs(base, owner.pool, {
      email: 'support.warehouse@example.com',
      access: { hats: ['support', 'warehouse'] },
    });
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
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: base,
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
  }

  const userIdOf = async (email: string): Promise<string> =>
    (await owner.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))
      .rows[0]?.id as string;

  it('answers GET /api/me with the hats, the sorted permissions, no partner account and no role (AC-11)', async () => {
    const reply = await call('GET', '/me', warehouse);

    expect(reply.status).toBe(200);
    const me = MeResponse.parse(reply.body);
    expect(me).toMatchObject({ hats: ['warehouse'], partnerAccountId: null, home: 'backoffice' });
    expect(me.permissions).toEqual([...me.permissions].sort());
    expect(me.permissions).toContain('stock.receive');
    expect(me.permissions).not.toContain('cost.view');
    expect(reply.body).not.toHaveProperty('role');

    const asManager = MeResponse.parse((await call('GET', '/me', manager)).body);
    expect(asManager.hats).toEqual(['manager']);
    expect(asManager.permissions).toContain('cost.view');
    expect(asManager.permissions).toContain('people.manage');
  });

  it('runs the thread: a warehouse person receives stock and sees it without cost; a manager with cost.view sees cost (AC-2, AC-6)', async () => {
    const location = await call('POST', '/locations', manager, {
      body: { code: 'wh-hats', name: { en: 'Hats warehouse' }, kind: 'warehouse' },
    });
    expect(location.status).toBe(201);
    const locationId = (location.body as { id: string }).id;

    // catalog.edit is in the warehouse hat.
    const created = await call('POST', '/products', warehouse, {
      body: { name: { en: 'Hat tee' }, variants: [{ sku: 'HAT-TEE-1', price: '19.99' }] },
    });
    expect(created.status).toBe(201);
    const sku = SkuDetail.parse(created.body);

    const posted = await call('POST', '/stock-receipts', warehouse, {
      body: {
        locationId,
        reference: 'DN-H1',
        lines: [{ skuId: sku.id, quantity: 4, unitCost: '7' }],
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(posted.status).toBe(201);
    const receipt = StockReceiptDetail.parse(posted.body);
    expect(costKeysIn(posted.body)).toEqual([]);

    const reads = [
      `/stock-receipts/${receipt.id}`,
      '/stock?limit=50',
      `/skus/${sku.id}/stock`,
      `/skus/${sku.id}/movements`,
    ];
    for (const path of reads) {
      const asWarehouse = await call('GET', path, warehouse);
      expect(asWarehouse.status, path).toBe(200);
      expect(costKeysIn(asWarehouse.body), path).toEqual([]);

      // The manager hat alone never brings cost (AC-6): only the grant does.
      const asManagerWithoutCost = await call('GET', path, managerWithoutCost);
      expect(asManagerWithoutCost.status, path).toBe(200);
      expect(costKeysIn(asManagerWithoutCost.body), path).toEqual([]);
    }

    const stock = StockListResponse.parse((await call('GET', '/stock?limit=50', manager)).body);
    expect(stock.items[0]).toMatchObject({ onHand: 4, totalValue: '28.00' });
    const forSku = SkuStockResponse.parse(
      (await call('GET', `/skus/${sku.id}/stock`, manager)).body,
    );
    expect(forSku.totalValue).toBe('28.00');
    const movements = SkuMovementsResponse.parse(
      (await call('GET', `/skus/${sku.id}/movements`, manager)).body,
    );
    expect(movements.items[0]).toMatchObject({ unitCost: '7.0000', totalCost: '28.00' });
    const asManager = StockReceiptDetail.parse(
      (await call('GET', `/stock-receipts/${receipt.id}`, manager)).body,
    );
    expect(asManager.lines[0]).toMatchObject({ unitCost: '7.0000', lineTotal: '28.00' });

    // A void needs stock.correct, which only the manager hat holds.
    const voided = await call('POST', `/stock-receipts/${receipt.id}/void`, warehouse, {
      body: { reason: 'wrong delivery' },
    });
    expect(voided.status).toBe(403);
    expect(voided.body).toEqual({ code: 'FORBIDDEN', message: 'You do not have access to this.' });
  });

  it('replays a receipt only for the person who posted it, without cost; anyone else gets 409 whatever the costs (AC-6, security review M1 and L4)', async () => {
    const location = await call('POST', '/locations', manager, {
      body: { code: 'wh-replay', name: { en: 'Replay warehouse' }, kind: 'warehouse' },
    });
    expect(location.status).toBe(201);
    const locationId = (location.body as { id: string }).id;
    const created = await call('POST', '/products', warehouse, {
      body: { name: { en: 'Replay tee' }, variants: [{ sku: 'HAT-REPLAY-1', price: '9.99' }] },
    });
    expect(created.status).toBe(201);
    const sku = SkuDetail.parse(created.body);
    const otherWarehouse = await signInAs(base, owner.pool, {
      email: 'warehouse.two@example.com',
      access: { hats: ['warehouse'] },
    });

    const key = randomUUID();
    const body = {
      locationId,
      reference: 'DN-R1',
      lines: [{ skuId: sku.id, quantity: 3, unitCost: '12.5' }],
    };
    const post = (cookie: string, payload: unknown = body) =>
      call('POST', '/stock-receipts', cookie, {
        body: payload,
        headers: { 'idempotency-key': key },
      });
    expect((await post(warehouse)).status).toBe(201);

    // The poster's own replay: 200, the same receipt, and no cost field without cost.view.
    const replay = await post(warehouse);
    expect(replay.status).toBe(200);
    expect(StockReceiptDetail.parse(replay.body).id).toBe(key);
    expect(costKeysIn(replay.body)).toEqual([]);

    // Anyone else gets 409 with the right costs and with wrong ones alike, so the answer never
    // confirms a guessed unit cost; holding cost.view changes nothing.
    const wrongCost = { ...body, lines: [{ skuId: sku.id, quantity: 3, unitCost: '99' }] };
    for (const cookie of [otherWarehouse, both, manager]) {
      for (const payload of [body, wrongCost]) {
        const reply = await post(cookie, payload);
        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
    }

    // The stock moved once.
    const forSku = SkuStockResponse.parse(
      (await call('GET', `/skus/${sku.id}/stock`, warehouse)).body,
    );
    expect(forSku.totalOnHand).toBe(3);

    // A void answer to a manager without cost.view carries no cost field either.
    const voided = await call('POST', `/stock-receipts/${key}/void`, managerWithoutCost, {
      body: { reason: 'counted twice' },
    });
    expect(voided.status).toBe(200);
    expect(StockReceiptDetail.parse(voided.body).status).toBe('voided');
    expect(costKeysIn(voided.body)).toEqual([]);
  });

  it('answers 403 FORBIDDEN on /api/staff to a warehouse person, before any body is read (AC-4)', async () => {
    for (const [method, path, body] of [
      ['GET', '/staff', undefined],
      ['POST', '/staff', { nonsense: true }],
    ] as const) {
      const reply = await call(method, path, warehouse, { body });
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body).toEqual({ code: 'FORBIDDEN', message: 'You do not have access to this.' });
    }
    expect((await call('GET', '/staff', manager)).status).toBe(200);
  });

  it('answers GET /api/me for support plus warehouse with both hats and the sorted union of their permissions (AC-2, AC-11)', async () => {
    const supportOnly = await signInAs(base, owner.pool, {
      email: 'support.me@example.com',
      access: { hats: ['support'] },
    });
    const warehouseMe = MeResponse.parse((await call('GET', '/me', warehouse)).body);
    const supportMe = MeResponse.parse((await call('GET', '/me', supportOnly)).body);

    const reply = await call('GET', '/me', both);
    expect(reply.status).toBe(200);
    const me = MeResponse.parse(reply.body);
    expect(me).toMatchObject({
      hats: ['support', 'warehouse'],
      partnerAccountId: null,
      home: 'backoffice',
    });
    expect(me.permissions).toEqual(
      [...new Set([...supportMe.permissions, ...warehouseMe.permissions])].sort(),
    );
    expect(me.permissions).not.toContain('cost.view');
    expect(me.permissions).not.toContain('people.manage');
  });

  it('lets a person with support and warehouse reach the routes of both hats, and nothing else (AC-2)', async () => {
    // No route needs a permission that support holds and warehouse lacks yet (orders, customers
    // and exchanges come later), so the union shows on a warehouse only write: the same POST is
    // 201 with both hats and 403 with support alone.
    const supportOnly = await signInAs(base, owner.pool, {
      email: 'support.only@example.com',
      access: { hats: ['support'] },
    });
    const location = await call('POST', '/locations', manager, {
      body: { code: 'wh-union', name: { en: 'Union warehouse' }, kind: 'warehouse' },
    });
    expect(location.status).toBe(201);
    const created = await call('POST', '/products', both, {
      body: { name: { en: 'Union tee' }, variants: [{ sku: 'HAT-UNION-1', price: '5.00' }] },
    });
    expect(created.status).toBe(201);
    const receiptBody = {
      locationId: (location.body as { id: string }).id,
      lines: [{ skuId: SkuDetail.parse(created.body).id, quantity: 1, unitCost: '2' }],
    };
    const received = await call('POST', '/stock-receipts', both, {
      body: receiptBody,
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(received.status).toBe(201);
    expect(costKeysIn(received.body)).toEqual([]);
    const refused = await call('POST', '/stock-receipts', supportOnly, {
      body: receiptBody,
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'FORBIDDEN', message: 'You do not have access to this.' });
    expect((await call('GET', '/stock?limit=1', supportOnly)).status).toBe(200);

    expect((await call('GET', '/stock?limit=1', both)).status).toBe(200);
    expect((await call('GET', '/locations', both)).status).toBe(200);
    const archived = await call('GET', '/locations?status=archived', both);
    expect(archived.status).toBe(403);
    expect(archived.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await call('GET', '/locations?status=archived', manager)).status).toBe(200);
    expect((await call('GET', '/staff', both)).status).toBe(403);
  });

  it('acts on a cost grant and its removal on the next request with the same cookie (AC-6, spec 0005 AC-33 a)', async () => {
    const id = await userIdOf('warehouse@example.com');
    const hasCost = async () =>
      costKeysIn((await call('GET', '/stock?limit=50', warehouse)).body).length > 0;
    expect(await hasCost()).toBe(false);

    await giveHats(owner.pool, id, { hats: ['warehouse'], costView: true });
    expect(await hasCost()).toBe(true);
    expect(MeResponse.parse((await call('GET', '/me', warehouse)).body).permissions).toContain(
      'cost.view',
    );

    await giveHats(owner.pool, id, { hats: ['warehouse'] });
    expect(await hasCost()).toBe(false);
  });

  it('ends the session of a person whose last hat is gone (AC-10)', async () => {
    const cookie = await signInAs(base, owner.pool, {
      email: 'leaving@example.com',
      access: { hats: ['support'] },
    });
    expect((await call('GET', '/me', cookie)).status).toBe(200);

    await giveHats(owner.pool, await userIdOf('leaving@example.com'), { hats: [] });
    const reply = await call('GET', '/me', cookie);

    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});
