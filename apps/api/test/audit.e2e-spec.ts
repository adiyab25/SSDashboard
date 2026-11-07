import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  AUDIT_EXPORT_COLUMNS,
  AuditEntryDetail,
  AuditEntryListResponse,
  personActor,
  SkuDetail,
  type AuditActionCode,
  type AuditActionDefinition,
  StockReceiptDetail,
  StockReceiptListResponse,
} from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditReasonInvalid } from '../src/audit/audit.errors.js';
import { AuditService } from '../src/audit/audit.service.js';
import {
  createScratchDatabase,
  dropScratchDatabase,
  eventually,
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
describe('audit trail api (spec 0010)', { timeout: 240_000 }, () => {
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
  // Spec 0010, milestone 3 (tasks 12 to 14, api side): the detail, the record history, the
  // export, and paging while entries keep arriving.

  /** Plants `count` entries of one action as the owner, in one statement. */
  async function plant(action: string, count: number): Promise<void> {
    await owner.pool.query(
      `INSERT INTO audit_entries (correlation_id, actor_kind, actor_ref, action, record_type, record_id)
       SELECT gen_random_uuid(), 'carrier', 'bosta', $1, 'sku', gen_random_uuid()
       FROM generate_series(1, $2)`,
      [action, count],
    );
  }

  it('pages 120 entries 50 at a time while new ones arrive, with no gap and no repeat (AC-12)', async () => {
    await plant('planted.batch', 120);
    const { rows } = await owner.pool.query<{ id: string }>(
      "SELECT id FROM audit_entries WHERE action = 'planted.batch' ORDER BY recorded_at DESC, id DESC",
    );
    expect(rows).toHaveLength(120);

    const sizes: number[] = [];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?action=planted.batch&limit=50${cursor ? `&cursor=${cursor}` : ''}`;
      const page = AuditEntryListResponse.parse((await listEntries(query)).body);
      sizes.push(page.items.length);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      // Entries recorded while a reader pages are newer than its cursor: they never shift a page.
      await plant('planted.batch', 3);
    } while (cursor);

    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it('shows one entry with its field diff, and 404 for an unknown id (AC-12)', async () => {
    const receipt = await postReceipt();
    expect((await voidReceipt(receipt.id)).status).toBe(200);
    const [entry] = AuditEntryListResponse.parse(
      (await listEntries(`?recordType=stock_receipt&recordId=${receipt.id}`)).body,
    ).items;
    if (!entry) throw new Error('no entry');

    const detail = await call('GET', `/audit/entries/${entry.id}`, { cookie: admin });
    expect(detail.status).toBe(200);
    expect(AuditEntryDetail.parse(detail.body)).toMatchObject({
      id: entry.id,
      action: 'stock_receipt.voided',
      actorName: 'Test Person',
      changes: [{ field: 'status', before: 'posted', after: 'voided', personal: false }],
      undone: false,
      canUndo: false,
    });

    for (const id of [randomUUID(), 'not-an-id']) {
      const missing = await call('GET', `/audit/entries/${id}`, { cookie: admin });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
    }
  });

  it('pages the history of one record, and refuses a malformed record (task 13)', async () => {
    const receipt = await postReceipt();
    expect((await voidReceipt(receipt.id)).status).toBe(200);

    const history = await call('GET', `/audit/records/stock_receipt/${receipt.id}/entries`, {
      cookie: admin,
    });
    expect(history.status).toBe(200);
    const page = AuditEntryListResponse.parse(history.body);
    expect(page.items.map((item) => item.record.id)).toEqual([receipt.id]);
    expect(page.nextCursor).toBeNull();

    for (const path of [
      `/audit/records/Bad-Type/${receipt.id}/entries`,
      '/audit/records/sku/x/entries',
    ]) {
      const bad = await call('GET', path, { cookie: admin });
      expect(bad.status, path).toBe(400);
      expect(bad.body, path).toMatchObject({ code: 'INVALID_FILTER' });
    }
  });

  it('refuses the detail, the history, and the export to a non manager (AC-13)', async () => {
    const id = randomUUID();
    for (const path of [
      `/audit/entries/${id}`,
      `/audit/records/sku/${id}/entries`,
      '/audit/entries/export?dayFrom=2026-01-01&dayTo=2026-01-02',
    ]) {
      const response = await call('GET', path, { cookie: staff });
      expect(response.status, path).toBe(403);
      expect(response.body, path).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  /** A raw export call: status, headers, and the body's bytes. */
  async function exportFile(query: string, cookie = admin, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/api/audit/entries/export${query}`, {
      headers: { cookie, origin: base, ...headers },
    });
    return {
      status: response.status,
      headers: response.headers,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }

  it('exports the filtered entries as CSV with a byte order mark, and records the export (AC-15)', async () => {
    const receipt = await postReceipt();
    expect((await voidReceipt(receipt.id)).status).toBe(200);
    const [entry] = AuditEntryListResponse.parse(
      (await listEntries(`?recordType=stock_receipt&recordId=${receipt.id}`)).body,
    ).items;
    if (!entry) throw new Error('no entry');
    const day = entry.operatingDay;
    const filter = `?action=stock_receipt.voided&dayFrom=${day}&dayTo=${day}`;
    const listed = AuditEntryListResponse.parse((await listEntries(`${filter}&limit=200`)).body);

    // Review M3R3: the reason travels in the x-audit-reason header, percent encoded, never in
    // the query string.
    const file = await exportFile(filter, admin, {
      'x-audit-reason': encodeURIComponent('monthly check'),
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/csv');
    expect(file.headers.get('content-disposition')).toBe(
      `attachment; filename="audit-${day}-${day}.csv"`,
    );
    expect([...file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = file.bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.map((column) => `"${column}"`).join(','));
    expect(lines).toHaveLength(listed.items.length + 1);
    expect(lines.slice(1).map((line) => line.split(',').at(-1))).toEqual(
      listed.items.map((item) => `"${item.id}"`),
    );
    expect(lines[1]).toContain('"Stock receipt voided"');

    const recorded = AuditEntryListResponse.parse(
      (await listEntries('?action=audit.exported&limit=200')).body,
    ).items;
    expect(recorded[0]).toMatchObject({
      action: 'audit.exported',
      record: { type: 'audit_entry', label: null },
      after: {
        action: 'stock_receipt.voided',
        dayFrom: day,
        dayTo: day,
        rows: listed.items.length,
      },
      reason: 'monthly check',
    });

    // Review M3R2: an export without an action filter holds exactly the rows it counted, and
    // never its own entry, which is newer than the key it was bounded by.
    const whole = await exportFile(`?dayFrom=${day}&dayTo=${day}`);
    expect(whole.status).toBe(200);
    const wholeLines = whole.bytes.subarray(3).toString('utf8').trimEnd().split('\r\n').slice(1);
    const [own] = AuditEntryListResponse.parse(
      (await listEntries('?action=audit.exported&limit=1')).body,
    ).items;
    expect(own?.after).toMatchObject({ rows: wholeLines.length });
    expect(wholeLines.map((line) => line.split(',').at(-1))).not.toContain(`"${own?.id}"`);
  });

  it('refuses an export without a day range, over 366 days, or with a query reason (AC-15)', async () => {
    for (const query of [
      '',
      '?dayFrom=2026-01-01',
      // Review M3R8: 366 days counted inclusively; 2025-01-01 to 2026-01-02 is 367.
      '?dayFrom=2025-01-01&dayTo=2026-01-02',
      '?dayFrom=2026-01-01&dayTo=2026-01-01&reason=monthly',
    ]) {
      const file = await exportFile(query);
      expect(file.status, query).toBe(400);
      expect(JSON.parse(file.bytes.toString('utf8')), query).toMatchObject({
        code: 'INVALID_FILTER',
      });
    }
    // 2025-01-01 to 2026-01-01 is exactly 366 days, both included: allowed.
    expect((await exportFile('?dayFrom=2025-01-01&dayTo=2026-01-01')).status).toBe(200);
    const badReason = await exportFile('?dayFrom=2026-01-01&dayTo=2026-01-01', admin, {
      'x-audit-reason': '%E0%A4%A',
    });
    expect(badReason.status).toBe(400);
    expect(JSON.parse(badReason.bytes.toString('utf8'))).toMatchObject({ code: 'INVALID_REASON' });
  });

  /**
   * Plants `count` entries on 2020-03-01 as the owner. The stamping triggers are disabled for
   * the plant only (as the AR4 case does), with the day passed itself, inside one transaction, so
   * they are back on before anything else can write.
   */
  async function plantBulk(count: number, offset: number): Promise<void> {
    const client = await owner.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_entries DISABLE TRIGGER USER');
      await client.query(
        `INSERT INTO audit_entries (id, recorded_at, operating_day, correlation_id, actor_kind,
                                    actor_ref, action, record_type, record_id)
         SELECT uuidv7(), '2020-03-01T10:00:00Z'::timestamptz + make_interval(secs => n / 1000.0),
                '2020-03-01', gen_random_uuid(), 'carrier', 'bosta', 'planted.bulk', 'sku',
                gen_random_uuid()
         FROM generate_series($1::int, $2::int) AS n`,
        [offset + 1, offset + count],
      );
      await client.query('ALTER TABLE audit_entries ENABLE TRIGGER USER');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const exportCount = async () =>
    (
      await owner.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_entries WHERE action = 'audit.exported'",
      )
    ).rows[0]?.n;

  // Last in this suite: it plants 200,000 entries on one past day, then one more.
  it('allows exactly 200,000 rows, survives a reader that goes away, then answers 413 past it (AC-15)', async () => {
    await plantBulk(200_000, 0);

    // Review M3R1: the reader aborts after the first chunk; the server stops streaming and
    // answers the next request as usual.
    const controller = new AbortController();
    const response = await fetch(
      `${base}/api/audit/entries/export?dayFrom=2020-03-01&dayTo=2020-03-01`,
      {
        headers: { cookie: admin, origin: base },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    // The server notices, stops, and says so once, with no values.
    await eventually(
      () => (api?.output().includes('An audit export was cut off') ? true : undefined),
      { what: 'the cut off log line' },
    );

    const next = await exportFile(
      `?action=stock_receipt.voided&dayFrom=2020-03-01&dayTo=2020-03-01`,
    );
    expect(next.status).toBe(200);
    expect((await listEntries('?action=planted.bulk&limit=1')).status).toBe(200);

    // Review M3R9: one more row is past the limit: 413, before streaming or recording.
    await plantBulk(1, 200_000);
    const before = await exportCount();
    const file = await exportFile('?dayFrom=2020-03-01&dayTo=2020-03-01');
    expect(file.status).toBe(413);
    expect(JSON.parse(file.bytes.toString('utf8'))).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(await exportCount()).toBe(before);
  });
});

// Spec 0010, milestone 2 (tasks 8, 9, 11) against PostgreSQL, through the writer itself as a
// later feature calls it: no personal value reaches any column (AC-4), a reason with a phone is
// stored masked (AC-5), one business action shares one correlation id (AC-6), the table refuses
// a wrong actor (AC-3), the day follows the cutoff hour (AC-7), and a scratch registry entry needs
// no schema change (AC-19).
describe('audit writer against PostgreSQL (spec 0010, milestone 2)', { timeout: 60_000 }, () => {
  const SCRATCH_CODE = 'customer.scratch_edited';
  const registry = AUDIT_ACTIONS as Record<string, AuditActionDefinition>;
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let app: DatabaseConnection;
  let userId: string;
  const audit = new AuditService();

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    app = createDatabase(appUrl.toString(), { max: 2 });
    const { rows } = await owner.pool.query<{ id: string }>(
      "INSERT INTO users (name, email, role) VALUES ('Writer', 'writer@example.com', 'admin') RETURNING id",
    );
    userId = rows[0]?.id ?? '';
    // AC-19: a later feature adds one registry row (with its labels and proof test); no
    // migration and no change to the audit module. Planted here for this run only.
    registry[SCRATCH_CODE] = {
      module: 'customers',
      recordType: 'customer',
      reason: 'optional',
      automatic: false,
      undoable: false,
      label: 'audit.recordTypes.customer',
      proof: 'apps/api/test/audit.e2e-spec.ts',
      reasonCodes: ['duplicate_contact'],
    };
  });

  afterAll(async () => {
    delete registry[SCRATCH_CODE];
    await app?.pool.end();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  /** Every column of the entries of one record, as JSON text, read as the owner. */
  async function columnsOf(recordId: string): Promise<string> {
    const { rows } = await owner.pool.query<{ row: string }>(
      'SELECT row_to_json(e)::text AS row FROM audit_entries e WHERE record_id = $1',
      [recordId],
    );
    return rows.map((row) => row.row).join('\n');
  }

  it('stores no sentinel in any column, with a reason code (AC-4, AC-5, AC-19)', async () => {
    const customerId = randomUUID();
    await app.db.transaction((tx) =>
      audit.record(tx, {
        actor: personActor(userId, 'admin'),
        action: SCRATCH_CODE as AuditActionCode,
        record: { type: 'customer', id: customerId },
        before: {
          name: 'SENTINEL-OLD-NAME',
          phone: '01011111111',
          address: 'SENTINEL-OLD-ADDRESS',
          email: 'sentinel-old@example.eg',
        },
        after: {
          name: 'SENTINEL-NEW-NAME',
          phone: '01022222222',
          address: 'SENTINEL-NEW-ADDRESS',
          email: 'sentinel-new@example.eg',
          merge: { reason: 'SENTINEL-MERGE-REASON' },
          // Security review AS21: personal JSON text, under a personal key or a path rule.
          note: '{"x":"SENTINEL lives in Nasr City"}',
          shipToAddress: '["SENTINEL 12 Tahrir St","Nasr City"]',
          contact: '{"name":"SENTINEL-CONTACT","email":"sentinel-contact@example.eg"}',
        },
        reason: 'duplicate_contact',
        correlationId: audit.newCorrelationId(),
      }),
    );

    const stored = await columnsOf(customerId);
    expect(stored).toContain(customerId);
    expect(stored).not.toMatch(/sentinel|01011111111|01022222222/i);
    const { rows } = await owner.pool.query<{ fields: string[]; reason: string }>(
      'SELECT personal_fields AS fields, reason FROM audit_entries WHERE record_id = $1',
      [customerId],
    );
    expect(rows[0]).toEqual({
      fields: [
        'address',
        'contact',
        'email',
        'merge.reason',
        'name',
        'note',
        'phone',
        'shipToAddress',
      ],
      reason: 'duplicate_contact',
    });
  });

  it('writes a two record action with one correlation id (AC-6)', async () => {
    const correlationId = audit.newCorrelationId();
    const [survivor = '', merged = ''] = [randomUUID(), randomUUID()];
    await app.db.transaction((tx) =>
      audit.recordMany(
        tx,
        [survivor, merged].map((id) => ({
          actor: personActor(userId, 'admin'),
          action: SCRATCH_CODE as AuditActionCode,
          record: { type: 'customer', id },
          after: { status: id === merged ? 'merged' : 'survivor' },
          correlationId,
        })),
      ),
    );

    const { rows } = await owner.pool.query<{ record_id: string }>(
      'SELECT record_id FROM audit_entries WHERE correlation_id = $1 ORDER BY record_id',
      [correlationId],
    );
    expect(rows.map((row) => row.record_id)).toEqual([survivor, merged].sort());
  });

  it('refuses each wrong actor shape at the table (AC-3)', async () => {
    const wrong: (string | null)[][] = [
      ['person', null, null, null],
      ['system_job', userId, 'nightly', randomUUID()],
      ['carrier', null, 'bosta', randomUUID()],
      ['partner_user', userId, null, null],
      // Security review AS19: no hat for a person, no job id for a system job.
      ['person', userId, null, null],
      ['system_job', null, 'nightly', null],
    ];
    for (const [kind, user, ref, job] of wrong) {
      await expect(
        app.pool.query(
          `INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, actor_ref, job_id,
                                      action, record_type, record_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sku.archived', 'sku', gen_random_uuid())`,
          [kind, user, ref, job],
        ),
      ).rejects.toThrow(/audit_actor_shape/);
    }
  });

  it('stamps the operating day with the cutoff hour, from the entry instant (AC-7)', async () => {
    await owner.pool.query(
      "UPDATE settings SET value = to_jsonb(2) WHERE key = 'operating_day_cutoff_hour'",
    );
    try {
      const recordId = randomUUID();
      await app.db.transaction((tx) =>
        audit.record(tx, {
          actor: personActor(userId, 'admin'),
          action: 'sku.archived',
          record: { type: 'sku', id: recordId, label: 'CUT-OFF-1' },
          before: { archived: false },
          after: { archived: true },
          correlationId: audit.newCorrelationId(),
        }),
      );
      const { rows } = await owner.pool.query<{ same: boolean }>(
        `SELECT operating_day =
                  ((recorded_at AT TIME ZONE 'Africa/Cairo') - interval '2 hours')::date AS same
         FROM audit_entries WHERE record_id = $1`,
        [recordId],
      );
      expect(rows[0]?.same).toBe(true);
    } finally {
      await owner.pool.query(
        "UPDATE settings SET value = to_jsonb(0) WHERE key = 'operating_day_cutoff_hour'",
      );
    }
  });

  // Security review AS13: a customer facing record takes a reason code, never a typed note; the
  // note with a name and an email is refused and nothing is stored.
  it('refuses a typed note with a name and an email on a customer entry (AC-5)', async () => {
    const customerId = randomUUID();
    await expect(
      app.db.transaction((tx) =>
        audit.record(tx, {
          actor: personActor(userId, 'admin'),
          action: SCRATCH_CODE as AuditActionCode,
          record: { type: 'customer', id: customerId },
          after: { tier: 'gold' },
          reason: 'Sentinel Ahmed asked, write to sentinel@example.eg',
          correlationId: audit.newCorrelationId(),
        }),
      ),
    ).rejects.toBeInstanceOf(AuditReasonInvalid);
    expect(await columnsOf(customerId)).toBe('');
  });

  it('stores a free text reason with its email and phone masked (AC-5, AC-16)', async () => {
    const recordId = randomUUID();
    await app.db.transaction((tx) =>
      audit.record(tx, {
        actor: personActor(userId, 'admin'),
        action: 'sku.archived',
        record: { type: 'sku', id: recordId, label: 'MASK-1' },
        before: { archived: false },
        after: { archived: true },
        reason: 'asked by sentinel@example.eg on 02 2345 6789',
        correlationId: audit.newCorrelationId(),
      }),
    );

    const { rows } = await owner.pool.query<{ reason: string }>(
      'SELECT reason FROM audit_entries WHERE record_id = $1',
      [recordId],
    );
    expect(rows[0]?.reason).toBe('asked by [email] on [phone]');
    expect(await columnsOf(recordId)).not.toMatch(/sentinel|2345/);
  });
});
