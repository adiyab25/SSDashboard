import { StaffDetail } from '@ssdashboard/contracts';
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

/** One `audit_entries` row as this suite reads it back, with the transaction that wrote it. */
interface EntryRow {
  action: string;
  actor_kind: string;
  actor_user_id: string;
  actor_hat: string;
  record_type: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  xact: string;
}

// Spec 0008 AC-13 and spec 0010 task 10: identity's audit port is the real `AuditService`. A hat
// change and each staff account action write one `audit_entries` row in the change's own
// transaction (the row's xmin is the users row's), and a failed entry rolls the change back. This
// file is the registry proof (`AUDIT_ACTIONS[...].proof`) of `hat.granted`, `hat.revoked`,
// `staff_user.created`, `staff_user.disabled`, `staff_user.enabled` and
// `staff_user.password_reset`.
describe('identity writes the real audit trail', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let boss: string;
  let bossId: string;

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
      MAIL_DRIVER: 'none',
    });
    await waitForHttp(`${base}/api/health`, api);
    boss = await signInAs(base, owner.pool, {
      email: 'boss@example.com',
      access: { hats: ['manager'], costView: true },
    });
    const { rows } = await owner.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'boss@example.com'",
    );
    bossId = rows[0]?.id ?? '';
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
        cookie: boss,
        origin: base,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
  }

  /** Creates a staff person through `POST /api/staff` and returns their id. */
  async function createPerson(email: string, hats: string[]): Promise<string> {
    const made = await call('POST', '/staff', {
      name: 'Audited Person',
      email,
      hats,
      costView: false,
    });
    expect(made.status).toBe(201);
    return (made.body as { staff: { id: string } }).staff.id;
  }

  async function putAccess(
    id: string,
    change: { hats: string[]; costView: boolean; reason?: string },
  ) {
    const current = await call('GET', `/staff/${id}`);
    expect(current.status).toBe(200);
    const { updatedAt } = StaffDetail.parse(current.body);
    return call('PUT', `/staff/${id}/access`, { ...change, updatedAt });
  }

  async function entriesOf(id: string): Promise<EntryRow[]> {
    const { rows } = await owner.pool.query<EntryRow>(
      `SELECT action, actor_kind, actor_user_id, actor_hat, record_type, before, after, reason,
              xmin::text AS xact
         FROM audit_entries WHERE record_id = $1::uuid ORDER BY recorded_at, id`,
      [id],
    );
    return rows;
  }

  async function usersXmin(id: string): Promise<string | undefined> {
    const { rows } = await owner.pool.query<{ xmin: string }>(
      'SELECT xmin::text AS xmin FROM users WHERE id = $1::uuid',
      [id],
    );
    return rows[0]?.xmin;
  }

  async function hatsOf(id: string): Promise<string[]> {
    const { rows } = await owner.pool.query<{ hat: string }>(
      'SELECT hat FROM hat_assignments WHERE user_id = $1::uuid ORDER BY hat',
      [id],
    );
    return rows.map((row) => row.hat);
  }

  it('writes staff_user.created, then hat.granted and hat.revoked in the change’s transaction', async () => {
    const id = await createPerson('hat.person@example.com', ['warehouse']);

    expect((await putAccess(id, { hats: ['support', 'warehouse'], costView: false })).status).toBe(
      200,
    );
    const afterGrant = await entriesOf(id);
    expect(afterGrant.map((entry) => entry.action)).toEqual(['staff_user.created', 'hat.granted']);
    expect(afterGrant[1]?.xact).toBe(await usersXmin(id));

    expect(
      (await putAccess(id, { hats: ['support'], costView: false, reason: 'Moved desks' })).status,
    ).toBe(200);
    const entries = await entriesOf(id);
    expect(entries.map((entry) => entry.action)).toEqual([
      'staff_user.created',
      'hat.granted',
      'hat.revoked',
    ]);
    expect(entries[2]).toMatchObject({
      actor_kind: 'person',
      actor_user_id: bossId,
      actor_hat: 'manager',
      record_type: 'user',
      before: { hats: ['support', 'warehouse'], costView: false, partnerAccountId: null },
      after: { hats: ['support'], costView: false, partnerAccountId: null },
      reason: 'Moved desks',
    });
    // The entry and the hat change were written by one transaction.
    expect(entries[2]?.xact).toBe(await usersXmin(id));
    expect(JSON.stringify(entries)).not.toContain('hat.person@example.com');
  });

  it('rolls the hat change back when its audit entry cannot be written, and leaves no entry', async () => {
    const id = await createPerson('rollback.person@example.com', ['warehouse']);
    await owner.pool.query(`
      CREATE FUNCTION refuse_audit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'planted audit failure'; END $$`);
    await owner.pool.query(
      `CREATE TRIGGER refuse_audit_entry BEFORE INSERT ON audit_entries FOR EACH ROW
         WHEN (NEW.record_id = '${id}'::uuid) EXECUTE FUNCTION refuse_audit_entry()`,
    );
    try {
      const reply = await putAccess(id, { hats: ['support'], costView: false });
      expect(reply.status).toBe(500);
    } finally {
      await owner.pool.query('DROP TRIGGER refuse_audit_entry ON audit_entries');
      await owner.pool.query('DROP FUNCTION refuse_audit_entry()');
    }

    expect(await hatsOf(id)).toEqual(['warehouse']);
    expect((await entriesOf(id)).map((entry) => entry.action)).toEqual(['staff_user.created']);
  });

  it('writes staff_user.password_reset, staff_user.disabled and staff_user.enabled', async () => {
    const id = await createPerson('account.person@example.com', ['support']);

    expect((await call('POST', `/staff/${id}/reset-password`)).status).toBe(200);
    expect(
      (await call('POST', `/staff/${id}/disable`, { reason: 'Left the company' })).status,
    ).toBe(200);
    const disabled = (await entriesOf(id)).at(-1);
    expect(disabled).toMatchObject({
      action: 'staff_user.disabled',
      before: { banned: false },
      after: { banned: true },
      reason: 'Left the company',
    });
    expect(disabled?.xact).toBe(await usersXmin(id));
    expect((await call('POST', `/staff/${id}/enable`)).status).toBe(200);

    const entries = await entriesOf(id);
    expect(entries.map((entry) => entry.action)).toEqual([
      'staff_user.created',
      'staff_user.password_reset',
      'staff_user.disabled',
      'staff_user.enabled',
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ actor_user_id: bossId, actor_hat: 'manager' });
    }
  });

  it('shows identity’s entries on the audit list to a manager', async () => {
    const id = await createPerson('listed.person@example.com', ['support']);

    const reply = await call('GET', `/audit/entries?recordType=user&recordId=${id}`);

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      items: [
        { action: 'staff_user.created', record: { type: 'user', id }, actorName: 'Test Person' },
      ],
    });
  });
});
