import { randomUUID } from 'node:crypto';
import { AuditEntryDetail, AuditEntryListResponse } from '@ssdashboard/contracts';
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

// Spec 0010 security model and spec 0008 AC-6: cost fields reach only a reader with `cost.view`
// on EVERY route that answers a diff, not only the list. `audit.e2e-spec.ts` proves the list; this
// file proves the detail (and its `changes`), the record history, and the export cells.
describe('audit cost fields on every diff route (spec 0010 QA)', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let withCost: string;
  let withoutCost: string;
  let entryId: string;
  const recordId = randomUUID();
  let day: string;

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
    withCost = await signInAs(base, owner.pool, {
      email: 'cost.yes@example.com',
      access: { hats: ['manager'], costView: true },
    });
    withoutCost = await signInAs(base, owner.pool, {
      email: 'cost.no@example.com',
      access: { hats: ['manager'] },
    });
    const { rows } = await owner.pool.query<{ id: string; operating_day: string }>(
      `INSERT INTO audit_entries (correlation_id, actor_kind, actor_ref, action, record_type,
                                  record_id, before, after)
       VALUES (gen_random_uuid(), 'carrier', 'bosta', 'planted.costed', 'stock_receipt', $1,
               '{"status":"posted","referenceValue":"10.00"}'::jsonb,
               '{"status":"voided","unitCost":"2.00"}'::jsonb)
       RETURNING id, to_char(operating_day, 'YYYY-MM-DD') AS operating_day`,
      [recordId],
    );
    entryId = rows[0]?.id ?? '';
    day = rows[0]?.operating_day ?? '';
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const get = async (path: string, cookie: string, method = 'GET') => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { cookie, origin: base },
    });
    return { status: response.status, text: await response.text() };
  };

  /**
   * No cost key and no cost value. The values are matched as whole quoted strings (a JSON string,
   * or a CSV cell with doubled quotes), never as bare digits: a microsecond timestamp such as
   * ":32.004" contains "2.00".
   */
  function expectNoCost(text: string): void {
    expect(text).not.toMatch(/referenceValue|unitCost/);
    expect(text).not.toMatch(/"{1,2}(10|2)\.00"{1,2}/);
  }

  it('strips cost from the detail and its changes for a manager without cost.view', async () => {
    const hidden = await get(`/audit/entries/${entryId}`, withoutCost);
    expect(hidden.status).toBe(200);
    expectNoCost(hidden.text);
    const parsed = AuditEntryDetail.parse(JSON.parse(hidden.text));
    expect(parsed.changes.map((change) => change.field)).toEqual(['status']);

    const shown = await get(`/audit/entries/${entryId}`, withCost);
    expect(
      AuditEntryDetail.parse(JSON.parse(shown.text))
        .changes.map((c) => c.field)
        .sort(),
    ).toEqual(['referenceValue', 'status', 'unitCost']);
  });

  it('strips cost from the record history for a manager without cost.view', async () => {
    const path = `/audit/records/stock_receipt/${recordId}/entries`;
    const hidden = await get(path, withoutCost);
    expect(hidden.status).toBe(200);
    expect(AuditEntryListResponse.parse(JSON.parse(hidden.text)).items).toHaveLength(1);
    expectNoCost(hidden.text);
    expect((await get(path, withCost)).text).toMatch(/unitCost/);
  });

  // The export is a POST since security review AS28.
  it('strips cost from the export cells for a manager without cost.view', async () => {
    const path = `/audit/entries/export?action=planted.costed&dayFrom=${day}&dayTo=${day}`;
    const hidden = await get(path, withoutCost, 'POST');
    expect(hidden.status).toBe(200);
    expect(hidden.text).toContain('planted.costed');
    expectNoCost(hidden.text);
    expect((await get(path, withCost, 'POST')).text).toMatch(/unitCost/);
  });
});
