import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { MeResponse } from '@ssdashboard/contracts';
import {
  APP_ROLE,
  createDatabase,
  runMigrations,
  sql,
  type DatabaseConnection,
  type SQL,
} from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { pgArray } from '../src/database/sql.js';
import {
  hatChangeEndsSessions,
  revokeSessions,
  type HatStanding,
} from '../src/identity/sessions/revoke-sessions.js';
import {
  SESSION_AUDIENCES,
  StaffOnlySessionAudiences,
  type SessionAudience,
  type SessionAudiences,
} from '../src/identity/sessions/session-audiences.js';
import { createFirstAdmin } from '../src/identity/sign-in/first-admin.js';
import { breakGlassReset } from '../src/identity/sign-in/reset-admin.js';
import { createScratchDatabase, dropScratchDatabase, freePort } from './support.js';

const PASSWORD = 'Correct-Horse-1';

/** What a person holds in the fake hat model: hat names, and a partner account for the partner hat. */
interface Holding {
  hats: string[];
  partnerAccountId: string | null;
}

/** The audiences a set of fake hats allows: `partner` for the partner hat, `staff` for any other. */
function audiencesOf(holding: Holding): Set<SessionAudience> {
  return new Set(
    holding.hats.map((hat): SessionAudience => (hat === 'partner' ? 'partner' : 'staff')),
  );
}

/**
 * A stand in for spec 0008's hats behind the `SessionAudiences` port. Someone it was never told
 * about is staff, as before hats. It counts every question, so a test can see the guard asking on
 * every request.
 */
class FakeHats implements SessionAudiences {
  readonly asked: string[] = [];
  private readonly holdings = new Map<string, Holding>();

  hold(userId: string, holding: Holding): void {
    this.holdings.set(userId, holding);
  }

  holdingOf(userId: string): Holding {
    return this.holdings.get(userId) ?? { hats: ['warehouse'], partnerAccountId: null };
  }

  standingOf(userId: string): HatStanding {
    const holding = this.holdingOf(userId);
    return { audiences: audiencesOf(holding), partnerAccountId: holding.partnerAccountId };
  }

  audiencesFor(userId: string): Promise<ReadonlySet<SessionAudience>> {
    this.asked.push(userId);
    return Promise.resolve(audiencesOf(this.holdingOf(userId)));
  }

