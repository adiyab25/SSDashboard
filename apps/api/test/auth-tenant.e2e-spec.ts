import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCKOUT, SignInLockout } from '../src/identity/sign-in/sign-in-lockout.js';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  requireBuild,
  secretFromUri,
  start,
  startSmtpCapture,
  stop,
  totpCode,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const TENANT = '0192f7a0-0000-7000-8000-00000000a032';
const ADMIN_EMAIL = 'owner@example.com';
const PASSWORD = 'Correct-Horse-1';
const PASSWORD_LINE = /Temporary password .*: (\S+)$/m;
/** Every table the identity module owns that rows are written to today (AC-3, AC-32). */
const AUTH_TABLES = [
  'users',
  'sessions',
  'accounts',
  'verifications',
  'two_factors',
  'rate_limits',
  'sign_in_attempts',
  'sign_in_slots',
] as const;

interface Reply {
  status: number;
  body: Record<string, unknown>;
  cookie: string | undefined;
}

// Spec 0005, AC-32: no auth code names tenant_id, yet every row it makes holds the install's
// tenant id, filled by the column default from the `ssd.tenant_id` database setting.
describe('the tenant id on the auth tables (AC-32)', { timeout: 180_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let smtp: Awaited<ReturnType<typeof startSmtpCapture>> | undefined;
  let api: RunningProcess | undefined;
  let base: string;
  let env: Record<string, string>;
  let appUrl: URL;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url, { tenantId: TENANT });
    owner = createDatabase(scratch.url, { max: 2 });
    smtp = await startSmtpCapture();
    appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      // A reset token is kept only when mail can carry it (AC-10); no worker runs, so nothing
      // is sent.
      MAIL_DRIVER: 'smtp',
      MAIL_FROM: 'Acme ERP <no-reply@acme.test>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURITY: 'none',
    };
    api = start('main.js', env);
    await waitForHttp(`${base}/api/health`, api);
  }, 90_000);

  afterAll(async () => {
    await stop(api);
    await smtp?.close();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const freshIp = () => {
    counter += 1;
    return `192.0.2.${counter}`;
  };

  async function call(
    method: string,
    path: string,
    body?: unknown,
    options: { cookie?: string; ip?: string } = {},
  ): Promise<Reply> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-forwarded-for': options.ip ?? freshIp(),
        ...(options.cookie && { cookie: options.cookie }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.includes('session_token') && !c.endsWith('='));
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      cookie,
    };
  }

  const signIn = (email: string, password: string, ip?: string) =>
    call('POST', '/api/auth/sign-in/email', { email, password }, ip ? { ip } : {});

  /** The distinct tenant ids in a table and how many rows it has. */
  async function tenantsOf(table: (typeof AUTH_TABLES)[number]) {
    const { rows } = await owner.pool.query<{ tenant_id: string; n: number }>(
      `SELECT tenant_id, count(*)::int AS n FROM ${table} GROUP BY tenant_id`,
    );
    return rows;
  }

  function createAdmin(args: string[]) {
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

  it('stores the install tenant in the install row and the database setting', async () => {
    const install = await owner.pool.query<{ id: string }>('SELECT id FROM install');
    expect(install.rows).toEqual([{ id: TENANT }]);
    const app = createDatabase(appUrl.toString(), { max: 1 });
    try {
      const setting = await app.pool.query<{ tenant: string }>(
        "SELECT current_setting('ssd.tenant_id') AS tenant",
      );
      expect(setting.rows[0]?.tenant).toBe(TENANT);
    } finally {
      await app.pool.end();
    }
  });

  it('creates the first admin on a fresh database, and signs them in, under the tenant', async () => {
    expect(await tenantsOf('users')).toEqual([]);

    const created = createAdmin(['--email', ADMIN_EMAIL, '--name', 'Owner']);
    expect(created.code).toBe(0);
    const temporary = PASSWORD_LINE.exec(created.output)?.[1] as string;
    expect(await tenantsOf('users')).toEqual([{ tenant_id: TENANT, n: 1 }]);
    expect(await tenantsOf('accounts')).toEqual([{ tenant_id: TENANT, n: 1 }]);

    const signedIn = await signIn(ADMIN_EMAIL, temporary);
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toBeDefined();
    expect(await tenantsOf('sessions')).toEqual([{ tenant_id: TENANT, n: 1 }]);
  });

  it('keeps a reset token under the tenant', async () => {
    const reply = await call('POST', '/api/auth/request-password-reset', {
      email: ADMIN_EMAIL,
      redirectTo: `${base}/reset-password`,
    });
    expect(reply.status).toBe(200);

    const { rows } = await owner.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM verifications WHERE identifier LIKE 'reset-password:%'`,
    );
    expect(rows).toEqual([{ tenant_id: TENANT }]);
  });

  it('keeps a two factor enrolment and its pending sign in under the tenant', async () => {
    const email = 'factor@example.com';
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES ('Factor Person', $1) RETURNING id`,
      [email],
    );
    const userId = rows[0]?.id as string;
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [userId, await hashPassword(PASSWORD)],
    );
    const first = await signIn(email, PASSWORD);
    const cookie = first.cookie as string;
    const enabled = await call(
      'POST',
      '/api/auth/two-factor/enable',
      { password: PASSWORD },
      {
        cookie,
      },
    );
    expect(enabled.status).toBe(200);
    const verified = await call(
      'POST',
      '/api/auth/two-factor/verify-totp',
      { code: totpCode(secretFromUri(enabled.body.totpURI as string)) },
      { cookie },
    );
    expect(verified.status).toBe(200);

    const factors = await owner.pool.query<{ tenant_id: string; verified: boolean }>(
      'SELECT tenant_id, verified FROM two_factors WHERE user_id = $1',
      [userId],
    );
    expect(factors.rows).toEqual([{ tenant_id: TENANT, verified: true }]);

    // A password step now waits on a second factor, kept as a `2fa-` verification row.
    const pending = await signIn(email, PASSWORD);
    expect(pending.body).toMatchObject({ twoFactorRedirect: true });
    const challenges = await owner.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM verifications WHERE identifier LIKE '2fa-%' AND value = $1`,
      [userId],
    );
    expect(challenges.rows.length).toBeGreaterThan(0);
    expect(new Set(challenges.rows.map((row) => row.tenant_id))).toEqual(new Set([TENANT]));
  });

  it('counts a lockout under the tenant', async () => {
    const email = 'nobody@example.com';
    const ip = freshIp();
    for (let i = 0; i < LOCKOUT.pairLimit; i += 1) {
      expect((await signIn(email, 'Wrong-Password-1', ip)).status).toBe(401);
    }

    const { rows } = await owner.pool.query<{
      tenant_id: string;
      scope: string;
      locked: boolean;
    }>(
      `SELECT tenant_id, scope, COALESCE(locked_until > now(), false) AS locked
         FROM sign_in_attempts WHERE email_key = $1 ORDER BY scope`,
      [email],
    );
    expect(rows).toEqual([
      { tenant_id: TENANT, scope: '*', locked: false },
      { tenant_id: TENANT, scope: ip, locked: true },
    ]);
  });

  it('keeps the rate limit counters under the tenant', async () => {
    const rows = await tenantsOf('rate_limits');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT);
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it('holds a sign in slot under the tenant, and gives it back', async () => {
    const app = createDatabase(appUrl.toString(), { max: 1 });
    try {
      const lockout = new SignInLockout(app);
      const taken = await lockout.takeSlot('slot@example.com', freshIp());
      if (taken.slot === null) throw new Error('expected a free slot');
      expect(await tenantsOf('sign_in_slots')).toEqual([{ tenant_id: TENANT, n: 1 }]);

      await lockout.giveBack(taken.slot);
      expect(await tenantsOf('sign_in_slots')).toEqual([]);
    } finally {
      await app.pool.end();
    }
  });

  it('leaves no auth row with any other tenant', async () => {
    for (const table of AUTH_TABLES) {
      const tenants = (await tenantsOf(table)).map((row) => row.tenant_id);
      expect(
        tenants.filter((tenant) => tenant !== TENANT),
        table,
      ).toEqual([]);
    }
  });
});
