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
const CLERK = 'clerk@example.com';
const OTHER = 'other@example.com';
const TWO_FACTOR_EVENT = 'auth.admin_break_glass_two_factor_reset';
const PASSWORD_EVENT = 'auth.admin_break_glass_reset';

// Spec 0005, slice 9, AC-26 (with AC-21): `create-admin --reset-two-factor` as break glass for an
// admin who lost the authenticator app and every backup code. The two factor rows are written
// straight into the database with a secret nothing can decrypt, the same state a rotated
// `BETTER_AUTH_SECRET` leaves behind.
describe('create-admin --reset-two-factor', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let env: Record<string, string>;
  let adminId: string;
  let clerkId: string;
  let otherId: string;
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
    api = start('main.js', env);
    await waitForHttp(`${base}/api/health`, api);

    const created = createAdmin(['--email', EMAIL, '--name', 'Owner']);
    expect(created.code).toBe(0);
    adminPassword = PASSWORD_LINE.exec(created.output)?.[1] as string;
    adminId = await idOf(EMAIL);
    clerkId = (
      await owner.pool.query<{ id: string }>(
        `INSERT INTO users (name, email) VALUES ('Clerk', $1) RETURNING id`,
        [CLERK],
      )
    ).rows[0]?.id as string;
    await giveHats(owner.pool, clerkId, { hats: ['support', 'operations', 'warehouse'] });
    otherId = (
      await owner.pool.query<{ id: string }>(
        `INSERT INTO users (name, email) VALUES ('Other', $1) RETURNING id`,
        [OTHER],
      )
    ).rows[0]?.id as string;
    await giveHats(owner.pool, otherId, { hats: ['manager'], costView: true });
    // The admin changed the temporary password long ago; the flag stays off through this reset.
    await owner.pool.query(`UPDATE users SET must_change_password = false WHERE id = $1::uuid`, [
      adminId,
    ]);
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
      stdout: result.stdout,
      stderr: result.stderr,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  const idOf = async (email: string) =>
    (await owner.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]))
      .rows[0]?.id as string;

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

  /** Two factor on, with a secret and backup codes nothing can decrypt. */
  async function enrol(userId: string): Promise<void> {
    await owner.pool.query(
      `INSERT INTO two_factors (user_id, secret, backup_codes, verified)
       VALUES ($1::uuid, 'unreadable-secret', 'unreadable-codes', true)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await owner.pool.query(`UPDATE users SET two_factor_enabled = true WHERE id = $1::uuid`, [
      userId,
    ]);
  }

  /** A pending challenge and its attempts counter, as Better Auth writes them. */
  async function challenge(identifier: string, userId: string): Promise<void> {
    await owner.pool.query(
      `INSERT INTO verifications (identifier, value, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes'), ($3, '0', now() + interval '10 minutes')`,
      [identifier, userId, `2fa-attempts-${identifier}`],
    );
  }

  async function lockOut(email: string): Promise<void> {
    await owner.pool.query(
      `INSERT INTO sign_in_attempts (email_key, scope, failures, window_started_at, locked_until)
       VALUES ($1, '*', 10, now(), now() + interval '15 minutes')
       ON CONFLICT (tenant_id, email_key, scope) DO UPDATE SET locked_until = excluded.locked_until`,
      [email],
    );
  }

  /** Every row the command could touch, to prove a refusal or a failure changed nothing. */
  async function snapshot() {
    const q = async (text: string) => (await owner.pool.query<Record<string, unknown>>(text)).rows;
    return {
      users: await q(
        `SELECT id, role, banned, two_factor_enabled, must_change_password, updated_at
           FROM users ORDER BY id`,
      ),
      hats: await q(`SELECT user_id, hat FROM hat_assignments ORDER BY user_id, hat`),
      grants: await q(`SELECT user_id, permission FROM permission_grants ORDER BY user_id`),
      accounts: await q(`SELECT id, user_id, password, updated_at FROM accounts ORDER BY id`),
      twoFactors: await q(`SELECT id, user_id, secret, backup_codes FROM two_factors ORDER BY id`),
      sessions: await q(`SELECT id, user_id FROM sessions ORDER BY id`),
      verifications: await q(`SELECT identifier, value FROM verifications ORDER BY identifier`),
      attempts: await q(
        `SELECT email_key, scope, failures, locked_until FROM sign_in_attempts ORDER BY 1, 2`,
      ),
    };
  }

  /** The JSON lines on stderr. */
  const auditLines = (stderr: string) =>
    stderr
      .split(String.fromCharCode(10))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('removes the second factor, keeps the password, and the admin signs in with it alone', async () => {
    // A session from before the loss, which the reset must end.
    const before = await signIn(adminPassword);
    expect(before.status).toBe(200);
    const oldCookie = cookieOf(before);
    expect(oldCookie).not.toBe('');

    await enrol(adminId);
    await enrol(otherId);
    // The password step now stops at the code step and leaves a real pending challenge.
    const stuck = await signIn(adminPassword);
    expect(stuck.status).toBe(200);
    expect(await stuck.json()).toMatchObject({ twoFactorRedirect: true });
    const pending = await owner.pool.query<{ identifier: string }>(
      `SELECT identifier FROM verifications WHERE value = $1 AND identifier LIKE '2fa-%'`,
      [adminId],
    );
    expect(pending.rows).toHaveLength(1);
    const real = pending.rows[0]?.identifier as string;
    await owner.pool.query(
      `INSERT INTO verifications (identifier, value, expires_at)
       VALUES ($1, '3', now() + interval '10 minutes')
       ON CONFLICT DO NOTHING`,
      [`2fa-attempts-${real}`],
    );
    await challenge('2fa-otherchallenge', otherId);
    // Wrong codes built up a lock, and an unused reset link waits in the admin's mail.
    await lockOut(EMAIL);
    await owner.pool.query(
      `INSERT INTO verifications (identifier, value, expires_at)
       VALUES ('reset-password:keepme', $1, now() + interval '1 hour')`,
      [adminId],
    );
    const passwordBefore = (
      await owner.pool.query<{ password: string }>(
        `SELECT password FROM accounts WHERE user_id = $1::uuid AND provider_id = 'credential'`,
        [adminId],
      )
    ).rows[0]?.password;

    const reset = createAdmin(['--reset-two-factor', '--email', ' Owner@Example.com ']);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain(`Two factor reset: ${EMAIL}`);
    expect(reset.output).not.toMatch(PASSWORD_LINE);

    // Exactly one audit line, holding no email, code, secret or password.
    const lines = auditLines(reset.stderr);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(['actor', 'at', 'event', 'targetId']);
    expect(lines[0]).toMatchObject({ event: TWO_FACTOR_EVENT, targetId: adminId, actor: 'cli' });
    expect(lines[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(reset.stderr.toLowerCase()).not.toContain('example.com');
    expect(reset.stderr).not.toContain(adminPassword);
    expect(reset.stderr).not.toContain('unreadable');

    const state = (
      await owner.pool.query<{
        two_factor_enabled: boolean;
        must_change_password: boolean;
        password: string;
        factors: string;
        sessions: string;
        attempts: string;
      }>(
        `SELECT u.two_factor_enabled, u.must_change_password, a.password,
                (SELECT count(*) FROM two_factors WHERE user_id = u.id) AS factors,
                (SELECT count(*) FROM sessions WHERE user_id = u.id) AS sessions,
                (SELECT count(*) FROM sign_in_attempts WHERE email_key = $2) AS attempts
           FROM users u JOIN accounts a ON a.user_id = u.id AND a.provider_id = 'credential'
          WHERE u.id = $1::uuid`,
        [adminId, EMAIL],
      )
    ).rows[0];
    expect(state?.two_factor_enabled).toBe(false);
    expect(Number(state?.factors)).toBe(0);
    expect(Number(state?.sessions)).toBe(0);
    expect(Number(state?.attempts)).toBe(0);
    // Not touched: the password, the must change flag, and reset links.
    expect(state?.password).toBe(passwordBefore);
    expect(state?.must_change_password).toBe(false);
    const left = await owner.pool.query<{ identifier: string }>(
      `SELECT identifier FROM verifications ORDER BY identifier`,
    );
    expect(left.rows.map((r) => r.identifier)).toEqual([
      '2fa-attempts-2fa-otherchallenge',
      '2fa-otherchallenge',
      'reset-password:keepme',
    ]);
    // Another admin's second factor stays.
    const otherFactor = await owner.pool.query(
      `SELECT 1 FROM two_factors WHERE user_id = $1::uuid`,
      [otherId],
    );
    expect(otherFactor.rows).toHaveLength(1);

    // The old session is gone; the password alone signs in now.
    expect((await fetch(`${base}/api/me`, { headers: { cookie: oldCookie } })).status).toBe(401);
    const fresh = await signIn(adminPassword);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).not.toHaveProperty('twoFactorRedirect');
    const me = await fetch(`${base}/api/me`, { headers: { cookie: cookieOf(fresh) } });
    expect(me.status).toBe(200);
  });

  it('succeeds again with nothing to delete', async () => {
    const before = await owner.pool.query(
      `SELECT password FROM accounts WHERE user_id = $1::uuid`,
      [adminId],
    );
    const again = createAdmin(['--reset-two-factor', '--email', EMAIL]);
    expect(again.code).toBe(0);
    expect(auditLines(again.stderr)).toHaveLength(1);
    const after = await owner.pool.query(`SELECT password FROM accounts WHERE user_id = $1::uuid`, [
      adminId,
    ]);
    expect(after.rows).toEqual(before.rows);
    const factors = await owner.pool.query(`SELECT 1 FROM two_factors WHERE user_id = $1::uuid`, [
      adminId,
    ]);
    expect(factors.rows).toHaveLength(0);
  });

  it('refuses an unknown email, a non-admin and a disabled admin, and changes nothing', async () => {
    await enrol(adminId);
    await enrol(clerkId);
    await challenge('2fa-clerkchallenge', clerkId);
    await challenge('2fa-adminchallenge', adminId);
    await lockOut(CLERK);
    await lockOut(EMAIL);

    const unchanged = await snapshot();
    const unknown = createAdmin(['--reset-two-factor', '--email', 'nobody@example.com']);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('No account has the email');
    expect(auditLines(unknown.stderr)).toHaveLength(0);

    const staff = createAdmin(['--reset-two-factor', '--email', CLERK]);
    expect(staff.code).toBe(1);
    expect(staff.output).toContain('is not an admin');
    expect(auditLines(staff.stderr)).toHaveLength(0);
    expect(await snapshot()).toEqual(unchanged);

    await owner.pool.query(`UPDATE users SET banned = true WHERE id = $1::uuid`, [adminId]);
    const bannedState = await snapshot();
    const disabled = createAdmin(['--reset-two-factor', '--email', EMAIL]);
    expect(disabled.code).toBe(1);
    expect(disabled.output).toContain('is disabled');
    expect(auditLines(disabled.stderr)).toHaveLength(0);
    expect(await snapshot()).toEqual(bannedState);
    await owner.pool.query(`UPDATE users SET banned = false WHERE id = $1::uuid`, [adminId]);
  });

  it('leaves both the password and the two factor row unchanged when the combined run fails partway', async () => {
    // The last step of the transaction fails, after the password and two factor changes ran.
    await owner.pool.query(
      `CREATE FUNCTION fail_partway() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$`,
    );
    await owner.pool.query(
      `CREATE TRIGGER fail_partway BEFORE DELETE ON sign_in_attempts
         FOR EACH STATEMENT EXECUTE FUNCTION fail_partway()`,
    );
    try {
      const unchanged = await snapshot();
      expect(unchanged.twoFactors.some((r) => r.user_id === adminId)).toBe(true);
      const failed = createAdmin(['--reset-password', '--reset-two-factor', '--email', EMAIL]);
      expect(failed.code).toBe(1);
      // One fixed line with the pg code (P0001 is RAISE EXCEPTION): never the query params,
      // which hold the email and the new password hash.
      expect(failed.stderr.trim()).toBe('create-admin failed: P0001');
      expect(failed.stderr.toLowerCase()).not.toContain('example.com');
      expect(failed.stderr).not.toContain('$');
      expect(failed.stderr).not.toMatch(/[0-9a-f]{16,}:[0-9a-f]{16,}/);
      expect(failed.output).not.toContain('forced failure');
      expect(failed.output).not.toMatch(PASSWORD_LINE);
      expect(auditLines(failed.stderr)).toHaveLength(0);
      expect(await snapshot()).toEqual(unchanged);
    } finally {
      await owner.pool.query(`DROP TRIGGER fail_partway ON sign_in_attempts`);
      await owner.pool.query(`DROP FUNCTION fail_partway()`);
    }
  });

  it('resets the password and two factor together in one run', async () => {
    const passwordBefore = (
      await owner.pool.query<{ password: string }>(
        `SELECT password FROM accounts WHERE user_id = $1::uuid`,
        [adminId],
      )
    ).rows[0]?.password;

    const both = createAdmin(['--reset-password', '--reset-two-factor', '--email', EMAIL]);
    expect(both.code).toBe(0);
    const newPassword = PASSWORD_LINE.exec(both.output)?.[1] as string;
    expect(newPassword).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{16}$/);
    // Printed once, to stdout only.
    expect(both.stdout.split(newPassword)).toHaveLength(2);
    expect(both.stderr).not.toContain(newPassword);
    expect(both.stderr.toLowerCase()).not.toContain('example.com');
    // One audit line per mode.
    const lines = auditLines(both.stderr);
    expect(lines.map((l) => l.event).sort()).toEqual([PASSWORD_EVENT, TWO_FACTOR_EVENT].sort());
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(['actor', 'at', 'event', 'targetId']);
      expect(line).toMatchObject({ targetId: adminId, actor: 'cli' });
    }

    const state = (
      await owner.pool.query<{
        two_factor_enabled: boolean;
        must_change_password: boolean;
        password: string;
        factors: string;
        challenges: string;
        attempts: string;
      }>(
        `SELECT u.two_factor_enabled, u.must_change_password, a.password,
                (SELECT count(*) FROM two_factors WHERE user_id = u.id) AS factors,
                (SELECT count(*) FROM verifications
                  WHERE identifier IN ('2fa-adminchallenge', '2fa-attempts-2fa-adminchallenge')
                     OR value = u.id::text) AS challenges,
                (SELECT count(*) FROM sign_in_attempts WHERE email_key = $2) AS attempts
           FROM users u JOIN accounts a ON a.user_id = u.id AND a.provider_id = 'credential'
          WHERE u.id = $1::uuid`,
        [adminId, EMAIL],
      )
    ).rows[0];
    expect(state?.two_factor_enabled).toBe(false);
    expect(Number(state?.factors)).toBe(0);
    // The challenges and the reset link both go (AC-21 deletes reset links).
    expect(Number(state?.challenges)).toBe(0);
    expect(Number(state?.attempts)).toBe(0);
    expect(state?.must_change_password).toBe(true);
    expect(state?.password).not.toBe(passwordBefore);
    // The clerk's challenge and lock are someone else's and stay.
    const clerkRows = await owner.pool.query(
      `SELECT 1 FROM verifications WHERE identifier LIKE '%2fa-clerkchallenge'`,
    );
    expect(clerkRows.rows).toHaveLength(2);

    expect((await signIn(adminPassword)).status).not.toBe(200);
    const fresh = await signIn(newPassword);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).not.toHaveProperty('twoFactorRedirect');
  });

  it('prints the usage for missing or mixed arguments', () => {
    for (const args of [
      ['--reset-two-factor'],
      ['--reset-two-factor', '--reset-password'],
      ['--reset-two-factor', '--email', EMAIL, '--name', 'Owner'],
      ['--reset-password', '--reset-two-factor', '--email', EMAIL, '--name', 'Owner'],
    ]) {
      const result = createAdmin(args);
      expect(result.code).toBe(1);
      expect(result.output).toContain('--reset-two-factor --email <email>');
      expect(auditLines(result.stderr)).toHaveLength(0);
    }
  });
});
