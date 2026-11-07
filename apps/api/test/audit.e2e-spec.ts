import { randomUUID } from 'node:crypto';
import {
  AuditEntryListResponse,
  SkuDetail,
  StockReceiptDetail,
  StockReceiptListResponse,
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

// Spec 0010, milestone 1: the thin thread. Voiding a stock receipt writes one
// `stock_receipt.voided` entry in the void's own transaction; a manager reads it through
// GET /api/audit/entries; a failure before, inside, or after `record` leaves neither the change
// nor the entry; a void without a reason is 422 REASON_REQUIRED; a non manager gets 403.
describe('audit trail api (spec 0010)', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let staff: string;
  let admin: string;
  let adminId: string;
  let warehouseId: string;
  let skuId: string;

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
    const { rows } = await owner.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'admin@example.com'",
    );
    adminId = rows[0]?.id ?? '';

    const sku = await call('POST', '/products', {
      cookie: staff,
      body: { name: { en: 'Audit tee' }, variants: [{ sku: 'AUDIT-1', price: '10' }] },
    });
    expect(sku.status).toBe(201);
    skuId = SkuDetail.parse(sku.body).id;
    const warehouse = await call('POST', '/locations', {
      cookie: admin,
      body: { code: 'WH-AUD', name: { en: 'Audit warehouse' }, kind: 'warehouse' },
    });
    expect(warehouse.status).toBe(201);
    warehouseId = (warehouse.body as { id: string }).id;
  });

  afterAll(async () => {
    await stop(api);
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
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
  }

  /** Posts a receipt of 5 units and returns it. */
  async function postReceipt(): Promise<StockReceiptDetail> {
    const response = await call('POST', '/stock-receipts', {
      cookie: staff,
      headers: { 'idempotency-key': randomUUID() },
      body: { locationId: warehouseId, lines: [{ skuId, quantity: 5, unitCost: '2' }] },
    });
    expect(response.status).toBe(201);
    return StockReceiptDetail.parse(response.body);
  }

  const voidReceipt = (id: string, body: unknown = { reason: 'Entered twice' }) =>
    call('POST', `/stock-receipts/${id}/void`, { cookie: admin, body });

  const listEntries = async (query: string, cookie = admin) => {
    const response = await call('GET', `/audit/entries${query}`, { cookie });
    return { status: response.status, body: response.body };
  };

  /** The receipt's status, its entries, and whether a reversal was posted, read as the owner. */
  async function stateOf(receipt: StockReceiptDetail) {
    const status = await owner.pool.query<{ status: string }>(
      'SELECT status FROM stock_receipts WHERE id = $1',
      [receipt.id],
    );
    const entries = await owner.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_entries WHERE record_id = $1',
      [receipt.id],
    );
    const reversals = await owner.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM movement_groups g
       JOIN stock_receipts r ON g.reverses_group_id = r.movement_group_id WHERE r.id = $1`,
      [receipt.id],
    );
    return {
      status: status.rows[0]?.status,
      entries: entries.rows[0]?.count,
      reversals: reversals.rows[0]?.count,
    };
  }

  /** Plants a trigger that fails every matching write, runs `work`, and always removes it. */
  async function withPlantedFailure(
    table: string,
    timing: string,
    work: () => Promise<void>,
  ): Promise<void> {
    await owner.pool.query(`
      CREATE OR REPLACE FUNCTION planted_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'planted failure'; END $$`);
    await owner.pool.query(
      `CREATE TRIGGER planted_failure ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION planted_failure()`,
    );
    try {
      await work();
    } finally {
      await owner.pool.query(`DROP TRIGGER planted_failure ON ${table}`);
    }
  }

  it('records a void as one stock_receipt.voided entry a manager can read (AC-1, AC-5, AC-12)', async () => {
    const receipt = await postReceipt();

    const voided = await voidReceipt(receipt.id, { reason: '  Entered twice, call 01012345678 ' });
    expect(voided.status).toBe(200);
    expect(await stateOf(receipt)).toEqual({ status: 'voided', entries: 1, reversals: 1 });
    // Security review AS6: the receipt keeps the reason with the phone masked, like the entry.
    const stored = StockReceiptDetail.parse(
      (await call('GET', `/stock-receipts/${receipt.id}`, { cookie: admin })).body,
    );
    expect(stored.void?.reason).toBe('Entered twice, call [phone]');

    const page = await listEntries(`?recordType=stock_receipt&recordId=${receipt.id}`);
    expect(page.status).toBe(200);
    const { items, nextCursor } = AuditEntryListResponse.parse(page.body);
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: 'stock_receipt.voided',
      actor: { kind: 'person', userId: adminId, hat: 'admin', ref: null, jobId: null },
      actorName: 'Test Person',
      record: { type: 'stock_receipt', id: receipt.id, label: receipt.number },
      before: { status: 'posted' },
      after: { status: 'voided' },
      personalFields: [],
      reason: 'Entered twice, call [phone]',
      undone: false,
      canUndo: false,
    });

    // The day filter, inclusive on both ends, by the entry's own operating day.
    const day = items[0]?.operatingDay ?? '';
    const sameDay = AuditEntryListResponse.parse(
      (await listEntries(`?dayFrom=${day}&dayTo=${day}&action=stock_receipt.voided`)).body,
    );
    expect(sameDay.items.map((item) => item.id)).toContain(items[0]?.id);
    const earlier = AuditEntryListResponse.parse(
      (await listEntries('?dayFrom=2020-01-01&dayTo=2020-01-31')).body,
    );
    expect(earlier.items).toEqual([]);
  });

  // Review AR4: entries sharing one recorded_at, and two a microsecond away, page one at a time in
  // (recorded_at desc, id desc) order, each exactly once. A keyset without the id tie breaker, or
  // truncated to milliseconds, fails here. The owner plants the instants with the trigger that
  // stamps recorded_at (audit_entries_0_stamp_recorded_at, with audit_entries_1_stamp_id for the id) disabled for the plant only.
  it('pages ties and microsecond neighbours one at a time, each once (AC-12)', async () => {
    await owner.pool.query(
      'ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_0_stamp_recorded_at, DISABLE TRIGGER audit_entries_1_stamp_id',
    );
    try {
      await owner.pool.query(
        `INSERT INTO audit_entries (id, recorded_at, correlation_id, actor_kind, actor_ref, action,
                                    record_type, record_id)
         SELECT gen_random_uuid(), at, gen_random_uuid(), 'carrier', 'bosta', 'planted.paged',
                'stock_receipt', gen_random_uuid()
         FROM unnest(ARRAY[
           '2026-11-05 10:00:00.000001+00', '2026-11-05 10:00:00.000001+00',
           '2026-11-05 10:00:00.000001+00', '2026-11-05 10:00:00.000001+00',
           '2026-11-05 10:00:00.000001+00', '2026-11-05 10:00:00.000002+00',
           '2026-11-05 10:00:00+00']::timestamptz[]) AS at`,
      );
    } finally {
      await owner.pool.query(
        'ALTER TABLE audit_entries ENABLE TRIGGER audit_entries_0_stamp_recorded_at, ENABLE TRIGGER audit_entries_1_stamp_id',
      );
    }
    const { rows } = await owner.pool.query<{ id: string }>(
      "SELECT id FROM audit_entries WHERE action = 'planted.paged' ORDER BY recorded_at DESC, id DESC",
    );
    expect(rows).toHaveLength(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?action=planted.paged&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const page = AuditEntryListResponse.parse((await listEntries(query)).body);
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it('pages newest first with an opaque cursor, without gaps or repeats (AC-12)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const receipt = await postReceipt();
      expect((await voidReceipt(receipt.id)).status).toBe(200);
    }
    const all = AuditEntryListResponse.parse((await listEntries('?limit=200')).body).items;
    expect(all.length).toBeGreaterThanOrEqual(3);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = AuditEntryListResponse.parse((await listEntries(query)).body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((item) => item.id));
    const times = all.map((item) => item.recordedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('answers a bad filter with INVALID_FILTER and a forged cursor with INVALID_CURSOR', async () => {
    for (const query of [
      '?limit=201',
      '?recordId=' + randomUUID(),
      '?offset=10',
      '?dayFrom=x',
      '?dayFrom=0000-01-01',
      '?dayTo=0000-12-31',
    ]) {
      const response = await listEntries(query);
      expect(response.status, query).toBe(400);
      expect(response.body, query).toMatchObject({ code: 'INVALID_FILTER' });
    }
    const forged = await listEntries('?cursor=bm9wZQ');
    expect(forged.status).toBe(400);
    expect(forged.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('refuses a non manager with 403 and a caller without a session with 401 (AC-13)', async () => {
    const asStaff = await listEntries('', staff);
    expect(asStaff.status).toBe(403);
    expect(asStaff.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await call('GET', '/audit/entries')).status).toBe(401);
  });

  it.each([
    ['a missing reason', {}],
    ['a blank reason', { reason: '   ' }],
  ])('answers %s with 422 REASON_REQUIRED and changes nothing (AC-5)', async (_case, body) => {
    const receipt = await postReceipt();

    const response = await voidReceipt(receipt.id, body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(await stateOf(receipt)).toEqual({ status: 'posted', entries: 0, reversals: 0 });
  });

  // AC-2: the entry and the change share one transaction. The ledger posts the reversal, then the
  // audit entry is recorded, then the receipt row is updated; a failure at any point leaves none.
  it.each([
    ['before record (the reversal posting)', 'movement_groups', 'BEFORE INSERT'],
    ['inside record (the entry insert)', 'audit_entries', 'BEFORE INSERT'],
    ['after record (the receipt update)', 'stock_receipts', 'BEFORE UPDATE'],
  ])(
    'leaves neither the change nor the entry on a failure %s (AC-2)',
    async (_case, table, timing) => {
      const receipt = await postReceipt();

      await withPlantedFailure(table, timing, async () => {
        const response = await voidReceipt(receipt.id);
        expect(response.status).toBe(500);
      });
      expect(await stateOf(receipt)).toEqual({ status: 'posted', entries: 0, reversals: 0 });

      // With the failure gone, the same void goes through and writes exactly one entry.
      expect((await voidReceipt(receipt.id)).status).toBe(200);
      expect(await stateOf(receipt)).toEqual({ status: 'voided', entries: 1, reversals: 1 });
    },
  );

  it('keeps the receipt list badge and the entry in step', async () => {
    const list = StockReceiptListResponse.parse(
      (await call('GET', '/stock-receipts?limit=50', { cookie: staff })).body,
    );
    const voidedIds = list.items.filter((item) => item.status === 'voided').map((item) => item.id);
    const entries = AuditEntryListResponse.parse(
      (await listEntries('?action=stock_receipt.voided&limit=200')).body,
    );
    expect(entries.items.map((item) => item.record.id).sort()).toEqual([...voidedIds].sort());
  });
});
