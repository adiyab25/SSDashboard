import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { REDACTED, redact } from '@ssdashboard/config/redaction';
import { MeResponse, StaffDetail, type Hat } from '@ssdashboard/contracts';
import {
  APP_ROLE,
  createDatabase,
  runMigrations,
  sql,
  type DatabaseConnection,
} from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { Transaction } from '../src/database/sql.js';
import {
  IDENTITY_AUDIT,
  type IdentityAudit,
  type IdentityAuditEntry,
} from '../src/identity/audit-port/identity-audit.js';
import { ADMIN_RULE_LOCK } from '../src/identity/sign-in/locks.js';
import type { HatsChanged } from '../src/platform/events/auth-events.js';
import {
  TEST_CONNECTOR_SECRET_KEY,
  createScratchDatabase,
  dropScratchDatabase,
  eventually,
  freePort,
} from './support.js';

const PASSWORD = 'Correct-Horse-1';
const NEW_PASSWORD = 'Battery-Staple-2';

/**
 * The identity audit port with a real write: each entry goes into a probe table through the
 * change's own transaction, with that transaction's id, so a test can see the entry commit and
 * roll back with the change. `failFor` makes the write fail for a target, after it inserted.
 */
class ProbeAudit implements IdentityAudit {
  readonly failFor = new Set<string>();

  async record(tx: Transaction, entry: IdentityAuditEntry): Promise<void> {
    await tx.execute(
      sql`INSERT INTO audit_probe (action, record_id, actor, before, after, reason, xact)
          VALUES (${entry.action}, ${entry.record.id}::uuid, ${JSON.stringify(entry.actor)}::jsonb,
                  ${JSON.stringify(entry.before ?? null)}::jsonb,
                  ${JSON.stringify(entry.after ?? null)}::jsonb, ${entry.reason ?? null},
                  pg_current_xact_id()::text)`,
    );
    if (this.failFor.has(entry.record.id)) throw new Error('the audit write failed');
  }

