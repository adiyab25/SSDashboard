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
const NEUTRAL = 'If this email exists in our system, check your email for the reset link';

// Spec 0005, slice 3: mail through a queue, and the password reset flow end to end.
describe('password reset by mail', { timeout: 240_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let smtp: Awaited<ReturnType<typeof startSmtpCapture>> | undefined;
  let api: RunningProcess | undefined;
  let worker: RunningProcess | undefined;
  let noMailApi: RunningProcess | undefined;
  let base: string;
  let noMailBase: string;
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
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const mailEnv = {
      DATABASE_URL: appUrl.toString(),
      BETTER_AUTH_SECRET: secret,
      MAIL_DRIVER: 'smtp',
      MAIL_FROM: 'Acme ERP <no-reply@acme.test>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURITY: 'none',
      CLIENT_DISPLAY_NAME: 'Acme Home',
    };
    api = start('main.js', { ...mailEnv, PORT: String(port), PUBLIC_URL: base });
    await waitForHttp(`${base}/api/health`, api);
    worker = start('worker.js', { ...mailEnv, PUBLIC_URL: base });
    await eventually(() => (worker?.output().includes('Worker started') ? true : undefined), {
      what: 'the worker to start',
    });

    const noMailPort = await freePort();
    noMailBase = `http://127.0.0.1:${noMailPort}`;
    noMailApi = start('main.js', {
      DATABASE_URL: appUrl.toString(),
      BETTER_AUTH_SECRET: secret,
      PORT: String(noMailPort),
      PUBLIC_URL: noMailBase,
    });
    await waitForHttp(`${noMailBase}/api/health`, noMailApi);
    hash = await hashPassword(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    await stop(noMailApi);
    await stop(worker);
    await stop(api);
    await smtp?.close();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  async function addUser(
    options: { banned?: boolean; language?: string; mustChange?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `reset${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, banned, language, must_change_password)
       VALUES ('Test Person', $1, $2, $3, $4) RETURNING id`,
      [email, options.banned ?? false, options.language ?? null, options.mustChange ?? false],
    );
    const id = rows[0]?.id as string;
    await giveHats(owner.pool, id, 'staff');
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    return { id, email };
  }

  const freshIp = () => {
    counter += 1;
    return `192.0.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
  };

  const post = (origin: string, path: string, body: unknown, ip = freshIp(), from = origin) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: from, 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });

  const requestReset = (email: string, ip = freshIp()) =>
    post(
      base,
      '/api/auth/request-password-reset',
      { email, redirectTo: `${base}/reset-password` },
      ip,
    );

  const signIn = async (email: string, password: string) => {
    const response = await post(base, '/api/auth/sign-in/email', { email, password });
    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    return { status: response.status, cookie: cookie?.split(';')[0] };
  };

  const mailTo = (email: string, after = 0): Promise<CapturedMail> =>
    eventually(() => smtp?.messages.filter((m) => m.to === email)[after], {
      what: `an email to ${email}`,
    });

  /** The token in the link of an email: the path segment Better Auth's token check reads. */
  const tokenOf = (mail: CapturedMail): string => {
    const found = /\/api\/auth\/reset-password\/([A-Za-z0-9]+)\?callbackURL=/.exec(mail.text);
    if (!found?.[1]) throw new Error(`no reset link in:\n${mail.text}`);
    return found[1];
  };

  const tokenRows = (userId: string) =>
    owner.pool
      .query<{ n: string }>(
        `SELECT count(*) AS n FROM verifications WHERE value = $1 AND identifier LIKE 'reset-password:%'`,
        [userId],
      )
      .then((result) => Number(result.rows[0]?.n));

  const checkLink = (token: string) =>
    fetch(
      `${base}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${base}/reset-password`)}`,
      { redirect: 'manual' },
    );

  describe('requesting a reset (AC-9, AC-11)', () => {
    it('answers the same neutral message for a real and an unknown email, no faster than 500 ms', async () => {
      const person = await addUser();

      const timed = async (email: string) => {
        const started = Date.now();
        const response = await requestReset(email);
        return { response, ms: Date.now() - started };
      };
      const real = await timed(person.email);
      const unknown = await timed('nobody-here@example.com');

      expect(real.response.status).toBe(200);
      expect(unknown.response.status).toBe(200);
      expect(await real.response.json()).toEqual({ status: true, message: NEUTRAL });
      expect(await unknown.response.json()).toEqual({ status: true, message: NEUTRAL });
      expect(real.ms).toBeGreaterThanOrEqual(480);
      expect(unknown.ms).toBeGreaterThanOrEqual(480);
    });

    it('sends one email through SMTP with a one hour link, for an account that has not signed in yet', async () => {
      const person = await addUser();
      await requestReset(person.email);

      const mail = await mailTo(person.email);

      expect(mail.subject).toBe('Reset your Acme Home password');
      expect(mail.text).toContain(`${base}/api/auth/reset-password/`);
      expect(mail.html).toContain('lang="en" dir="ltr"');
      const { rows } = await owner.pool.query<{ minutes: number }>(
        `SELECT extract(epoch FROM expires_at - now()) / 60 AS minutes
           FROM verifications WHERE identifier = $1`,
        [`reset-password:${tokenOf(mail)}`],
      );
      expect(Number(rows[0]?.minutes)).toBeGreaterThan(58);
      expect(Number(rows[0]?.minutes)).toBeLessThanOrEqual(60);
    });

    it("writes the email in the person's saved language", async () => {
      const person = await addUser({ language: 'ar' });
      await requestReset(person.email);

      const mail = await mailTo(person.email);

      expect(mail.html).toContain('lang="ar" dir="rtl"');
      expect(mail.subject).toMatch(/[؀-ۿ]/);
      expect(mail.subject).toContain('Acme Home');
    });

    it('keeps only ids in the queue: the token never sits in a job', async () => {
      const person = await addUser();
      await requestReset(person.email);
      const mail = await mailTo(person.email);

      const { rows } = await owner.pool.query<{ data: Record<string, string> }>(
        `SELECT data FROM pgboss.job WHERE name = 'mail.send' AND data->>'userId' = $1`,
        [person.id],
      );

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]?.data ?? {}).sort()).toEqual(['kind', 'tokenId', 'userId']);
      expect(JSON.stringify(rows[0]?.data)).not.toContain(tokenOf(mail));
    });

    it('lets only the newest link work: a new request deletes the older token', async () => {
      const person = await addUser();
      await requestReset(person.email);
      const first = tokenOf(await mailTo(person.email));
      await requestReset(person.email);
      const second = tokenOf(await mailTo(person.email, 1));

      expect(second).not.toBe(first);
      expect(await tokenRows(person.id)).toBe(1);
      expect((await checkLink(first)).headers.get('location')).toContain('error=INVALID_TOKEN');
      expect((await checkLink(second)).headers.get('location')).toContain(`token=${second}`);
    });

    it('sends nothing to a disabled account, answers the same, and leaves no live token', async () => {
      const person = await addUser({ banned: true });
      const response = await requestReset(person.email);

      expect(await response.json()).toEqual({ status: true, message: NEUTRAL });
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(smtp?.messages.some((m) => m.to === person.email)).toBe(false);
      expect(await tokenRows(person.id)).toBe(0);
    });

    it('limits requests to 3 per 15 minutes from one address, with X-Retry-After (AC-4)', async () => {
      const ip = freshIp();
      for (let i = 0; i < 3; i += 1) {
        expect((await requestReset('nobody-limit@example.com', ip)).status).toBe(200);
      }

      const limited = await requestReset('nobody-limit@example.com', ip);

      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('x-retry-after'))).toBeGreaterThan(0);
    });
  });

  describe('using the link (AC-8, AC-9)', () => {
    async function withLink() {
      const person = await addUser();
      await requestReset(person.email);
      const token = tokenOf(await mailTo(person.email));
      return { person, token };
    }

    it('redirects a good token to the reset page, and a bad one with INVALID_TOKEN', async () => {
      const { token } = await withLink();

      const good = await checkLink(token);
      expect(good.status).toBe(302);
      expect(good.headers.get('location')).toBe(`${base}/reset-password?token=${token}`);

      const bad = await checkLink('notarealtoken');
      expect(bad.headers.get('location')).toBe(`${base}/reset-password?error=INVALID_TOKEN`);
    });

    it('rejects weak passwords with 422 WEAK_PASSWORD and the unmet rules, and keeps the token', async () => {
      const { token, person } = await withLink();

      for (const [password, unmet] of [
        ['abc', ['min_length', 'uppercase', 'digit']],
        ['alllowercase1', ['uppercase']],
        ['ALLUPPERCASE1', ['lowercase']],
        ['NoDigitsHere', ['digit']],
      ] as const) {
        const response = await post(base, '/api/auth/reset-password', {
          token,
          newPassword: password,
        });
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'WEAK_PASSWORD', unmet });
      }
      expect(await tokenRows(person.id)).toBe(1);
    });

    it('sets the password once: sessions revoked, lockout cleared, email verified, flag cleared', async () => {
      const person = await addUser({ mustChange: true });
      // A live session and a running lock, both of which the reset must end.
      const session = await signIn(person.email, PASSWORD);
      expect(session.cookie).toBeDefined();
      for (let i = 0; i < 5; i += 1) await signIn(person.email, 'Wrong-Password-1');
      await owner.pool.query(
        `INSERT INTO sign_in_attempts (email_key, scope, failures, window_started_at, locked_until)
         VALUES ($1, '*', 20, now(), now() + interval '15 minutes')
         ON CONFLICT (tenant_id, email_key, scope) DO UPDATE SET locked_until = now() + interval '15 minutes'`,
        [person.email],
      );
      await requestReset(person.email);
      const token = tokenOf(await mailTo(person.email));

      const done = await post(base, '/api/auth/reset-password', {
        token,
        newPassword: NEW_PASSWORD,
      });

      expect(done.status).toBe(200);
      const me = await fetch(`${base}/api/me`, { headers: { cookie: session.cookie as string } });
      expect(me.status).toBe(401);
      const { rows } = await owner.pool.query<{
        email_verified: boolean;
        must_change_password: boolean;
      }>(`SELECT email_verified, must_change_password FROM users WHERE id = $1::uuid`, [person.id]);
      expect(rows[0]).toEqual({ email_verified: true, must_change_password: false });
      const attempts = await owner.pool.query(
        `SELECT 1 FROM sign_in_attempts WHERE email_key = $1`,
        [person.email],
      );
      expect(attempts.rows).toHaveLength(0);

      expect((await signIn(person.email, NEW_PASSWORD)).status).toBe(200);
      expect((await signIn(person.email, PASSWORD)).status).toBe(401);
    });

    it('works once only: a second use and the link itself now say INVALID_TOKEN', async () => {
      const { token } = await withLink();
      expect(
        (await post(base, '/api/auth/reset-password', { token, newPassword: NEW_PASSWORD })).status,
      ).toBe(200);

      const again = await post(base, '/api/auth/reset-password', {
        token,
        newPassword: NEW_PASSWORD,
      });

      expect(again.status).toBe(400);
      expect(await again.json()).toMatchObject({ code: 'INVALID_TOKEN' });
      expect((await checkLink(token)).headers.get('location')).toContain('error=INVALID_TOKEN');
    });

    it('limits completions to 5 per 15 minutes from one address (AC-4)', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) {
        const response = await post(
          base,
          '/api/auth/reset-password',
          { token: 'nope', newPassword: NEW_PASSWORD },
          ip,
        );
        expect(response.status).toBe(400);
      }

      const limited = await post(
        base,
        '/api/auth/reset-password',
        { token: 'nope', newPassword: NEW_PASSWORD },
        ip,
      );

      expect(limited.status).toBe(429);
    });

    it('refuses a reset from another origin', async () => {
      const { token } = await withLink();

      const response = await post(
        base,
        '/api/auth/reset-password',
        { token, newPassword: NEW_PASSWORD },
        freshIp(),
        'https://evil.example',
      );

      expect(response.status).toBe(403);
    });
  });

  describe('an install with no mail (AC-10)', () => {
    it('reports mailEnabled in the public config', async () => {
      expect(await (await fetch(`${base}/api/config`)).json()).toMatchObject({ mailEnabled: true });
      expect(await (await fetch(`${noMailBase}/api/config`)).json()).toMatchObject({
        mailEnabled: false,
      });
    });

    it('answers the same neutral message, queues nothing, and leaves no token behind', async () => {
      const person = await addUser();
      const queued = async () =>
        Number(
          (
            await owner.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM pgboss.job WHERE name = 'mail.send' AND data->>'userId' = $1`,
              [person.id],
            )
          ).rows[0]?.n,
        );

      const response = await post(noMailBase, '/api/auth/request-password-reset', {
        email: person.email,
        redirectTo: `${noMailBase}/reset-password`,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: true, message: NEUTRAL });
      expect(await queued()).toBe(0);
      expect(await tokenRows(person.id)).toBe(0);
    });
  });

  describe('audit lines (AC-23)', () => {
    it('logs the request and the completion with who and where, and never the link', async () => {
      const person = await addUser();
      const ip = freshIp();
      await requestReset(person.email, ip);
      const token = tokenOf(await mailTo(person.email));
      await post(base, '/api/auth/reset-password', { token, newPassword: NEW_PASSWORD }, ip);

      const apiLog = (api as RunningProcess).output();
      const requested = apiLog
        .split('\n')
        .find((l) => l.includes('"event":"PasswordResetRequested"') && l.includes(ip));
      const completed = apiLog
        .split('\n')
        .find((l) => l.includes('"event":"PasswordResetCompleted"') && l.includes(ip));
      expect(requested).toContain(`"targetId":"${person.id}"`);
      expect(completed).toContain(`"actorId":"${person.id}"`);
      for (const log of [apiLog, (worker as RunningProcess).output()]) {
        expect(log).not.toContain(token);
        expect(log).not.toContain(NEW_PASSWORD);
        expect(log).not.toContain(person.email);
      }
    });
  });

  describe('a mail server that is down (AC-11)', () => {
    it('does not fail the request, and the worker retries without ever logging the link', async () => {
      const person = await addUser();
      await smtp?.close();
      smtp = undefined;

      const response = await requestReset(person.email);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: true, message: NEUTRAL });
      const log = await eventually(
        () => {
          const output = (worker as RunningProcess).output();
          return output.includes('failed (try 1), will retry') ? output : undefined;
        },
        { what: 'the worker to log a failed try', timeoutMs: 30_000 },
      );
      const { rows } = await owner.pool.query<{ identifier: string }>(
        `SELECT identifier FROM verifications WHERE value = $1`,
        [person.id],
      );
      expect(rows).toHaveLength(1);
      const token = rows[0]?.identifier.replace('reset-password:', '') as string;
      expect(log).not.toContain(token);
      expect(log).not.toContain('/api/auth/reset-password/');
    });
  });
});
