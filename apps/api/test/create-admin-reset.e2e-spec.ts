import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  giveHats,
  requireBuild,
  start,
  stop,
  waitForHttp,
  TEST_CONNECTOR_SECRET_KEY,
  type RunningProcess,
} from './support.js';

const PASSWORD_LINE = /Temporary password .*: (\S+)$/m;
const EMAIL = 'owner@example.com';

// Spec 0005, slice 7, AC-21: `create-admin --reset-password` as break glass for a locked out sole admin.
describe('create-admin --reset-password', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let env: Record<string, string>;

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
    api = start('main.js', env);
    await waitForHttp(`${base}/api/health`, api);
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  function createAdmin(args: string[]) {
    const result = spawnSync(process.execPath, [requireBuild('create-admin.js'), ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        NODE_ENV: 'production',
        CONNECTOR_SECRET_KEY: TEST_CONNECTOR_SECRET_KEY,
        ...env,
      },
      encoding: 'utf8',
    });
    return {
      code: result.status,
      output: `${result.stdout}${result.stderr}`,
      stderr: result.stderr,
    };
  }

  const signIn = (password: string) =>
    fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: EMAIL, password }),
    });

  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((c) => c.includes('session_token'))
      ?.split(';')[0] ?? '';

  it('restores access for a locked out sole admin', async () => {
    const created = createAdmin(['--email', EMAIL, '--name', 'Owner']);
    expect(created.code).toBe(0);
    const oldPassword = PASSWORD_LINE.exec(created.output)?.[1] as string;
    const first = await signIn(oldPassword);
    expect(first.status).toBe(200);
    const oldCookie = cookieOf(first);
    expect(oldCookie).not.toBe('');
    // The person changed their password earlier, so the flag is off until the reset sets it.
    await owner.pool.query(`UPDATE users SET must_change_password = false`);
    // Pending two factor challenges: the admin's (plus its attempts row) and another user's.
    const other = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES ('Other', 'other@example.com') RETURNING id`,
    );
    await giveHats(owner.pool, other.rows[0]?.id as string, {
      hats: ['support', 'operations', 'warehouse'],
    });
    const adminId = (
      await owner.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [EMAIL])
    ).rows[0]?.id as string;
    const challenge = (identifier: string, value: string) =>
      owner.pool.query(
        `INSERT INTO verifications (identifier, value, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`,
        [identifier, value],
      );
    await challenge('2fa-adminchallenge', adminId);
    await challenge('2fa-attempts-2fa-adminchallenge', '0');
    await challenge('2fa-otherchallenge', other.rows[0]?.id as string);
    await challenge('2fa-attempts-2fa-otherchallenge', '0');

    for (let i = 0; i < 5; i += 1) await signIn('Wrong-Password-1');
    const locked = await owner.pool.query(
      `SELECT 1 FROM sign_in_attempts WHERE email_key = $1 AND locked_until > now()`,
      [EMAIL],
    );
    expect(locked.rows.length).toBeGreaterThan(0);
    // Locked: even the right password is refused.
    expect((await signIn(oldPassword)).status).not.toBe(200);

    const reset = createAdmin(['--reset-password', '--email', ' Owner@Example.com ']);
    expect(reset.code).toBe(0);
    const challenges = await owner.pool.query<{ identifier: string }>(
      `SELECT identifier FROM verifications WHERE identifier LIKE '2fa-%' ORDER BY identifier`,
    );
    expect(challenges.rows.map((r) => r.identifier)).toEqual([
      '2fa-attempts-2fa-otherchallenge',
      '2fa-otherchallenge',
    ]);
    const newPassword = PASSWORD_LINE.exec(reset.output)?.[1] as string;
    expect(newPassword).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{16}$/);
    expect(newPassword).not.toBe(oldPassword);

    // One structured audit line on stderr: no password, no email text.
    const idRow = await owner.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      EMAIL,
    ]);
    const auditLines = reset.stderr
      .split(String.fromCharCode(10))
      .filter((l) => l.includes('auth.admin_break_glass_reset'));
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0] as string)).toMatchObject({
      event: 'auth.admin_break_glass_reset',
      targetId: idRow.rows[0]?.id,
      actor: 'cli',
    });
    expect(reset.stderr).not.toContain(newPassword);
    expect(reset.stderr.toLowerCase()).not.toContain('example.com');

    const state = await owner.pool.query<{
      must_change_password: boolean;
      sessions: string;
      attempts: string;
      password: string;
      account_id: string;
      id: string;
    }>(
      `SELECT u.id, u.must_change_password, a.account_id, a.password,
              (SELECT count(*) FROM sessions WHERE user_id = u.id) AS sessions,
              (SELECT count(*) FROM sign_in_attempts WHERE email_key = $1) AS attempts
         FROM users u JOIN accounts a ON a.user_id = u.id AND a.provider_id = 'credential'`,
      [EMAIL],
    );
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0];
    expect(row?.must_change_password).toBe(true);
    expect(Number(row?.sessions)).toBe(0);
    expect(Number(row?.attempts)).toBe(0);
    expect(row?.account_id).toBe(row?.id);
    expect(row?.password).not.toContain(newPassword);

    // The old session is gone, the old password fails, the new one signs in.
    expect((await fetch(`${base}/api/me`, { headers: { cookie: oldCookie } })).status).toBe(401);
    expect((await signIn(oldPassword)).status).not.toBe(200);
    const fresh = await signIn(newPassword);
    expect(fresh.status).toBe(200);
    const me = await fetch(`${base}/api/me`, { headers: { cookie: cookieOf(fresh) } });
    expect(me.status).toBe(200);
  });

  it('refuses an unknown email, a non-admin, and a disabled admin, and changes nothing', async () => {
    const clerk = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES ('Clerk', 'clerk@example.com') RETURNING id`,
    );
    // Every staff hat but manager: still not an admin for the break glass (spec 0008, AC-14).
    await giveHats(owner.pool, clerk.rows[0]?.id as string, {
      hats: ['support', 'operations', 'warehouse', 'media_buyer'],
      costView: true,
    });
    const before = await owner.pool.query(`SELECT id, password FROM accounts ORDER BY id`);

    const unknown = createAdmin(['--reset-password', '--email', 'nobody@example.com']);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('No account has the email');
    expect(unknown.output).not.toContain('auth.admin_break_glass_reset');

    const staff = createAdmin(['--reset-password', '--email', 'clerk@example.com']);
    expect(staff.code).toBe(1);
    expect(staff.output).toContain('is not an admin');
    expect(staff.output).not.toMatch(PASSWORD_LINE);

    await owner.pool.query(`UPDATE users SET banned = true WHERE email = $1`, [EMAIL]);
    const disabled = createAdmin(['--reset-password', '--email', EMAIL]);
    expect(disabled.code).toBe(1);
    expect(disabled.output).toContain('is disabled');
    await owner.pool.query(`UPDATE users SET banned = false WHERE email = $1`, [EMAIL]);

    const after = await owner.pool.query(`SELECT id, password FROM accounts ORDER BY id`);
    expect(after.rows).toEqual(before.rows);
  });

  it('prints the usage for missing or mixed arguments', () => {
    for (const args of [
      ['--reset-password'],
      ['--reset-password', '--email', EMAIL, '--name', 'Owner'],
      ['--email', EMAIL],
    ]) {
      const result = createAdmin(args);
      expect(result.code).toBe(1);
      expect(result.output).toContain('--reset-password --email <email>');
    }
  });
});