  staffCondition(): SQL {
    const notStaff = [...this.holdings.keys()].filter(
      (id) => !audiencesOf(this.holdingOf(id)).has('staff'),
    );
    return notStaff.length === 0
      ? sql`TRUE`
      : sql`NOT (users.id = ANY(${pgArray(notStaff)}::uuid[]))`;
  }
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

// Spec 0005 milestone 3: the audience aware guard (AC-29), partner users kept out of the staff
// administration (AC-28), and sessions that follow hat changes (AC-33), with spec 0008's hats
// played by a fake behind the `SessionAudiences` port. The api runs in this process so the port
// can be swapped; everything else is the real AppModule on a scratch database.
describe('sessions and audiences', { timeout: 300_000 }, () => {
  const hats = new FakeHats();
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let appDb: DatabaseConnection;
  let app: NestExpressApplication | undefined;
  let base: string;
  let hash: string;
  let counter = 0;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    appDb = createDatabase(appUrl.toString(), { max: 2 });

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // The env the api reads at startup, as Compose would give it; production skips the dev .env.
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      MAIL_DRIVER: 'none',
      PORT: String(port),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_AUDIENCES)
      .useValue(hats)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app);
    await app.listen(port, '127.0.0.1');
    hash = await hashPassword(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await appDb?.pool.end();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
    process.env = savedEnv;
  });

  const freshIp = () => {
    counter += 1;
    return `198.51.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
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

  /** Adds a person straight to the database and, unless told otherwise, gives them fake hats. */
  async function addPerson(
    options: { role?: 'admin' | 'staff'; holding?: Holding } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `person${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, role, last_sign_in_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [`Person ${counter}`, email, options.role ?? 'staff'],
    );
    const id = rows[0]?.id as string;
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    if (options.holding) hats.hold(id, options.holding);
    return { id, email };
  }

  /** Signs in through Better Auth, the same route for every kind of person, and returns the cookie. */
  async function signIn(email: string): Promise<string> {
    const reply = await call(undefined, 'POST', '/api/auth/sign-in/email', {
      email,
      password: PASSWORD,
    });
    const found = reply.headers.getSetCookie().find((c) => c.includes('session_token'));
    if (!found) throw new Error(`sign in failed with ${reply.status}`);
    return found.split(';')[0] as string;
  }

  async function sessionsOf(userId: string): Promise<number> {
    const { rows } = await owner.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM sessions WHERE user_id = $1::uuid',
      [userId],
    );
    return Number(rows[0]?.count);
  }

  /**
   * Spec 0008's hat service in miniature: judges the change by AC-33 (b) and, when it must,
   * revokes the sessions inside the same transaction as the change. `failAfterRevoke` makes the
   * change fail after the revoke, to prove the two commit or roll back together.
   */
  async function changeHats(
    userId: string,
    next: Holding,
    options: { failAfterRevoke?: boolean } = {},
  ): Promise<boolean> {
    const before = hats.standingOf(userId);
    const after: HatStanding = {
      audiences: audiencesOf(next),
      partnerAccountId: next.partnerAccountId,
    };
    const ends = hatChangeEndsSessions(before, after);
    await appDb.db.transaction(async (tx) => {
      if (ends) await revokeSessions(userId, tx);
      if (options.failAfterRevoke) throw new Error('the change failed');
      hats.hold(userId, next);
    });
    return ends;
  }

  const staffHolding = (...names: string[]): Holding => ({ hats: names, partnerAccountId: null });
  const partnerHolding = (account: string): Holding => ({
    hats: ['partner'],
    partnerAccountId: account,
  });

  describe('home and the audience of the route (AC-28, AC-29)', () => {
    it('answers GET /api/me with home backoffice for staff, in the MeResponse contract', async () => {
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const cookie = await signIn(person.email);

      const me = await call(cookie, 'GET', '/api/me');

      expect(me.status).toBe(200);
      expect(MeResponse.parse(me.body)).toMatchObject({ id: person.id, home: 'backoffice' });
    });

    it('signs a partner user in on the same route, then answers 403 WRONG_AUDIENCE on staff routes', async () => {
      const partner = await addPerson({ holding: partnerHolding('p1') });
      const cookie = await signIn(partner.email);

      for (const path of ['/api/me', '/api/staff', '/api/locations']) {
        const reply = await call(cookie, 'GET', path);
        expect(reply.status, path).toBe(403);
        expect(reply.body, path).toMatchObject({ code: 'WRONG_AUDIENCE' });
      }
      expect(await sessionsOf(partner.id)).toBe(1);
    });

    it('keeps the 401 answers: no cookie is UNAUTHENTICATED, a dead one SESSION_EXPIRED', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);
      await owner.pool.query('DELETE FROM sessions WHERE user_id = $1::uuid', [person.id]);

      expect((await call(undefined, 'GET', '/api/me')).body).toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect((await call(cookie, 'GET', '/api/me')).body).toMatchObject({
        code: 'SESSION_EXPIRED',
      });
    });
  });

  describe('sessions follow hats (AC-33)', () => {
    it('asks on every request, so a change acts on the next request with the same cookie (a)', async () => {
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const cookie = await signIn(person.email);
      const askedBefore = hats.asked.filter((id) => id === person.id).length;

      expect((await call(cookie, 'GET', '/api/me')).status).toBe(200);
      // The model moves the person away from staff without ending the session.
      hats.hold(person.id, partnerHolding('p1'));
      expect((await call(cookie, 'GET', '/api/me')).body).toMatchObject({
        code: 'WRONG_AUDIENCE',
      });
      hats.hold(person.id, staffHolding('warehouse'));
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(200);

      expect(hats.asked.filter((id) => id === person.id).length - askedBefore).toBe(3);
    });

    it('ends every session when the last hat goes, in the same transaction, and no one else’s (b)', async () => {
      // Someone else signs in first, so their sessions are older rows the revoke must leave alone.
      const bystander = await addPerson({ holding: staffHolding('warehouse') });
      const bystanderCookie = await signIn(bystander.email);
      await signIn(bystander.email);
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const first = await signIn(person.email);
      const second = await signIn(person.email);

      expect(await changeHats(person.id, staffHolding())).toBe(true);

      expect(await sessionsOf(person.id)).toBe(0);
      for (const cookie of [first, second]) {
        const reply = await call(cookie, 'GET', '/api/me');
        expect(reply.status).toBe(401);
        expect(reply.body).toMatchObject({ code: 'SESSION_EXPIRED' });
      }
      expect(await sessionsOf(bystander.id)).toBe(2);
      expect((await call(bystanderCookie, 'GET', '/api/me')).status).toBe(200);
    });

    it('ends every session on a move between the staff and partner audiences (b)', async () => {
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const cookie = await signIn(person.email);

      expect(await changeHats(person.id, partnerHolding('p1'))).toBe(true);

      expect(await sessionsOf(person.id)).toBe(0);
      expect((await call(cookie, 'GET', '/api/me')).body).toMatchObject({
        code: 'SESSION_EXPIRED',
      });
    });

    it('ends every session on a move to another partner account (b)', async () => {
      const partner = await addPerson({ holding: partnerHolding('p1') });
      const cookie = await signIn(partner.email);

      expect(await changeHats(partner.id, partnerHolding('p2'))).toBe(true);

      expect(await sessionsOf(partner.id)).toBe(0);
      expect((await call(cookie, 'GET', '/api/me')).body).toMatchObject({
        code: 'SESSION_EXPIRED',
      });
    });

    it('keeps the sessions when a hat is added or removed and one of the same audience stays (b)', async () => {
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const cookie = await signIn(person.email);

      expect(await changeHats(person.id, staffHolding('warehouse', 'support'))).toBe(false);
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(200);
      expect(await changeHats(person.id, staffHolding('support'))).toBe(false);
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(200);

      expect(await sessionsOf(person.id)).toBe(1);
    });

    it('keeps the sessions when the change that revoked them rolls back (c)', async () => {
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const cookie = await signIn(person.email);

      await expect(
        changeHats(person.id, staffHolding(), { failAfterRevoke: true }),
      ).rejects.toThrow('the change failed');

      expect(await sessionsOf(person.id)).toBe(1);
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(200);
    });

    it('treats a live session of a person with no hat as ended, and deletes it', async () => {
      const person = await addPerson({ holding: staffHolding('warehouse') });
      const cookie = await signIn(person.email);
      hats.hold(person.id, staffHolding());

      const reply = await call(cookie, 'GET', '/api/me');

      expect(reply.status).toBe(401);
      expect(reply.body).toMatchObject({ code: 'SESSION_EXPIRED' });
      expect(await sessionsOf(person.id)).toBe(0);
    });
  });

  describe('a partner user signs in under the staff rules (AC-28)', () => {
    interface Answer {
      status: number;
      /** The body as text, so two answers can be compared byte for byte. */
      text: string;
      cookie: string | undefined;
    }

    async function post(path: string, body: unknown, ip: string): Promise<Answer> {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip },
        body: JSON.stringify(body),
      });
      const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
      return {
        status: response.status,
        text: await response.text(),
        cookie: cookie?.split(';')[0],
      };
    }

    const signInFrom = (email: string, password: string, ip: string) =>
      post('/api/auth/sign-in/email', { email, password }, ip);

    const lockedAt = (email: string, ip: string) =>
      owner.pool
        .query<{ locked: boolean }>(
          `SELECT COALESCE(locked_until > now(), false) AS locked
             FROM sign_in_attempts WHERE email_key = $1 AND scope = $2`,
          [email, ip],
        )
        .then((result) => result.rows[0]?.locked ?? false);

    it('locks a partner email after five wrong passwords, answering byte for byte as for staff and an unknown email', async () => {
      const partner = await addPerson({ holding: partnerHolding('p1') });
      const staff = await addPerson({ holding: staffHolding('warehouse') });
      counter += 1;
      const unknown = `nobody${counter}@example.com`;

      const answers: Array<{ email: string; ip: string; wrong: Answer; locked: Answer }> = [];
      for (const email of [partner.email, staff.email, unknown]) {
        const ip = freshIp();
        const wrong = await signInFrom(email, 'Wrong-Password-1', ip);
        for (let i = 1; i < 5; i += 1) await signInFrom(email, 'Wrong-Password-1', ip);
        // The right password now meets the lock, for the two real people.
        const locked = await signInFrom(email, PASSWORD, ip);
        answers.push({ email, ip, wrong, locked });
      }

      const generic = answers[0]?.wrong;
      expect(generic?.status).toBe(401);
      expect(JSON.parse(generic?.text ?? '{}')).toMatchObject({
        code: 'INVALID_EMAIL_OR_PASSWORD',
      });
      for (const answer of answers) {
        expect(answer.wrong.status, answer.email).toBe(generic?.status);
        expect(answer.wrong.text, answer.email).toBe(generic?.text);
        expect(answer.locked.status, answer.email).toBe(generic?.status);
        expect(answer.locked.text, answer.email).toBe(generic?.text);
        expect(answer.locked.cookie, answer.email).toBeUndefined();
        expect(await lockedAt(answer.email, answer.ip), answer.email).toBe(true);
      }
      expect(await sessionsOf(partner.id)).toBe(0);
      // The lock, not the audience, turned the partner away: another address lets them in.
      expect((await signInFrom(partner.email, PASSWORD, freshIp())).cookie).toBeDefined();
    });

    it('answers a reset request for a partner user exactly as for staff and an unknown email', async () => {
      const partner = await addPerson({ holding: partnerHolding('p1') });
      const staff = await addPerson({ holding: staffHolding('warehouse') });
      counter += 1;
      const unknown = `nobody${counter}@example.com`;

      const replies: Answer[] = [];
      for (const email of [partner.email, staff.email, unknown]) {
        replies.push(
          await post(
            '/api/auth/request-password-reset',
            { email, redirectTo: `${base}/reset-password` },
            freshIp(),
          ),
        );
      }

      expect(replies[0]?.status).toBe(200);
      for (const reply of replies) {
        expect(reply.status).toBe(replies[0]?.status);
        expect(reply.text).toBe(replies[0]?.text);
      }
    });
  });

  // Runs last: it disables every other admin to reach the last admin rule.
  describe('staff administration stays staff only (AC-28)', () => {
    let admin: { id: string; email: string };
    let partner: { id: string; email: string };
    let cookie: string;

    beforeAll(async () => {
      admin = await addPerson({ role: 'admin', holding: staffHolding('manager') });
      // A partner user whose row says admin: the row must never make them one.
      partner = await addPerson({ role: 'admin', holding: partnerHolding('p1') });
      cookie = await signIn(admin.email);
    });

    it('never lists a partner user on /api/staff', async () => {
      const list = await call(cookie, 'GET', '/api/staff?limit=100');

      expect(list.status).toBe(200);
      const ids = (list.body.rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(admin.id);
      expect(ids).not.toContain(partner.id);
    });

    it.each([
      ['GET', ''],
      ['PATCH', ''],
      ['POST', '/disable'],
      ['POST', '/enable'],
      ['POST', '/reset-password'],
      ['POST', '/revoke-sessions'],
      ['POST', '/reset-two-factor'],
    ])('answers 404 to %s /api/staff/:id%s for a partner user', async (method, suffix) => {
      const body = method === 'PATCH' ? { role: 'admin' } : method === 'POST' ? {} : undefined;

      const reply = await call(cookie, method, `/api/staff/${partner.id}${suffix}`, body);

      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('never counts a partner user as the other active admin', async () => {
      await owner.pool.query(
        `UPDATE users SET banned = true WHERE role = 'admin' AND id NOT IN ($1::uuid, $2::uuid)`,
        [admin.id, partner.id],
      );

      const reply = await call(cookie, 'PATCH', `/api/staff/${admin.id}`, { role: 'staff' });

      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'LAST_ADMIN' });
    });

    it('lets create-admin make a staff admin when the only active admin is a partner user', async () => {
      await owner.pool.query(`UPDATE users SET banned = true WHERE id = $1::uuid`, [admin.id]);

      // The staff only port counts every row, the planted partner admin too.
      const staffOnly = await createFirstAdmin(
        appDb.db,
        { email: 'first@example.com', name: 'First' },
        new StaffOnlySessionAudiences(),
      );
      expect(staffOnly).toMatchObject({ created: false, reason: 'admin_exists' });

      const made = await createFirstAdmin(
        appDb.db,
        { email: 'first@example.com', name: 'First' },
        hats,
      );
      expect(made).toMatchObject({ created: true });
    });

    it('refuses a create-admin reset for a partner user, whatever their row says', async () => {
      const reset = await breakGlassReset(
        appDb.db,
        { email: partner.email },
        { password: true, twoFactor: false },
        hats,
      );

      expect(reset).toMatchObject({ reset: false, reason: 'not_admin' });
    });
  });
});
