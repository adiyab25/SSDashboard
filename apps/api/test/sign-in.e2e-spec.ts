import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MeResponse } from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  requireBuild,
  run,
  start,
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const PASSWORD_LINE = /Temporary password .*: (\S+)$/m;

// Spec 0005, slice 1: create-admin, sign in, GET /api/me, the guard, sign out.
describe('staff sign in (thin thread)', { timeout: 90_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let env: Record<string, string>;
  let adminPassword: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    };
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...headers },
      body: JSON.stringify(body),
    });

  /** The `name=value` part of the session cookie in a sign in answer. */
  const sessionCookie = (response: Response): string => {
    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    if (!cookie) throw new Error('no session cookie in the answer');
    return cookie.split(';')[0] as string;
  };

  /** Runs the built `create-admin` entry point with the given arguments, like the run book does. */
  function runWithArgs(args: string[]) {
    const result = spawnSync(process.execPath, [requireBuild('create-admin.js'), ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        NODE_ENV: 'production',
        ...env,
      },
      encoding: 'utf8',
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  describe('create-admin (AC-21)', () => {
    it('refuses bad input and prints the usage', async () => {
      const result = await run('create-admin.js', env);
      expect(result.code).toBe(1);
      expect(result.output).toContain('Usage');
    });

    it('creates the first admin, prints a temporary password once, and sets the must change flag', async () => {
      const created = runWithArgs(['--email', 'Owner@Example.com', '--name', ' Owner One ']);
      expect(created.code).toBe(0);
      const match = PASSWORD_LINE.exec(created.output);
      expect(match).not.toBeNull();
      adminPassword = match?.[1] as string;
      expect(adminPassword).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{16}$/);

      const { rows } = await owner.pool.query<{
        email: string;
        name: string;
        role: string;
        must_change_password: boolean;
        account_id: string;
        id: string;
        password: string;
      }>(
        `SELECT u.id, u.email, u.name, u.role, u.must_change_password, a.account_id, a.password
           FROM users u JOIN accounts a ON a.user_id = u.id AND a.provider_id = 'credential'`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        email: 'owner@example.com',
        name: 'Owner One',
        role: 'admin',
        must_change_password: true,
      });
      expect(row?.account_id).toBe(row?.id);
      // Only a hash is stored.
      expect(row?.password).not.toContain(adminPassword);
    });

    it('refuses a second admin, and an email that already has an account', async () => {
      const again = runWithArgs(['--email', 'other@example.com', '--name', 'Other']);
      expect(again.code).toBe(1);
      expect(again.output).toContain('active admin already exists');

      await owner.pool.query(`UPDATE users SET banned = true`);
      const taken = runWithArgs(['--email', 'OWNER@example.com', '--name', 'Owner']);
      expect(taken.code).toBe(1);
      expect(taken.output).toContain('already belongs to an account');
      await owner.pool.query(`UPDATE users SET banned = false`);
    });
  });

  describe('the api', () => {
    beforeAll(async () => {
      api = start('main.js', env);
      await waitForHttp(`${base}/api/health`, api);
    });

    it('keeps config and health public and guards everything else (AC-7)', async () => {
      expect((await fetch(`${base}/api/config`)).status).toBe(200);
      expect((await fetch(`${base}/api/health`)).status).toBe(200);

      for (const path of ['/api/me', '/api/locations']) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
    });

    it('answers a wrong password and an unknown email the same way (AC-2)', async () => {
      const wrong = await post('/api/auth/sign-in/email', {
        email: 'owner@example.com',
        password: 'Wrong-Password-1',
      });
      const unknown = await post('/api/auth/sign-in/email', {
        email: 'nobody@example.com',
        password: 'Wrong-Password-1',
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(await wrong.json()).toEqual(await unknown.json());
    });

    it('signs in with the email in any letter case, sets a safe cookie, and records the time (AC-1)', async () => {
      const response = await post('/api/auth/sign-in/email', {
        email: 'OWNER@Example.COM',
        password: adminPassword,
      });
      expect(response.status).toBe(200);

      const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/Domain=/i);
      // PUBLIC_URL is http here, so the cookie is not marked Secure.
      expect(cookie).not.toMatch(/Secure/i);

      const { rows } = await owner.pool.query<{ last_sign_in_at: Date | null }>(
        `SELECT last_sign_in_at FROM users`,
      );
      expect(rows[0]?.last_sign_in_at).toBeInstanceOf(Date);
    });

    it('returns the signed in person on GET /api/me (AC-1, AC-25)', async () => {
      const signIn = await post('/api/auth/sign-in/email', {
        email: 'owner@example.com',
        password: adminPassword,
      });
      const me = await fetch(`${base}/api/me`, { headers: { cookie: sessionCookie(signIn) } });
      expect(me.status).toBe(200);
      expect(MeResponse.parse(await me.json())).toMatchObject({
        name: 'Owner One',
        email: 'owner@example.com',
        role: 'admin',
        phone: null,
        staffCode: null,
        language: null,
        twoFactorEnabled: false,
        mustChangePassword: true,
      });
      const locations = await fetch(`${base}/api/locations`, {
        headers: { cookie: sessionCookie(signIn) },
      });
      // The first admin still has a temporary password, so every other route waits (AC-14).
      expect(locations.status).toBe(403);
      expect(await locations.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    });

    it('signs out only that session, and the old cookie then fails (AC-6)', async () => {
      const first = sessionCookie(
        await post('/api/auth/sign-in/email', {
          email: 'owner@example.com',
          password: adminPassword,
        }),
      );
      const second = sessionCookie(
        await post('/api/auth/sign-in/email', {
          email: 'owner@example.com',
          password: adminPassword,
        }),
      );

      const out = await post('/api/auth/sign-out', {}, { cookie: first });
      expect(out.status).toBe(200);

      const gone = await fetch(`${base}/api/me`, { headers: { cookie: first } });
      expect(gone.status).toBe(401);
      expect(await gone.json()).toMatchObject({ code: 'SESSION_EXPIRED' });

      const kept = await fetch(`${base}/api/me`, { headers: { cookie: second } });
      expect(kept.status).toBe(200);
    });

    it('closes every Better Auth route that is not on the allowlist (AC-7, AC-15)', async () => {
      const closed = [
        ['POST', '/api/auth/sign-up/email'],
        ['POST', '/api/auth/admin/create-user'],
        ['GET', '/api/auth/admin/list-users'],
        ['POST', '/api/auth/update-user'],
        ['POST', '/api/auth/change-email'],
        ['GET', '/api/auth/get-session'],
        ['GET', '/api/auth/list-sessions'],
      ] as const;
      for (const [method, path] of closed) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', origin: base },
          ...(method === 'POST' && { body: '{}' }),
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    });

    it('treats a disabled account as signed out on its next request', async () => {
      const cookie = sessionCookie(
        await post('/api/auth/sign-in/email', {
          email: 'owner@example.com',
          password: adminPassword,
        }),
      );
      await owner.pool.query(`UPDATE users SET banned = true`);
      try {
        const response = await fetch(`${base}/api/me`, { headers: { cookie } });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
      } finally {
        await owner.pool.query(`UPDATE users SET banned = false`);
      }
    });
  });
});