  newCorrelationId(): string {
    return '00000000-0000-4000-8000-000000000000';
  }
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

interface Person {
  id: string;
  email: string;
}

/** A probe row as the test reads it back. */
interface ProbeRow {
  action: string;
  record_id: string;
  actor: { kind: string; userId: string; hat: string };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  xact: string;
}

// Spec 0008 milestone 2: giving and taking hats through `PUT /api/staff/:id/access` and
// `POST /api/staff` (AC-7, AC-12, AC-13, AC-14), with spec 0005 AC-33 (sessions follow hats). The
// api runs in this process so the identity audit port can be a probe that really writes through
// the change's transaction; everything else is the real AppModule on a scratch database.
describe('giving and taking hats', { timeout: 300_000 }, () => {
  const probe = new ProbeAudit();
  const events: HatsChanged[] = [];
  /** What the hat rows of the event's target held when the listener ran (after the commit). */
  const seenAtEvent: Array<Promise<string[]>> = [];
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let app: NestExpressApplication | undefined;
  let base: string;
  let hash: string;
  let counter = 0;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 3 });
    await owner.pool.query(
      `CREATE TABLE audit_probe (action text NOT NULL, record_id uuid NOT NULL, actor jsonb NOT NULL,
         before jsonb, after jsonb, reason text, xact text NOT NULL)`,
    );
    await owner.pool.query(`GRANT INSERT, SELECT ON audit_probe TO ${APP_ROLE}`);
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      CONNECTOR_SECRET_KEY: TEST_CONNECTOR_SECRET_KEY,
      MAIL_DRIVER: 'none',
      PORT: String(port),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_AUDIT)
      .useValue(probe)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app);
    await app.listen(port, '127.0.0.1');
    app.get(EventEmitter2).on('HatsChanged', (event: HatsChanged) => {
      events.push(event);
      seenAtEvent.push(hatsOf(event.context.targetId as string));
    });
    hash = await hashPassword(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
    process.env = savedEnv;
  });

  const freshIp = () => {
    counter += 1;
    return `198.18.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
  };

  async function call(cookie: string | undefined, method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-forwarded-for': freshIp(),
        ...(cookie && { cookie }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: response.headers,
    } satisfies Reply;
  }

  /** Adds a staff person straight to the database with exact hats and, optionally, the cost grant. */
  async function addPerson(hats: Hat[], costView = false): Promise<Person> {
    counter += 1;
    const email = `hats${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, last_sign_in_at) VALUES ($1, $2, now()) RETURNING id`,
      [`Hat Person ${counter}`, email],
    );
    const id = rows[0]?.id as string;
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    for (const hat of hats) {
      await owner.pool.query(`INSERT INTO hat_assignments (user_id, hat) VALUES ($1::uuid, $2)`, [
        id,
        hat,
      ]);
    }
    if (costView) {
      await owner.pool.query(
        `INSERT INTO permission_grants (user_id, permission) VALUES ($1::uuid, 'cost.view')`,
        [id],
      );
    }
    return { id, email };
  }

  async function signIn(email: string, password = PASSWORD): Promise<string> {
    const reply = await call(undefined, 'POST', '/api/auth/sign-in/email', { email, password });
    const found = reply.headers.getSetCookie().find((c) => c.includes('session_token'));
    if (!found) throw new Error(`sign in failed with ${reply.status}`);
    return found.split(';')[0] as string;
  }

  /** A signed in manager, with the cost grant unless told otherwise. */
  async function manager(costView = true): Promise<Person & { cookie: string }> {
    const person = await addPerson(['manager'], costView);
    return { ...person, cookie: await signIn(person.email) };
  }

  async function detail(cookie: string, id: string): Promise<StaffDetail> {
    const reply = await call(cookie, 'GET', `/api/staff/${id}`);
    expect(reply.status).toBe(200);
    return StaffDetail.parse(reply.body);
  }

  /** `PUT /api/staff/:id/access` with the `updatedAt` read just before, as the dialog does. */
  async function putAccess(
    cookie: string,
    id: string,
    change: { hats: string[]; costView: boolean; reason?: string },
    updatedAt?: string,
  ): Promise<Reply> {
    const at = updatedAt ?? (await detail(cookie, id)).updatedAt;
    return call(cookie, 'PUT', `/api/staff/${id}/access`, { ...change, updatedAt: at });
  }

  async function hatsOf(userId: string): Promise<string[]> {
    const { rows } = await owner.pool.query<{ hat: string }>(
      'SELECT hat FROM hat_assignments WHERE user_id = $1::uuid ORDER BY hat',
      [userId],
    );
    return rows.map((row) => row.hat);
  }

  async function costOf(userId: string): Promise<boolean> {
    const { rows } = await owner.pool.query(
      `SELECT 1 FROM permission_grants WHERE user_id = $1::uuid AND permission = 'cost.view'`,
      [userId],
    );
    return rows.length > 0;
  }

  async function sessionsOf(userId: string): Promise<number> {
    const { rows } = await owner.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM sessions WHERE user_id = $1::uuid',
      [userId],
    );
    return Number(rows[0]?.count);
  }

  async function probeRows(recordId: string): Promise<ProbeRow[]> {
    const { rows } = await owner.pool.query<ProbeRow>(
      'SELECT * FROM audit_probe WHERE record_id = $1::uuid',
      [recordId],
    );
    return rows;
  }

  async function permissionsOf(cookie: string): Promise<string[]> {
    const reply = await call(cookie, 'GET', '/api/me');
    expect(reply.status).toBe(200);
    return MeResponse.parse(reply.body).permissions;
  }

  describe('the same cookie acts on the next request (spec 0005 AC-33 a)', () => {
    it('gives and takes the cost grant, and the person sees it on the next request', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const cookie = await signIn(person.email);
      expect(await permissionsOf(cookie)).not.toContain('cost.view');

      const granted = await putAccess(boss.cookie, person.id, {
        hats: ['warehouse'],
        costView: true,
      });
      expect(granted.status).toBe(200);
      expect(StaffDetail.parse(granted.body)).toMatchObject({
        hats: ['warehouse'],
        costView: true,
      });
      expect(await permissionsOf(cookie)).toContain('cost.view');

      const taken = await putAccess(boss.cookie, person.id, {
        hats: ['warehouse'],
        costView: false,
      });
      expect(taken.status).toBe(200);
      expect(await permissionsOf(cookie)).not.toContain('cost.view');
    });

    it('gives and takes a hat, and its routes open and close on the next request', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const cookie = await signIn(person.email);
      expect((await call(cookie, 'GET', '/api/staff')).status).toBe(403);

      expect(
        (
          await putAccess(boss.cookie, person.id, {
            hats: ['warehouse', 'manager'],
            costView: false,
          })
        ).status,
      ).toBe(200);
      expect((await call(cookie, 'GET', '/api/staff')).status).toBe(200);

      expect(
        (
          await putAccess(boss.cookie, person.id, {
            hats: ['warehouse'],
            costView: false,
            reason: 'Covering ended',
          })
        ).status,
      ).toBe(200);
      const closed = await call(cookie, 'GET', '/api/staff');
      expect(closed.status).toBe(403);
      expect(closed.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('keeps the session when support is added to a warehouse person (AC-33 b)', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const cookie = await signIn(person.email);

      const reply = await putAccess(boss.cookie, person.id, {
        hats: ['support', 'warehouse'],
        costView: false,
      });

      expect(reply.status).toBe(200);
      expect(await sessionsOf(person.id)).toBe(1);
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(200);
      expect(await permissionsOf(cookie)).toContain('customers.view');
    });

    it('lists people by hat and shows their hats and cost, never a role', async () => {
      const boss = await manager();
      const buyer = await addPerson(['media_buyer']);

      const list = await call(boss.cookie, 'GET', '/api/staff?hat=media_buyer&limit=100');

      expect(list.status).toBe(200);
      const rows = list.body.rows as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.id)).toEqual([buyer.id]);
      expect(rows[0]).toMatchObject({ hats: ['media_buyer'], costView: false });
      expect(rows[0]).not.toHaveProperty('role');
    });
  });

  describe('the refusals (AC-7, AC-12)', () => {
    it('answers 409 STALE_RECORD to an updatedAt read before another change, and changes nothing', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const before = (await detail(boss.cookie, person.id)).updatedAt;
      await putAccess(boss.cookie, person.id, { hats: ['warehouse', 'support'], costView: false });
      const entries = (await probeRows(person.id)).length;

      const stale = await putAccess(
        boss.cookie,
        person.id,
        { hats: ['operations'], costView: true },
        before,
      );

      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(await hatsOf(person.id)).toEqual(['support', 'warehouse']);
      expect(await costOf(person.id)).toBe(false);
      expect(await probeRows(person.id)).toHaveLength(entries);
    });

    it('does not answer 409 STALE_RECORD because the person signed in after the dialog opened (AC-12)', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const opened = (await detail(boss.cookie, person.id)).updatedAt;
      const stampOf = async () =>
        (
          await owner.pool.query<{ at: string | null; updated: string }>(
            `SELECT last_sign_in_at::text AS at, updated_at::text AS updated
             FROM users WHERE id = $1::uuid`,
            [person.id],
          )
        ).rows[0];
      const beforeSignIn = await stampOf();

      await signIn(person.email);

      const afterSignIn = await stampOf();
      expect(afterSignIn?.at).not.toBe(beforeSignIn?.at);
      expect(afterSignIn?.updated).toBe(beforeSignIn?.updated);
      expect((await detail(boss.cookie, person.id)).updatedAt).toBe(opened);
      const saved = await putAccess(
        boss.cookie,
        person.id,
        { hats: ['warehouse', 'support'], costView: false },
        opened,
      );
      expect(saved.status).toBe(200);
      expect(await hatsOf(person.id)).toEqual(['support', 'warehouse']);
    });

    it('does not answer 409 STALE_RECORD because the person made the forced first password change after the dialog opened (AC-12)', async () => {
      const boss = await manager();
      const made = await call(boss.cookie, 'POST', '/api/staff', {
        name: 'Forced Change',
        email: 'forced.change@example.com',
        hats: ['warehouse'],
        costView: false,
      });
      expect(made.status).toBe(201);
      const id = (made.body.staff as { id: string }).id;
      const temporary = (made.body.setup as { temporaryPassword: string }).temporaryPassword;
      const flagOf = async () =>
        (
          await owner.pool.query<{ must_change_password: boolean; updated: string }>(
            `SELECT must_change_password, updated_at::text AS updated FROM users WHERE id = $1::uuid`,
            [id],
          )
        ).rows[0];
      expect((await flagOf())?.must_change_password).toBe(true);
      const opened = (await detail(boss.cookie, id)).updatedAt;
      const beforeChange = await flagOf();

      const first = await signIn('forced.change@example.com', temporary);
      const changed = await call(first, 'POST', '/api/auth/change-password', {
        currentPassword: temporary,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      });

      expect(changed.status).toBe(200);
      const afterChange = await flagOf();
      expect(afterChange?.must_change_password).toBe(false);
      expect(afterChange?.updated).toBe(beforeChange?.updated);
      const saved = await putAccess(
        boss.cookie,
        id,
        { hats: ['warehouse', 'support'], costView: false },
        opened,
      );
      expect(saved.status).toBe(200);
      expect(await hatsOf(id)).toEqual(['support', 'warehouse']);
    });

    it('answers 409 SELF_HAT_CHANGE to a change of one’s own hats or own cost grant', async () => {
      const boss = await manager();

      const hats = await putAccess(boss.cookie, boss.id, {
        hats: ['manager', 'support'],
        costView: true,
      });
      const cost = await putAccess(boss.cookie, boss.id, { hats: ['manager'], costView: false });

      for (const reply of [hats, cost]) {
        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'SELF_HAT_CHANGE' });
      }
      expect(await hatsOf(boss.id)).toEqual(['manager']);
      expect(await costOf(boss.id)).toBe(true);
    });

    it('refuses the self change to a manager created through POST /api/staff too', async () => {
      const boss = await manager();
      const made = await call(boss.cookie, 'POST', '/api/staff', {
        name: 'Second Manager',
        email: 'second.manager@example.com',
        hats: ['manager'],
        costView: true,
      });
      expect(made.status).toBe(201);
      const id = (made.body.staff as { id: string }).id;
      const temporary = (made.body.setup as { temporaryPassword: string }).temporaryPassword;
      const first = await signIn('second.manager@example.com', temporary);
      expect(
        (
          await call(first, 'POST', '/api/auth/change-password', {
            currentPassword: temporary,
            newPassword: NEW_PASSWORD,
            revokeOtherSessions: true,
          })
        ).status,
      ).toBe(200);
      const cookie = await signIn('second.manager@example.com', NEW_PASSWORD);

      const hats = await putAccess(cookie, id, { hats: ['support'], costView: true, reason: 'x' });
      const cost = await putAccess(cookie, id, { hats: ['manager'], costView: false });

      for (const reply of [hats, cost]) {
        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'SELF_HAT_CHANGE' });
      }
      expect(await hatsOf(id)).toEqual(['manager']);
      expect(await costOf(id)).toBe(true);
    });

    it('answers 403 to a manager without cost.view adding or removing cost for someone else', async () => {
      const boss = await manager(false);
      const without = await addPerson(['warehouse']);
      const holding = await addPerson(['warehouse'], true);

      const adding = await putAccess(boss.cookie, without.id, {
        hats: ['warehouse'],
        costView: true,
      });
      const removing = await putAccess(boss.cookie, holding.id, {
        hats: ['warehouse'],
        costView: false,
      });
      const creating = await call(boss.cookie, 'POST', '/api/staff', {
        name: 'With Cost',
        email: 'with.cost@example.com',
        hats: ['operations'],
        costView: true,
      });

      for (const reply of [adding, removing, creating]) {
        expect(reply.status).toBe(403);
        expect(reply.body).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await costOf(without.id)).toBe(false);
      expect(await costOf(holding.id)).toBe(true);
      // The same manager may still change hats while the cost grant stays as it is.
      const hatsOnly = await putAccess(boss.cookie, holding.id, {
        hats: ['support'],
        costView: true,
      });
      expect(hatsOnly.status).toBe(200);
      expect(await costOf(holding.id)).toBe(true);
    });

    it('answers 403 to a manager without cost.view resetting, or changing the email of, a person who holds it (AC-7)', async () => {
      const poor = await manager(false);
      const rich = await manager(true);
      const holder = await addPerson(['operations'], true);
      const invitedHolder = await addPerson(['operations'], true);
      await owner.pool.query('UPDATE users SET last_sign_in_at = NULL WHERE id = $1::uuid', [
        invitedHolder.id,
      ]);
      const plain = await addPerson(['operations']);
      const hashBefore = async (id: string) =>
        (
          await owner.pool.query<{ password: string }>(
            `SELECT password FROM accounts WHERE user_id = $1::uuid AND provider_id = 'credential'`,
            [id],
          )
        ).rows[0]?.password;
      const passwordBefore = await hashBefore(holder.id);
      const session = await signIn(holder.email);
      await owner.pool.query(
        'INSERT INTO two_factors (user_id, secret, backup_codes) VALUES ($1::uuid, $2, $2)',
        [holder.id, 'secret'],
      );
      await owner.pool.query('UPDATE users SET two_factor_enabled = true WHERE id = $1::uuid', [
        holder.id,
      ]);

      const reset = await call(poor.cookie, 'POST', `/api/staff/${holder.id}/reset-password`);
      const twoFactor = await call(poor.cookie, 'POST', `/api/staff/${holder.id}/reset-two-factor`);
      const email = await call(poor.cookie, 'PATCH', `/api/staff/${invitedHolder.id}`, {
        email: 'taken.over@example.com',
      });

      for (const reply of [reset, twoFactor, email]) {
        expect(reply.status, JSON.stringify(reply.body)).toBe(403);
        expect(reply.body).toMatchObject({ code: 'COST_HOLDER_PROTECTED' });
      }
      // Nothing changed: same password, two factor still on, the session alive, the email as it was.
      expect(await hashBefore(holder.id)).toBe(passwordBefore);
      expect(await sessionsOf(holder.id)).toBe(1);
      expect(session).toBeTruthy();
      const left = await owner.pool.query(
        'SELECT two_factor_enabled FROM users WHERE id = $1::uuid',
        [holder.id],
      );
      expect(left.rows[0]).toMatchObject({ two_factor_enabled: true });
      const kept = await owner.pool.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1::uuid',
        [invitedHolder.id],
      );
      expect(kept.rows[0]?.email).toBe(invitedHolder.email);

      // A manager who holds cost.view may do all three, and one without may for a person without it.
      expect(
        (await call(rich.cookie, 'POST', `/api/staff/${holder.id}/reset-two-factor`)).status,
      ).toBe(200);
      expect(
        (await call(poor.cookie, 'POST', `/api/staff/${plain.id}/reset-password`)).status,
      ).toBe(200);
      expect(
        (await call(rich.cookie, 'POST', `/api/staff/${holder.id}/reset-password`)).status,
      ).toBe(200);
      expect(
        (
          await call(rich.cookie, 'PATCH', `/api/staff/${invitedHolder.id}`, {
            email: 'new.address@example.com',
          })
        ).status,
      ).toBe(200);
    });

    it('answers 422 REASON_REQUIRED when the manager hat is taken without a reason', async () => {
      const boss = await manager();
      const other = await addPerson(['manager'], true);

      const bare = await putAccess(boss.cookie, other.id, { hats: ['support'], costView: true });
      expect(bare.status).toBe(422);
      expect(bare.body).toMatchObject({ code: 'REASON_REQUIRED' });
      expect(await hatsOf(other.id)).toEqual(['manager']);

      const reasoned = await putAccess(boss.cookie, other.id, {
        hats: ['support'],
        costView: true,
        reason: 'Stepped down',
      });
      expect(reasoned.status).toBe(200);
      expect(await hatsOf(other.id)).toEqual(['support']);
    });

    it.each([
      ['NO_HAT', [], false],
      ['HAT_CONFLICT', ['partner'], false],
      ['HAT_CONFLICT', ['partner', 'support'], false],
      ['GRANT_NOT_ALLOWED', ['partner'], true],
    ] as const)('answers 422 %s to %j on the staff route', async (code, hats, costView) => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);

      const reply = await putAccess(boss.cookie, person.id, { hats: [...hats], costView });

      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ code });
      expect(await hatsOf(person.id)).toEqual(['warehouse']);
    });
  });

  describe('the audit entry, the log line and HatsChanged (AC-13)', () => {
    it('writes one entry per change in the change’s own transaction, then one line and one event after the commit', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const log = vi.spyOn(Logger.prototype, 'log');
      const eventsBefore = events.length;

      const reply = await putAccess(boss.cookie, person.id, {
        hats: ['support'],
        costView: true,
        reason: 'Moved to the support desk',
      });
      expect(reply.status).toBe(200);

      const entries = await probeRows(person.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'hat.revoked',
        actor: { kind: 'person', userId: boss.id, hat: 'manager' },
        before: { hats: ['warehouse'], costView: false, partnerAccountId: null },
        after: { hats: ['support'], costView: true, partnerAccountId: null },
        reason: 'Moved to the support desk',
      });
      // The entry was written by the transaction that changed the person's row.
      const { rows } = await owner.pool.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM users WHERE id = $1::uuid',
        [person.id],
      );
      expect(entries[0]?.xact).toBe(rows[0]?.xmin);

      expect(events.length - eventsBefore).toBe(1);
      const event = events.at(-1) as HatsChanged;
      expect(event).toMatchObject({
        context: { actorId: boss.id, targetId: person.id },
        before: { hats: ['warehouse'], costView: false, partnerAccountId: null },
        after: { hats: ['support'], costView: true, partnerAccountId: null },
        reason: 'Moved to the support desk',
      });
      expect(typeof event.context.ip).toBe('string');
      // The listener read the committed rows: the event came after the commit.
      expect(await seenAtEvent.at(-1)).toEqual(['support']);

      const lines = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('"event":"HatsChanged"') && line.includes(person.id));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        actorId: boss.id,
        hatsAdded: ['support'],
        hatsRemoved: ['warehouse'],
        before: { hats: ['warehouse'], costView: false },
        after: { hats: ['support'], costView: true },
        reason: 'Moved to the support desk',
      });
      expect(lines[0]).not.toContain(person.email);
      // What the log sink writes: the manager's free text never reaches it (redaction.ts).
      expect(JSON.parse(redact(lines[0]) as string)).toMatchObject({
        reason: REDACTED,
        hatsRemoved: ['warehouse'],
      });
      log.mockRestore();
    });

    it('leaves no entry, no change and no event when the transaction rolls back', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      probe.failFor.add(person.id);
      const eventsBefore = events.length;

      const reply = await putAccess(boss.cookie, person.id, { hats: ['support'], costView: true });

      probe.failFor.delete(person.id);
      expect(reply.status).toBe(500);
      expect(await probeRows(person.id)).toEqual([]);
      expect(await hatsOf(person.id)).toEqual(['warehouse']);
      expect(await costOf(person.id)).toBe(false);
      expect(events.length).toBe(eventsBefore);
    });

    it('records no entry and no event for a change that changes nothing', async () => {
      const boss = await manager();
      const person = await addPerson(['warehouse']);
      const eventsBefore = events.length;

      const reply = await putAccess(boss.cookie, person.id, {
        hats: ['warehouse'],
        costView: false,
      });

      expect(reply.status).toBe(200);
      expect(await probeRows(person.id)).toEqual([]);
      expect(events.length).toBe(eventsBefore);
    });

    it('records staff_user.created, disabled, enabled and password_reset in their own transactions', async () => {
      const boss = await manager();
      const made = await call(boss.cookie, 'POST', '/api/staff', {
        name: 'Audited Person',
        email: 'audited.person@example.com',
        hats: ['warehouse', 'support'],
        costView: false,
      });
      expect(made.status).toBe(201);
      const id = (made.body.staff as { id: string }).id;
      await call(boss.cookie, 'POST', `/api/staff/${id}/reset-password`);
      await call(boss.cookie, 'POST', `/api/staff/${id}/disable`, { reason: 'Left' });
      await call(boss.cookie, 'POST', `/api/staff/${id}/enable`);

      const entries = await probeRows(id);
      expect(entries.map((entry) => entry.action)).toEqual([
        'staff_user.created',
        'staff_user.password_reset',
        'staff_user.disabled',
        'staff_user.enabled',
      ]);
      expect(entries[0]?.after).toEqual({
        hats: ['support', 'warehouse'],
        costView: false,
        partnerAccountId: null,
      });
      expect(entries[2]).toMatchObject({ after: { banned: true }, reason: 'Left' });
      for (const entry of entries) {
        expect(entry.actor).toEqual({ kind: 'person', userId: boss.id, hat: 'manager' });
        expect(JSON.stringify(entry)).not.toContain('audited.person@example.com');
      }
      // The new person's hats were granted by the acting manager.
      const { rows } = await owner.pool.query<{ granted_by: string }>(
        'SELECT DISTINCT granted_by FROM hat_assignments WHERE user_id = $1::uuid',
        [id],
      );
      expect(rows).toEqual([{ granted_by: boss.id }]);
    });
  });

  describe('the last manager (AC-12, AC-14)', () => {
    it('lets exactly one of two managers removing each other’s manager hat at once succeed', async () => {
      const first = await manager();
      const second = await manager();
      // Every other manager is disabled, so these two are the only active ones.
      await owner.pool.query(
        `UPDATE users SET banned = true
          WHERE id IN (SELECT user_id FROM hat_assignments WHERE hat = 'manager')
            AND id NOT IN ($1::uuid, $2::uuid)`,
        [first.id, second.id],
      );
      const firstAt = (await detail(second.cookie, first.id)).updatedAt;
      const secondAt = (await detail(first.cookie, second.id)).updatedAt;

      // Hold the last manager lock so both requests pass their guards and queue on it together.
      const holder = await owner.pool.connect();
      let replies: Reply[];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_RULE_LOCK]);
        const change = { hats: ['support'], costView: true, reason: 'Handing over' };
        const both = Promise.all([
          putAccess(first.cookie, second.id, change, secondAt),
          putAccess(second.cookie, first.id, change, firstAt),
        ]);
        await eventually(
          async () => {
            const { rows } = await owner.pool.query<{ waiting: string }>(
              `SELECT count(*) AS waiting FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = $1`,
              [ADMIN_RULE_LOCK],
            );
            return Number(rows[0]?.waiting) >= 2 ? true : undefined;
          },
          { what: 'both changes waiting on the last manager lock' },
        );
        await holder.query('COMMIT');
        replies = await both;
      } finally {
        holder.release();
      }

      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.body).toMatchObject({
        code: 'LAST_ADMIN',
      });
      const managers = [await hatsOf(first.id), await hatsOf(second.id)].filter((hats) =>
        hats.includes('manager'),
      );
      expect(managers).toHaveLength(1);
    });
  });
});
