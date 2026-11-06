import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  eventually,
  freePort,
  giveHats,
  start,
  startSmtpCapture,
  stop,
  waitForHttp,
  type CapturedMail,
  type RunningProcess,
} from './support.js';

const PASSWORD = 'Correct-Horse-1';
const NEW_PASSWORD = 'Brand-New-Pass-9';

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

// Spec 0005, slice 4: staff administration and the forced password change.
describe('staff administration', { timeout: 300_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let smtp: Awaited<ReturnType<typeof startSmtpCapture>> | undefined;
  let api: RunningProcess | undefined;
  let mailApi: RunningProcess | undefined;
  let worker: RunningProcess | undefined;
  let base: string;
  let mailBase: string;
  let hash: string;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 4 });
    smtp = await startSmtpCapture();
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const secret = randomBytes(32).toString('base64url');
    const common = { DATABASE_URL: appUrl.toString(), BETTER_AUTH_SECRET: secret };

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', { ...common, PORT: String(port), PUBLIC_URL: base });
    await waitForHttp(`${base}/api/health`, api);

    const mailPort = await freePort();
    mailBase = `http://127.0.0.1:${mailPort}`;
    const mailEnv = {
      ...common,
      MAIL_DRIVER: 'smtp',
      MAIL_FROM: 'Acme ERP <no-reply@acme.test>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURITY: 'none',
      CLIENT_DISPLAY_NAME: 'Acme Home',
      PUBLIC_URL: mailBase,
    };
    mailApi = start('main.js', { ...mailEnv, PORT: String(mailPort) });
    await waitForHttp(`${mailBase}/api/health`, mailApi);
    worker = start('worker.js', mailEnv);
    await eventually(() => (worker?.output().includes('Worker started') ? true : undefined), {
      what: 'the worker to start',
    });
    hash = await hashPassword(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    await stop(worker);
    await stop(mailApi);
    await stop(api);
    await smtp?.close();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const freshIp = () => {
    counter += 1;
    return `203.0.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
  };

  async function addPerson(
    options: { role?: 'admin' | 'staff'; banned?: boolean; signedIn?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `person${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, banned, last_sign_in_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        `Person ${counter}`,
        email,
        options.banned ?? false,
        options.signedIn === false ? null : new Date(),
      ],
    );
    const id = rows[0]?.id as string;
    await giveHats(owner.pool, id, options.role ?? 'staff');
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    return { id, email };
  }

  async function login(origin: string, email: string, password = PASSWORD): Promise<Reply> {
    return call(origin, undefined, 'POST', '/api/auth/sign-in/email', { email, password });
  }

  async function call(
    origin: string,
    cookie: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin,
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
    };
  }

  const cookieOf = (reply: Reply): string => {
    const found = reply.headers.getSetCookie().find((c) => c.includes('session_token'));
    if (!found) throw new Error(`no session cookie (status ${reply.status})`);
    return found.split(';')[0] as string;
  };

  async function adminCookie(
    origin = base,
  ): Promise<{ cookie: string; id: string; email: string }> {
    const admin = await addPerson({ role: 'admin' });
    return { ...admin, cookie: cookieOf(await login(origin, admin.email)) };
  }

  const create = (cookie: string, body: Record<string, unknown>, origin = base) =>
    call(origin, cookie, 'POST', '/api/staff', {
      name: 'New Person',
      email: `new${(counter += 1)}@example.com`,
      role: 'staff',
      ...body,
    });

  const staff = (reply: Reply) => reply.body.staff as Record<string, unknown>;
  const setup = (reply: Reply) => reply.body.setup as Record<string, string>;

  describe('who may use it (AC-15)', () => {
    it('answers 401 with no session and 403 FORBIDDEN to a staff role, and lets an admin in', async () => {
      expect((await call(base, undefined, 'GET', '/api/staff')).status).toBe(401);

      const person = await addPerson();
      const forbidden = await call(
        base,
        cookieOf(await login(base, person.email)),
        'GET',
        '/api/staff',
      );
      expect(forbidden.status).toBe(403);
      expect(forbidden.body).toMatchObject({ code: 'FORBIDDEN' });

      const admin = await adminCookie();
      expect((await call(base, admin.cookie, 'GET', '/api/staff')).status).toBe(200);
    });

    it('closes Better Auth routes that would bypass the staff service', async () => {
      const admin = await adminCookie();
      for (const path of [
        '/api/auth/admin/list-users',
        '/api/auth/admin/ban-user',
        '/api/auth/sign-up/email',
        '/api/auth/update-user',
        '/api/auth/change-email',
      ]) {
        const reply = await call(base, admin.cookie, 'POST', path, {});
        expect(reply.status, path).toBe(404);
      }
    });
  });

  describe('creating an account with no mail (AC-12, AC-14)', () => {
    it('shows a temporary password once, then forces a change before anything else works', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, {
        name: '  Sam Ali ',
        email: 'Sam.Ali@Example.COM',
        staffCode: ' sa1 ',
        phone: '+20 100 123 4567',
        language: 'en',
      });

      expect(made.status).toBe(201);
      expect(setup(made).mode).toBe('temporary_password');
      const temporary = setup(made).temporaryPassword as string;
      expect(temporary).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{16}$/);
      expect(staff(made)).toMatchObject({
        name: 'Sam Ali',
        email: 'sam.ali@example.com',
        staffCode: 'SA1',
        status: 'invited',
        role: 'staff',
      });
      // The preset becomes hats (spec 0008 milestone 1, the AC-16 mapping), given by the admin.
      const held = await owner.pool.query<{ hat: string; granted_by: string }>(
        'SELECT hat, granted_by FROM hat_assignments WHERE user_id = $1::uuid ORDER BY hat',
        [staff(made).id],
      );
      expect(held.rows.map((row) => row.hat)).toEqual(['operations', 'support', 'warehouse']);
      expect(new Set(held.rows.map((row) => row.granted_by))).toEqual(new Set([admin.id]));
      const grants = await owner.pool.query(
        'SELECT 1 FROM permission_grants WHERE user_id = $1::uuid',
        [staff(made).id],
      );
      expect(grants.rows).toEqual([]);
      const stored = await owner.pool.query<{ password: string; must_change_password: boolean }>(
        `SELECT a.password, u.must_change_password FROM users u JOIN accounts a ON a.user_id = u.id
          WHERE u.id = $1::uuid`,
        [staff(made).id],
      );
      expect(stored.rows[0]?.must_change_password).toBe(true);
      expect(stored.rows[0]?.password).not.toContain(temporary);

      const session = await login(base, 'sam.ali@example.com', temporary);
      expect(session.status).toBe(200);
      const cookie = cookieOf(session);
      expect((await call(base, cookie, 'GET', '/api/me')).body).toMatchObject({
        mustChangePassword: true,
      });
      const blocked = await call(base, cookie, 'GET', '/api/locations');
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
      expect((await call(base, cookie, 'GET', '/api/staff')).status).toBe(403);
    });

    it('clears the flag when the password is changed, revoking the other sessions', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, {});
      const email = staff(made).email as string;
      const temporary = setup(made).temporaryPassword as string;
      const first = cookieOf(await login(base, email, temporary));
      const second = cookieOf(await login(base, email, temporary));

      const weak = await call(base, first, 'POST', '/api/auth/change-password', {
        currentPassword: temporary,
        newPassword: 'short',
      });
      expect(weak.status).toBe(422);
      expect(weak.body).toMatchObject({ code: 'WEAK_PASSWORD' });

      const wrong = await call(base, first, 'POST', '/api/auth/change-password', {
        currentPassword: 'Not-The-Password-1',
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ code: 'INVALID_PASSWORD' });

      const changed = await call(base, first, 'POST', '/api/auth/change-password', {
        currentPassword: temporary,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      });
      expect(changed.status).toBe(200);
      const fresh = changed.headers.getSetCookie().some((c) => c.includes('session_token'))
        ? cookieOf(changed)
        : first;

      expect((await call(base, fresh, 'GET', '/api/locations')).status).toBe(200);
      expect((await call(base, fresh, 'GET', '/api/me')).body).toMatchObject({
        mustChangePassword: false,
      });
      expect((await call(base, second, 'GET', '/api/me')).status).toBe(401);
      expect((await login(base, email, temporary)).status).toBe(401);
      expect((await login(base, email, NEW_PASSWORD)).status).toBe(200);
    });

    it('ends the other sessions on a password change even when the client asks it not to', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, {});
      const email = staff(made).email as string;
      const temporary = setup(made).temporaryPassword as string;
      const first = cookieOf(await login(base, email, temporary));
      const second = cookieOf(await login(base, email, temporary));

      const changed = await call(base, first, 'POST', '/api/auth/change-password', {
        currentPassword: temporary,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: false,
      });

      expect(changed.status).toBe(200);
      expect((await call(base, second, 'GET', '/api/me')).status).toBe(401);
      // The session that made the change goes on, under its new cookie.
      expect((await call(base, cookieOf(changed), 'GET', '/api/me')).status).toBe(200);
    });

    it('counts wrong current passwords toward the same lock as sign in (AC-3)', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, {});
      const email = staff(made).email as string;
      const cookie = cookieOf(await login(base, email, setup(made).temporaryPassword));
      const ip = freshIp();
      const change = (currentPassword: string) =>
        fetch(`${base}/api/auth/change-password`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: base,
            cookie,
            'x-forwarded-for': ip,
          },
          body: JSON.stringify({ currentPassword, newPassword: NEW_PASSWORD }),
        });

      for (let i = 0; i < 5; i += 1) expect((await change('Wrong-Password-1')).status).toBe(400);
      const locked = await owner.pool.query(
        `SELECT 1 FROM sign_in_attempts WHERE email_key = $1 AND locked_until > now()`,
        [email],
      );
      expect(locked.rows.length).toBeGreaterThan(0);

      // Locked: even the right password gets the same answer as a wrong one.
      const answer = await change(setup(made).temporaryPassword as string);
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
    });

    it('refuses duplicates and bad fields with stable codes', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, { staffCode: 'DUP1' });
      const email = staff(made).email as string;

      const sameEmail = await create(admin.cookie, { email: email.toUpperCase() });
      expect(sameEmail.status).toBe(409);
      expect(sameEmail.body).toMatchObject({ code: 'EMAIL_TAKEN' });
      const sameCode = await create(admin.cookie, { staffCode: 'dup1' });
      expect(sameCode.status).toBe(409);
      expect(sameCode.body).toMatchObject({ code: 'STAFF_CODE_TAKEN' });

      for (const change of [{ name: ' ' }, { email: 'nope' }, { role: 'owner' }, { phone: '12' }]) {
        const bad = await create(admin.cookie, change);
        expect(bad.status, JSON.stringify(change)).toBe(422);
        expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      const language = await create(admin.cookie, { language: 'xx' });
      expect(language.status).toBe(422);
      expect(language.body).toMatchObject({ code: 'INVALID_LANGUAGE' });
    });
  });

  describe('listing and searching (AC-15)', () => {
    it('pages by name with a keyset cursor, never skipping or repeating a row', async () => {
      const admin = await adminCookie();
      const names = ['Zed Pages', 'amir Pages', 'Bella Pages', 'carl Pages', 'Dina Pages'];
      for (const name of names) await create(admin.cookie, { name });

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await call(
          base,
          admin.cookie,
          'GET',
          `/api/staff?q=Pages&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(page.status).toBe(200);
        for (const row of page.body.rows as Array<{ name: string }>) seen.push(row.name);
        cursor = (page.body.nextCursor as string | null) ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(['amir Pages', 'Bella Pages', 'carl Pages', 'Dina Pages', 'Zed Pages']);
    });

    it('searches name, email and staff code as an escaped contains match', async () => {
      const admin = await adminCookie();
      await create(admin.cookie, { name: 'Fifty% Off', staffCode: 'PCT50' });
      await create(admin.cookie, { name: 'Fiftyx Off' });
      const find = async (q: string) =>
        (
          (await call(base, admin.cookie, 'GET', `/api/staff?q=${encodeURIComponent(q)}`)).body
            .rows as Array<{ name: string }>
        ).map((row) => row.name);

      expect(await find('Fifty%')).toEqual(['Fifty% Off']);
      expect(await find('pct5')).toEqual(['Fifty% Off']);
      expect(await find('fiftyx')).toEqual(['Fiftyx Off']);
      expect(await find('_')).not.toContain('Fiftyx Off');
    });

    it('filters by status and shows the derived status of each person', async () => {
      const admin = await adminCookie();
      const invited = await addPerson({ signedIn: false });
      const active = await addPerson();
      const disabled = await addPerson({ banned: true });
      const statusOf = async (status: string) =>
        (
          (await call(base, admin.cookie, 'GET', `/api/staff?status=${status}&limit=100`)).body
            .rows as Array<{ id: string }>
        ).map((row) => row.id);

      expect(await statusOf('invited')).toContain(invited.id);
      expect(await statusOf('invited')).not.toContain(active.id);
      expect(await statusOf('active')).toContain(active.id);
      expect(await statusOf('disabled')).toContain(disabled.id);
      expect(await statusOf('disabled')).not.toContain(active.id);
    });

    it('answers 400 INVALID_QUERY for a page size over 100 and for a cursor it did not issue', async () => {
      const admin = await adminCookie();

      for (const query of ['limit=101', 'limit=0', 'cursor=AAAA', 'status=banned']) {
        const reply = await call(base, admin.cookie, 'GET', `/api/staff?${query}`);
        expect(reply.status, query).toBe(400);
        expect(reply.body).toMatchObject({ code: 'INVALID_QUERY' });
      }
    });

    it('stores an Arabic digit phone as Western digits (AC-18)', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, { phone: '٠١٠١٢٣٤٥٦٧٨' });
      expect(made.status).toBe(201);
      const one = await call(base, admin.cookie, 'GET', `/api/staff/${staff(made).id as string}`);
      expect(one.body).toMatchObject({ phone: '01012345678' });
    });

    it('returns the edit form fields for one person, and 404 for an unknown or malformed id', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, { phone: '+20 100 000 0000', staffCode: 'abc' });

      const one = await call(base, admin.cookie, 'GET', `/api/staff/${staff(made).id as string}`);
      expect(one.body).toMatchObject({
        phone: '+20 100 000 0000',
        staffCode: 'ABC',
        language: null,
        disableReason: null,
      });
      expect(typeof one.body.createdAt).toBe('string');
      for (const id of ['0190c0de-0000-7000-8000-00000000dead', 'not-a-uuid']) {
        expect((await call(base, admin.cookie, 'GET', `/api/staff/${id}`)).status).toBe(404);
      }
    });
  });

  describe('editing (AC-15, AC-17)', () => {
    it('changes details and role, and clears a field with empty text', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, { phone: '+20 100 000 0000' });
      const id = staff(made).id as string;

      const edited = await call(base, admin.cookie, 'PATCH', `/api/staff/${id}`, {
        name: 'Renamed',
        phone: '',
        staffCode: 'new9',
        language: 'ar',
        role: 'admin',
      });

      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({
        name: 'Renamed',
        phone: null,
        staffCode: 'NEW9',
        language: 'ar',
        role: 'admin',
      });
      // The admin preset is the manager hat plus the cost grant, and nothing else stays.
      const held = await owner.pool.query<{ hat: string }>(
        'SELECT hat FROM hat_assignments WHERE user_id = $1::uuid',
        [id],
      );
      expect(held.rows.map((row) => row.hat)).toEqual(['manager']);
      const grants = await owner.pool.query<{ permission: string }>(
        'SELECT permission FROM permission_grants WHERE user_id = $1::uuid',
        [id],
      );
      expect(grants.rows.map((row) => row.permission)).toEqual(['cost.view']);
    });

    it('lets the email change only while the account is invited', async () => {
      const admin = await adminCookie();
      const invited = await addPerson({ signedIn: false });
      const active = await addPerson();

      const ok = await call(base, admin.cookie, 'PATCH', `/api/staff/${invited.id}`, {
        email: 'Renamed.Invitee@Example.com',
      });
      expect(ok.body).toMatchObject({ email: 'renamed.invitee@example.com' });

      const locked = await call(base, admin.cookie, 'PATCH', `/api/staff/${active.id}`, {
        email: 'someone.else@example.com',
      });
      expect(locked.status).toBe(409);
      expect(locked.body).toMatchObject({ code: 'EMAIL_LOCKED' });

      const taken = await call(base, admin.cookie, 'PATCH', `/api/staff/${invited.id}`, {
        email: active.email,
      });
      expect(taken.body).toMatchObject({ code: 'EMAIL_TAKEN' });
    });

    it('ends a link sent to the old address when an invited email changes', async () => {
      const admin = await adminCookie();
      const invited = await addPerson({ signedIn: false });
      const old = 'OldInviteLink0000000000A';
      await owner.pool.query(
        `INSERT INTO verifications (identifier, value, expires_at)
         VALUES ($1, $2, now() + interval '7 days')`,
        [`reset-password:${old}`, invited.id],
      );

      const changed = await call(base, admin.cookie, 'PATCH', `/api/staff/${invited.id}`, {
        email: `moved${(counter += 1)}@example.com`,
      });
      expect(changed.status).toBe(200);

      const redeem = await call(base, undefined, 'POST', '/api/auth/reset-password', {
        token: old,
        newPassword: NEW_PASSWORD,
      });
      expect(redeem.status).toBe(400);
      expect(redeem.body).toMatchObject({ code: 'INVALID_TOKEN' });
      // With mail off no new link is made.
      const left = await owner.pool.query(`SELECT 1 FROM verifications WHERE value = $1`, [
        invited.id,
      ]);
      expect(left.rows).toHaveLength(0);
    });

    it('stops a password set through the old link once an invited email changes', async () => {
      const admin = await adminCookie();
      const invited = await addPerson({ signedIn: false });
      const link = 'RedeemedInviteLink00000A';
      await owner.pool.query(
        `INSERT INTO verifications (identifier, value, expires_at)
         VALUES ($1, $2, now() + interval '7 days')`,
        [`reset-password:${link}`, invited.id],
      );
      // Whoever holds the old address follows the link and sets a password of their own.
      const redeemed = await call(base, undefined, 'POST', '/api/auth/reset-password', {
        token: link,
        newPassword: NEW_PASSWORD,
      });
      expect(redeemed.status).toBe(200);
      await owner.pool.query(
        `INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [invited.id, `stray-session-${counter}`],
      );

      const moved = `moved${(counter += 1)}@example.com`;
      const changed = await call(base, admin.cookie, 'PATCH', `/api/staff/${invited.id}`, {
        email: moved,
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ email: moved, status: 'invited' });

      expect((await login(base, moved, NEW_PASSWORD)).status).toBe(401);
      expect((await login(base, invited.email, NEW_PASSWORD)).status).toBe(401);
      const { rows } = await owner.pool.query<{ must: boolean; sessions: number }>(
        `SELECT must_change_password AS must,
                (SELECT count(*)::int FROM sessions WHERE user_id = $1::uuid) AS sessions
           FROM users WHERE id = $1::uuid`,
        [invited.id],
      );
      expect(rows[0]).toEqual({ must: true, sessions: 0 });

      // With mail off the update shows no password: Reset password issues the temporary one.
      const reset = await call(
        base,
        admin.cookie,
        'POST',
        `/api/staff/${invited.id}/reset-password`,
      );
      expect(reset.status).toBe(200);
      const temporary = (reset.body.setup as Record<string, string>).temporaryPassword as string;
      expect((await login(base, moved, temporary)).status).toBe(200);
    });

    it('changes only the details when an edit repeats the same email', async () => {
      const admin = await adminCookie();
      const invited = await addPerson({ signedIn: false });

      const edited = await call(base, admin.cookie, 'PATCH', `/api/staff/${invited.id}`, {
        email: invited.email.toUpperCase(),
        name: 'Same Email',
      });
      expect(edited.status).toBe(200);
      expect((await login(base, invited.email)).status).toBe(200);
    });

    it('refuses to demote the last active admin, and counts an invited admin as active', async () => {
      // A database of its own would be cleaner; here every other admin is disabled first.
      await owner.pool.query(
        `UPDATE users SET banned = true WHERE id IN (SELECT user_id FROM hat_assignments WHERE hat = 'manager')`,
      );
      const sole = await adminCookieUnbanned();

      const refused = await call(base, sole.cookie, 'PATCH', `/api/staff/${sole.id}`, {
        role: 'staff',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'LAST_ADMIN' });

      await addPerson({ role: 'admin', signedIn: false });
      const allowed = await call(base, sole.cookie, 'PATCH', `/api/staff/${sole.id}`, {
        role: 'staff',
      });
      expect(allowed.status).toBe(200);
      await giveHats(owner.pool, sole.id, 'admin');
    });
  });

  /** An admin made after every other admin was disabled, so it is the only active one. */
  async function adminCookieUnbanned() {
    const admin = await addPerson({ role: 'admin' });
    return { ...admin, cookie: cookieOf(await login(base, admin.email)) };
  }

  describe('disabling and enabling (AC-16, AC-17)', () => {
    it('disables in one step: no sessions, no live links, rows kept, sign in refused', async () => {
      await owner.pool.query(
        `UPDATE users SET banned = false WHERE id IN (SELECT user_id FROM hat_assignments WHERE hat = 'manager')`,
      );
      const admin = await adminCookie();
      const person = await addPerson();
      const cookie = cookieOf(await login(base, person.email));
      await owner.pool.query(
        `INSERT INTO verifications (identifier, value, expires_at)
         VALUES ('reset-password:leftover', $1, now() + interval '1 hour')`,
        [person.id],
      );

      const disabled = await call(base, admin.cookie, 'POST', `/api/staff/${person.id}/disable`, {
        reason: 'Left the company',
      });

      expect(disabled.body).toMatchObject({
        status: 'disabled',
        disableReason: 'Left the company',
      });
      const old = await call(base, cookie, 'GET', '/api/me');
      expect(old.status).toBe(401);
      expect(old.body).toMatchObject({ code: 'SESSION_EXPIRED' });
      const leftovers = await owner.pool.query(
        `SELECT (SELECT count(*) FROM sessions WHERE user_id = $1::uuid) AS sessions,
                (SELECT count(*) FROM verifications WHERE value = $2) AS tokens,
                (SELECT count(*) FROM users WHERE id = $1::uuid) AS users`,
        [person.id, person.id],
      );
      expect(leftovers.rows[0]).toEqual({ sessions: '0', tokens: '0', users: '1' });
      const refused = await login(base, person.email);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'BANNED_USER' });

      const enabled = await call(base, admin.cookie, 'POST', `/api/staff/${person.id}/enable`);
      expect(enabled.body).toMatchObject({ status: 'active', disableReason: null });
      expect((await login(base, person.email)).status).toBe(200);
    });

    it('stops an admin disabling themselves', async () => {
      const admin = await adminCookie();

      const reply = await call(base, admin.cookie, 'POST', `/api/staff/${admin.id}/disable`, {});

      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'SELF_DISABLE' });
    });

    it('stops an admin resetting or signing out their own account from the staff page', async () => {
      const admin = await adminCookie();

      for (const action of ['reset-password', 'reset-two-factor', 'revoke-sessions']) {
        const reply = await call(base, admin.cookie, 'POST', `/api/staff/${admin.id}/${action}`);
        expect(reply.status, action).toBe(409);
        expect(reply.body, action).toMatchObject({ code: 'SELF_ACTION' });
      }
      // Nothing changed: the session still works and the password still signs in.
      expect((await call(base, admin.cookie, 'GET', '/api/me')).body).toMatchObject({
        mustChangePassword: false,
      });
      expect((await login(base, admin.email)).status).toBe(200);
    });

    it('leaves one admin when two disable each other at the same moment', async () => {
      const a = await adminCookie();
      const b = await adminCookie();
      await owner.pool.query(
        `UPDATE users SET banned = true
          WHERE id IN (SELECT user_id FROM hat_assignments WHERE hat = 'manager') AND id NOT IN ($1::uuid, $2::uuid)`,
        [a.id, b.id],
      );

      const [first, second] = await Promise.all([
        call(base, a.cookie, 'POST', `/api/staff/${b.id}/disable`, {}),
        call(base, b.cookie, 'POST', `/api/staff/${a.id}/disable`, {}),
      ]);

      // One wins. The other is turned away by the last admin rule, or by the guard if the winner
      // had already ended its session: either way exactly one admin is left.
      const statuses = [first.status, second.status].sort();
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]);
      const left = await owner.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM users WHERE id IN (SELECT user_id FROM hat_assignments WHERE hat = 'manager') AND NOT banned`,
      );
      expect(Number(left.rows[0]?.n)).toBe(1);
      await owner.pool.query(
        `UPDATE users SET banned = false WHERE id IN (SELECT user_id FROM hat_assignments WHERE hat = 'manager')`,
      );
    });
  });

  describe('admin password reset and session revoke (AC-18)', () => {
    it('replaces the password at once, ends sessions, clears the lock, and forces a change', async () => {
      const admin = await adminCookie();
      const person = await addPerson();
      const cookie = cookieOf(await login(base, person.email));
      for (let i = 0; i < 5; i += 1) await login(base, person.email, 'Wrong-Password-1');

      const reset = await call(
        base,
        admin.cookie,
        'POST',
        `/api/staff/${person.id}/reset-password`,
      );

      expect(reset.status).toBe(200);
      const temporary = setup(reset).temporaryPassword as string;
      expect(temporary).toMatch(/^.{16}$/);
      expect((await call(base, cookie, 'GET', '/api/me')).status).toBe(401);
      expect((await login(base, person.email, PASSWORD)).status).toBe(401);
      const signedIn = await login(base, person.email, temporary);
      expect(signedIn.status).toBe(200);
      expect((await call(base, cookieOf(signedIn), 'GET', '/api/me')).body).toMatchObject({
        mustChangePassword: true,
      });
    });

    it('revokes every session without touching the password', async () => {
      const admin = await adminCookie();
      const person = await addPerson();
      const one = cookieOf(await login(base, person.email));
      const two = cookieOf(await login(base, person.email));

      const reply = await call(
        base,
        admin.cookie,
        'POST',
        `/api/staff/${person.id}/revoke-sessions`,
      );

      expect(reply.body).toEqual({ count: 2 });
      expect((await call(base, one, 'GET', '/api/me')).status).toBe(401);
      expect((await call(base, two, 'GET', '/api/me')).status).toBe(401);
      expect((await login(base, person.email)).status).toBe(200);
    });

    it('answers 404 for an unknown person on every action', async () => {
      const admin = await adminCookie();
      const actions = [
        'enable',
        'reset-password',
        'reset-two-factor',
        'revoke-sessions',
        'disable',
      ];
      for (const id of ['0190c0de-0000-7000-8000-00000000dead', 'not-a-uuid']) {
        for (const action of actions) {
          const reply = await call(base, admin.cookie, 'POST', `/api/staff/${id}/${action}`, {});
          expect(reply.status, `${action} ${id}`).toBe(404);
          expect(reply.body, `${action} ${id}`).toMatchObject({ code: 'NOT_FOUND' });
        }
      }
    });

    it('ends pending two factor sign ins on a password or two factor reset, for that person only', async () => {
      const admin = await adminCookie();
      const person = await addPerson();
      const bystander = await addPerson();
      const challenge = (identifier: string, userId: string) =>
        owner.pool.query(
          `INSERT INTO verifications (identifier, value, expires_at)
           VALUES ($1, $2, now() + interval '10 minutes'), ($3, '0', now() + interval '10 minutes')`,
          [identifier, userId, `2fa-attempts-${identifier}`],
        );
      const left = async (identifier: string) =>
        (
          await owner.pool.query(`SELECT 1 FROM verifications WHERE identifier LIKE $1`, [
            `%${identifier}`,
          ])
        ).rows.length;

      const other = `2fa-bystander${bystander.id}`;
      await challenge(other, bystander.id);
      for (const action of ['reset-password', 'reset-two-factor']) {
        const pending = `2fa-${action}-${person.id}`;
        await challenge(pending, person.id);
        const reply = await call(base, admin.cookie, 'POST', `/api/staff/${person.id}/${action}`);
        expect(reply.status, action).toBe(200);
        expect(await left(pending), action).toBe(0);
      }
      expect(await left(other)).toBe(2);
    });

    it('refuses to re-invite with no mail, or someone who has already signed in', async () => {
      const admin = await adminCookie();
      const active = await addPerson();
      const invited = await addPerson({ signedIn: false });

      const notInvited = await call(
        base,
        admin.cookie,
        'POST',
        `/api/staff/${active.id}/resend-invite`,
      );
      expect(notInvited.status).toBe(409);
      expect(notInvited.body).toMatchObject({ code: 'NOT_INVITED' });
      const noMail = await call(
        base,
        admin.cookie,
        'POST',
        `/api/staff/${invited.id}/resend-invite`,
      );
      expect(noMail.status).toBe(409);
      expect(noMail.body).toMatchObject({ code: 'MAIL_DISABLED' });
    });
  });

  describe('with mail on (AC-12, AC-13)', () => {
    const mailTo = (email: string, nth = 0): Promise<CapturedMail> =>
      eventually(() => smtp?.messages.filter((m) => m.to === email)[nth], {
        what: `an email to ${email}`,
      });
    const tokenOf = (mail: CapturedMail) =>
      /\/api\/auth\/reset-password\/([A-Za-z0-9]+)\?callbackURL=/.exec(mail.text)?.[1] as string;

    it('invites by email with a 7 day link that sets the first password', async () => {
      const admin = await adminCookie(mailBase);
      const made = await create(admin.cookie, { name: 'Invitee', language: 'ar' }, mailBase);
      const email = staff(made).email as string;

      expect(made.status).toBe(201);
      expect(setup(made)).toEqual({ mode: 'email' });
      const mail = await mailTo(email);
      expect(mail.html).toContain('dir="rtl"');
      const token = tokenOf(mail);
      const life = await owner.pool.query<{ days: number }>(
        `SELECT extract(epoch FROM expires_at - now()) / 86400 AS days FROM verifications WHERE identifier = $1`,
        [`reset-password:${token}`],
      );
      expect(Number(life.rows[0]?.days)).toBeGreaterThan(6.9);
      expect(Number(life.rows[0]?.days)).toBeLessThanOrEqual(7);

      // The invite goes through Better Auth's own redeem path, with invite wording for the page.
      const check = await fetch(
        `${mailBase}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${mailBase}/reset-password?invite=1`)}`,
        { redirect: 'manual' },
      );
      expect(check.headers.get('location')).toBe(
        `${mailBase}/reset-password?invite=1&token=${token}`,
      );
      const done = await call(mailBase, undefined, 'POST', '/api/auth/reset-password', {
        token,
        newPassword: NEW_PASSWORD,
      });
      expect(done.status).toBe(200);
      const verified = await owner.pool.query<{
        email_verified: boolean;
        must_change_password: boolean;
      }>(`SELECT email_verified, must_change_password FROM users WHERE id = $1::uuid`, [
        staff(made).id,
      ]);
      expect(verified.rows[0]).toEqual({ email_verified: true, must_change_password: false });
      const session = await login(mailBase, email, NEW_PASSWORD);
      expect(session.status).toBe(200);
      expect((await call(mailBase, cookieOf(session), 'GET', '/api/locations')).status).toBe(200);
    });

    it('re-invites with a new link that replaces the old one', async () => {
      const admin = await adminCookie(mailBase);
      const made = await create(admin.cookie, {}, mailBase);
      const email = staff(made).email as string;
      const first = tokenOf(await mailTo(email));

      const again = await call(
        mailBase,
        admin.cookie,
        'POST',
        `/api/staff/${staff(made).id as string}/resend-invite`,
      );
      expect(again.status).toBe(200);
      const second = tokenOf(await mailTo(email, 1));

      expect(second).not.toBe(first);
      const reuse = await call(mailBase, undefined, 'POST', '/api/auth/reset-password', {
        token: first,
        newPassword: NEW_PASSWORD,
      });
      expect(reuse.status).toBe(400);
      expect(reuse.body).toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('sends a fresh invite to the new address when an invited email changes, ending the old link', async () => {
      const admin = await adminCookie(mailBase);
      const made = await create(admin.cookie, {}, mailBase);
      const id = staff(made).id as string;
      const first = tokenOf(await mailTo(staff(made).email as string));
      const moved = `moved${(counter += 1)}@example.com`;

      const changed = await call(mailBase, admin.cookie, 'PATCH', `/api/staff/${id}`, {
        email: moved,
      });
      expect(changed.status).toBe(200);

      const reuse = await call(mailBase, undefined, 'POST', '/api/auth/reset-password', {
        token: first,
        newPassword: NEW_PASSWORD,
      });
      expect(reuse.status).toBe(400);
      expect(reuse.body).toMatchObject({ code: 'INVALID_TOKEN' });
      const second = tokenOf(await mailTo(moved));
      expect(second).not.toBe(first);
      const done = await call(mailBase, undefined, 'POST', '/api/auth/reset-password', {
        token: second,
        newPassword: NEW_PASSWORD,
      });
      expect(done.status).toBe(200);
      expect((await login(mailBase, moved, NEW_PASSWORD)).status).toBe(200);
    });

    it('sends a reset link for an admin reset, and the old password stops working at once', async () => {
      const admin = await adminCookie(mailBase);
      const person = await addPerson();

      const reset = await call(
        mailBase,
        admin.cookie,
        'POST',
        `/api/staff/${person.id}/reset-password`,
      );

      expect(reset.body).toEqual({ setup: { mode: 'email' } });
      expect((await login(mailBase, person.email, PASSWORD)).status).toBe(401);
      const mail = await mailTo(person.email);
      expect(mail.subject).toBe('Reset your Acme Home password');
      const life = await owner.pool.query<{ minutes: number }>(
        `SELECT extract(epoch FROM expires_at - now()) / 60 AS minutes FROM verifications WHERE identifier = $1`,
        [`reset-password:${tokenOf(mail)}`],
      );
      expect(Number(life.rows[0]?.minutes)).toBeLessThanOrEqual(60);
    });

    it('sends nothing to a disabled person and leaves them no live link', async () => {
      const admin = await adminCookie(mailBase);
      const made = await create(admin.cookie, {}, mailBase);
      const id = staff(made).id as string;
      const email = staff(made).email as string;
      await mailTo(email);

      await call(mailBase, admin.cookie, 'POST', `/api/staff/${id}/disable`, {});

      const tokens = await owner.pool.query(`SELECT 1 FROM verifications WHERE value = $1`, [id]);
      expect(tokens.rows).toHaveLength(0);
    });
  });

  describe('audit lines (AC-23)', () => {
    it('logs each admin action with actor, target, address and agent, and never a password', async () => {
      const admin = await adminCookie();
      const made = await create(admin.cookie, {});
      const id = staff(made).id as string;
      await call(base, admin.cookie, 'PATCH', `/api/staff/${id}`, { name: 'Changed' });
      await call(base, admin.cookie, 'PATCH', `/api/staff/${id}`, { role: 'admin' });
      await call(base, admin.cookie, 'POST', `/api/staff/${id}/reset-password`);
      await call(base, admin.cookie, 'POST', `/api/staff/${id}/revoke-sessions`);
      await call(base, admin.cookie, 'POST', `/api/staff/${id}/disable`, { reason: 'Test' });
      await call(base, admin.cookie, 'POST', `/api/staff/${id}/enable`);

      const log = (api as RunningProcess).output();
      const lines = log.split('\n').filter((l) => l.includes(`"targetId":"${id}"`));
      for (const event of [
        'StaffCreated',
        'StaffUpdated',
        'StaffRoleChanged',
        'StaffPasswordReset',
        'StaffSessionsRevoked',
        'StaffDisabled',
        'StaffEnabled',
      ]) {
        const line = lines.find((l) => l.includes(`"event":"${event}"`));
        expect(line, event).toContain(`"actorId":"${admin.id}"`);
        expect(line, event).toContain('"ip":');
      }
      expect(lines.find((l) => l.includes('"event":"StaffDisabled"'))).toContain('"reason":"Test"');
      expect(log).not.toContain(setup(made).temporaryPassword as string);
    });
  });
});
