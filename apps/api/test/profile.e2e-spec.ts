import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  start,
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const PASSWORD = 'Correct-Horse-1';
const NEW_PASSWORD = 'Brand-New-Pass-9';

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

// Spec 0005, slice 5: a person edits their own profile and password.
describe('own profile and password', { timeout: 180_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let hash: string;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 3 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', {
      DATABASE_URL: appUrl.toString(),
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      PORT: String(port),
      PUBLIC_URL: base,
    });
    await waitForHttp(`${base}/api/health`, api);
    hash = await hashPassword(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  async function addPerson(
    options: { role?: 'admin' | 'staff'; mustChange?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `profile${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, role, staff_code, must_change_password, last_sign_in_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [
        `Person ${counter}`,
        email,
        options.role ?? 'staff',
        `SC${counter}`,
        options.mustChange ?? false,
      ],
    );
    const id = rows[0]?.id as string;
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    return { id, email };
  }

  async function call(
    cookie: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> {
    counter += 1;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-forwarded-for': `198.18.${Math.floor(counter / 250)}.${(counter % 250) + 1}`,
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

  async function signIn(email: string, password = PASSWORD): Promise<string> {
    const reply = await call(undefined, 'POST', '/api/auth/sign-in/email', { email, password });
    const cookie = reply.headers.getSetCookie().find((c) => c.includes('session_token'));
    if (!cookie) throw new Error(`sign in failed with ${reply.status}`);
    return cookie.split(';')[0] as string;
  }

  describe('PATCH /api/me (AC-19)', () => {
    it('changes the name, phone and language, and the next request sees them', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);

      const changed = await call(cookie, 'PATCH', '/api/me', {
        name: '  Samira Ali ',
        phone: '+20 100 123 4567',
        language: 'ar',
      });

      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({
        name: 'Samira Ali',
        phone: '+20 100 123 4567',
        language: 'ar',
        email: person.email,
        role: 'staff',
      });
      expect((await call(cookie, 'GET', '/api/me')).body).toMatchObject({
        name: 'Samira Ali',
        phone: '+20 100 123 4567',
        language: 'ar',
      });
    });

    it('clears a phone or language with empty text, and leaves what was not sent alone', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);
      await call(cookie, 'PATCH', '/api/me', { phone: '+20 100 123 4567', language: 'ar' });

      const cleared = await call(cookie, 'PATCH', '/api/me', { phone: '', language: '' });

      expect(cleared.body).toMatchObject({ phone: null, language: null });
      const { rows } = await owner.pool.query<{ phone: string | null; language: string | null }>(
        `SELECT phone, language FROM users WHERE id = $1::uuid`,
        [person.id],
      );
      expect(rows[0]).toEqual({ phone: null, language: null });
      const nameOnly = await call(cookie, 'PATCH', '/api/me', { name: 'Only Name' });
      expect(nameOnly.body).toMatchObject({ name: 'Only Name', phone: null });
    });

    it('refuses a language the install has not enabled, and bad fields, with stable codes', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);

      const language = await call(cookie, 'PATCH', '/api/me', { language: 'xx' });
      expect(language.status).toBe(422);
      expect(language.body).toMatchObject({ code: 'INVALID_LANGUAGE' });

      for (const bad of [{ name: '   ' }, { phone: '12' }]) {
        const reply = await call(cookie, 'PATCH', '/api/me', bad);
        expect(reply.status, JSON.stringify(bad)).toBe(422);
        expect(reply.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });

    it('cannot change its own email, role or staff code, or become an admin', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);

      for (const field of [
        { email: 'someone.else@example.com' },
        { role: 'admin' },
        { staffCode: 'HACK' },
        { banned: false },
        { mustChangePassword: false },
      ]) {
        const reply = await call(cookie, 'PATCH', '/api/me', { name: 'Sneaky', ...field });
        expect(reply.status, JSON.stringify(field)).toBe(422);
        expect(reply.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      const { rows } = await owner.pool.query<{
        name: string;
        email: string;
        role: string;
        staff_code: string;
      }>(`SELECT name, email, role, staff_code FROM users WHERE id = $1::uuid`, [person.id]);
      expect(rows[0]).toMatchObject({ email: person.email, role: 'staff' });
      expect(rows[0]?.name).not.toBe('Sneaky');
      expect(rows[0]?.staff_code).toMatch(/^SC/);
    });

    it('only ever changes the signed in person, whatever the body names', async () => {
      const me = await addPerson();
      const other = await addPerson();
      const cookie = await signIn(me.email);

      await call(cookie, 'PATCH', '/api/me', { name: 'Mine Only' });

      const { rows } = await owner.pool.query<{ name: string }>(
        `SELECT name FROM users WHERE id = $1::uuid`,
        [other.id],
      );
      expect(rows[0]?.name).not.toBe('Mine Only');
    });

    it('needs a session, and waits for a forced password change', async () => {
      expect((await call(undefined, 'PATCH', '/api/me', { name: 'x' })).status).toBe(401);

      const forced = await addPerson({ mustChange: true });
      const cookie = await signIn(forced.email);
      const reply = await call(cookie, 'PATCH', '/api/me', { name: 'Not Yet' });
      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    });

    it('shows an admin the new name in the staff list', async () => {
      const admin = await addPerson({ role: 'admin' });
      const person = await addPerson();
      await call(await signIn(person.email), 'PATCH', '/api/me', { name: 'Zora Visible' });

      const list = await call(await signIn(admin.email), 'GET', '/api/staff?q=Zora');

      expect((list.body.rows as Array<{ name: string }>).map((row) => row.name)).toContain(
        'Zora Visible',
      );
    });

    it('signs in on another device with the saved language available from GET /api/me', async () => {
      const person = await addPerson();
      await call(await signIn(person.email), 'PATCH', '/api/me', { language: 'ar' });

      const second = await signIn(person.email);

      expect((await call(second, 'GET', '/api/me')).body).toMatchObject({ language: 'ar' });
    });
  });

  describe('changing your own password (AC-8, AC-19)', () => {
    it('needs the current password, and ends the other sessions', async () => {
      const person = await addPerson();
      const here = await signIn(person.email);
      const elsewhere = await signIn(person.email);

      const wrong = await call(here, 'POST', '/api/auth/change-password', {
        currentPassword: 'Not-The-Password-1',
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ code: 'INVALID_PASSWORD' });

      const weak = await call(here, 'POST', '/api/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: 'alllowercase',
        revokeOtherSessions: true,
      });
      expect(weak.status).toBe(422);
      expect(weak.body).toMatchObject({ code: 'WEAK_PASSWORD' });

      const changed = await call(here, 'POST', '/api/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      });
      expect(changed.status).toBe(200);
      expect((await call(elsewhere, 'GET', '/api/me')).status).toBe(401);
      expect((await signIn(person.email, NEW_PASSWORD)).length).toBeGreaterThan(0);
    });
  });
});
