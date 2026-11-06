import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0010, AC-8 (and AC-1, AC-3, AC-7 at the table): the audit trail can only grow. The app
// role holds INSERT and SELECT only; the owner is stopped by the row and statement triggers; and
// a GRANT UPDATE planted on the app role still cannot change an entry, because the trigger is the
// second guard for every role.
describe('audit entries are append only (spec 0010)', () => {
  let name: string;
  let owner: pg.Client;
  let app: pg.Client;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    app = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await app.connect();
    // The application role's privileges, without needing its login in the test cluster.
    await app.query(`SET ROLE ${APP_ROLE}`);
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await dropScratchDatabase(name);
  });

  /** A staff user for the person actor's foreign key. */
  async function makeUser(email: string): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      "INSERT INTO users (name, email, role) VALUES ('Auditor', $1, 'admin') RETURNING id",
      [email],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no user');
    return id;
  }

  /** One entry written by the app role, the way `AuditService.record` writes it. */
  async function appEntry(userId: string): Promise<string> {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, actor_hat, action,
                                  record_type, record_id, record_label, before, after, reason)
       VALUES (gen_random_uuid(), 'person', $1, 'admin', 'stock_receipt.voided', 'stock_receipt',
               gen_random_uuid(), 'SR-2026-000001', '{"status":"posted"}', '{"status":"voided"}',
               'Entered twice')
       RETURNING id`,
      [userId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no entry');
    return id;
  }

  it('lets the app role insert and read an entry, and fills the tenant and the day itself', async () => {
    const user = await makeUser('insert@example.test');
    const id = await appEntry(user);

    const { rows } = await app.query<{ tenant: boolean; day: boolean; fields: string[] }>(
      `SELECT tenant_id = current_setting('ssd.tenant_id')::uuid AS tenant,
              operating_day = ssd_operating_day(recorded_at) AS day,
              personal_fields AS fields
       FROM audit_entries WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ tenant: true, day: true, fields: [] });
  });

  it('refuses UPDATE, DELETE, and TRUNCATE to the app role with permission denied', async () => {
    const id = await appEntry(await makeUser('app@example.test'));

    await expect(
      app.query("UPDATE audit_entries SET reason = 'changed' WHERE id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query('DELETE FROM audit_entries WHERE id = $1', [id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query('TRUNCATE audit_entries')).rejects.toThrow(/permission denied/);
  });

  it('refuses UPDATE, DELETE, and TRUNCATE to the owner with "append only"', async () => {
    const id = await appEntry(await makeUser('owner@example.test'));

    await expect(
      owner.query("UPDATE audit_entries SET reason = 'changed' WHERE id = $1", [id]),
    ).rejects.toThrow(/append only/);
    await expect(owner.query('DELETE FROM audit_entries WHERE id = $1', [id])).rejects.toThrow(
      /append only/,
    );
    await expect(owner.query('TRUNCATE audit_entries CASCADE')).rejects.toThrow(/append only/);
  });

  it('still refuses an update after a GRANT UPDATE is planted on the app role', async () => {
    const id = await appEntry(await makeUser('planted@example.test'));
    await owner.query(`GRANT UPDATE, DELETE ON audit_entries TO ${APP_ROLE}`);
    try {
      await expect(
        app.query("UPDATE audit_entries SET reason = 'changed' WHERE id = $1", [id]),
      ).rejects.toThrow(/append only/);
      await expect(app.query('DELETE FROM audit_entries WHERE id = $1', [id])).rejects.toThrow(
        /append only/,
      );
    } finally {
      await owner.query(`REVOKE UPDATE, DELETE ON audit_entries FROM ${APP_ROLE}`);
    }
    const { rows } = await owner.query<{ reason: string }>(
      'SELECT reason FROM audit_entries WHERE id = $1',
      [id],
    );
    expect(rows[0]?.reason).toBe('Entered twice');
  });

  // Review AR8: information_schema.triggers never lists TRUNCATE triggers, so read pg_trigger.
  it('has exactly its four guards and stamps', async () => {
    const { rows } = await owner.query<{ trigger: string }>(
      `SELECT t.tgname AS trigger FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'audit_entries' AND NOT t.tgisinternal AND t.tgenabled = 'O'
       ORDER BY 1`,
    );
    expect(rows.map((row) => row.trigger)).toEqual([
      'audit_entries_append_only',
      'audit_entries_no_truncate',
      'audit_entries_recorded_now',
      'audit_entries_stamp_operating_day',
    ]);
  });

  // Security review AS1: the app role cannot choose an entry's instant or id, so it can neither
  // backdate nor forward date an entry, its operating day, or its place in the keyset order.
  it('stamps recorded_at and id itself, whatever the writer passes', async () => {
    const user = await makeUser('backdate@example.test');
    const chosen = '01937f3a-0000-7000-8000-00000000abcd';
    const { rows } = await app.query<{
      id: string;
      fresh: boolean;
      day: boolean;
    }>(
      `INSERT INTO audit_entries (id, recorded_at, operating_day, correlation_id, actor_kind,
                                  actor_user_id, action, record_type, record_id)
       VALUES ($1, '2020-01-01T00:00:00Z', '2020-01-01', gen_random_uuid(), 'person', $2,
               'stock_receipt.voided', 'stock_receipt', gen_random_uuid())
       RETURNING id,
                 recorded_at BETWEEN clock_timestamp() - interval '1 minute' AND clock_timestamp() AS fresh,
                 operating_day = ssd_operating_day(recorded_at) AS day`,
      [chosen, user],
    );
    expect(rows[0]?.id).not.toBe(chosen);
    expect(rows[0]).toMatchObject({ fresh: true, day: true });
  });

  // AC-3: the actor shape is a table check, so a wrong shape cannot be stored.
  it.each([
    ['a person with no user', "'person', NULL, NULL, NULL"],
    ['a person with an actor ref', "'person', $1::uuid, 'x', NULL"],
    ['a system job with a user', "'system_job', $1::uuid, 'nightly', NULL"],
    ['a carrier with a job id', "'carrier', NULL, 'bosta', gen_random_uuid()"],
    ['a partner user without a partner account', "'partner_user', $1::uuid, NULL, NULL"],
    ['an unknown kind', "'robot', NULL, 'x', NULL"],
  ])('refuses %s', async (_case, actor) => {
    const user = await makeUser(`shape-${Math.random().toString(36).slice(2)}@example.test`);
    const usesUser = actor.includes('$1');
    await expect(
      app.query(
        `INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, actor_ref, job_id,
                                    action, record_type, record_id)
         VALUES (gen_random_uuid(), ${actor}, 'stock_receipt.voided', 'stock_receipt', gen_random_uuid())`,
        usesUser ? [user] : [],
      ),
    ).rejects.toThrow(/audit_actor_(shape|kind)/);
  });

  it('accepts each of the six actor kinds in its right shape', async () => {
    const user = await makeUser('kinds@example.test');
    const actors = [
      ['person', user, null, null],
      ['partner_user', user, 'partner-account', null],
      ['system_job', null, 'reconcile', '01937f3a-0000-7000-8000-000000000001'],
      ['carrier', null, 'bosta', null],
      ['import', null, 'run-1', null],
      ['portal_customer', null, 'customer-1', null],
    ];
    for (const [kind, userId, ref, job] of actors) {
      await app.query(
        `INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, actor_ref, job_id,
                                    action, record_type, record_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'stock_receipt.voided', 'stock_receipt',
                 gen_random_uuid())`,
        [kind, userId, ref, job],
      );
    }
    const { rows } = await app.query<{ kinds: number }>(
      'SELECT count(DISTINCT actor_kind)::int AS kinds FROM audit_entries',
    );
    expect(rows[0]?.kinds).toBe(6);
  });

  it('refuses a malformed action, a blank reason, and a non object diff', async () => {
    const insert = (action: string, reason: string | null, after: string | null) =>
      app.query(
        `INSERT INTO audit_entries (correlation_id, actor_kind, actor_ref, action, record_type,
                                    record_id, reason, after)
         VALUES (gen_random_uuid(), 'carrier', 'bosta', $1, 'stock_receipt', gen_random_uuid(),
                 $2, $3::jsonb)`,
        [action, reason, after],
      );
    await expect(insert('Voided', null, null)).rejects.toThrow(/audit_action_format/);
    await expect(insert('stock_receipt.voided', '   ', null)).rejects.toThrow(
      /audit_reason_length/,
    );
    await expect(insert('stock_receipt.voided', 'x'.repeat(501), null)).rejects.toThrow(
      /audit_reason_length/,
    );
    await expect(insert('stock_receipt.voided', null, '[1]')).rejects.toThrow(/audit_json_objects/);
  });

  it('lets an entry be undone at most once', async () => {
    const user = await makeUser('undo@example.test');
    const target = await appEntry(user);
    const undo = () =>
      app.query(
        `INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, action, record_type,
                                    record_id, reason, undoes_entry_id)
         VALUES (gen_random_uuid(), 'person', $1, 'stock_receipt.voided_undone', 'stock_receipt',
                 gen_random_uuid(), 'Wrong call', $2)`,
        [user, target],
      );
    await undo();
    await expect(undo()).rejects.toThrow(/audit_entries_undoes_entry_unique/);
  });
});
