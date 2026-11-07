import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  giveHats,
  WORKING_HATS,
  type TestAccess,
  secretFromUri,
  start,
  stop,
  totpCode,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const PASSWORD = 'Correct-Horse-1';

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

// Spec 0005, slice 6: two factor sign in with an authenticator app and backup codes.
describe('two factor sign in', { timeout: 300_000 }, () => {
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
      CLIENT_DISPLAY_NAME: 'Acme Home',
    });
    await waitForHttp(`${base}/api/health`, api);
    hash = await hashPassword(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const freshIp = () => {
    counter += 1;
    return `100.64.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
  };

  async function addPerson(
    options: { access?: TestAccess; mustChange?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `factor${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, must_change_password) VALUES ($1, $2, $3) RETURNING id`,
      [`Person ${counter}`, email, options.mustChange ?? false],
    );
    const id = rows[0]?.id as string;
    await giveHats(owner.pool, id, options.access ?? WORKING_HATS);
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
    ip = freshIp(),
  ): Promise<Reply> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-forwarded-for': ip,
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

  /** The `name=value` of a cookie the answer sets. A cookie with no value is Better Auth clearing it. */
  const cookieNamed = (reply: Reply, name: string): string | undefined =>
    reply.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.includes(name) && !c.endsWith('='));

  const password = (email: string, ip?: string, pw = PASSWORD) =>
    call(undefined, 'POST', '/api/auth/sign-in/email', { email, password: pw }, ip);

  async function signIn(email: string): Promise<string> {
    const reply = await password(email);
    const cookie = cookieNamed(reply, 'session_token');
    if (!cookie) throw new Error(`no session (status ${reply.status})`);
    return cookie;
  }

  /** Turns two factor on for a person and returns what a phone would hold. */
  async function enroll(
    email: string,
  ): Promise<{ secret: string; backupCodes: string[]; cookie: string }> {
    const cookie = await signIn(email);
    const enabled = await call(cookie, 'POST', '/api/auth/two-factor/enable', {
      password: PASSWORD,
    });
    expect(enabled.status).toBe(200);
    const secret = secretFromUri(enabled.body.totpURI as string);
    const verified = await call(cookie, 'POST', '/api/auth/two-factor/verify-totp', {
      code: totpCode(secret),
    });
    expect(verified.status).toBe(200);
    // Confirming the first code replaces the session, so the new cookie is the one to keep.
    return {
      secret,
      backupCodes: enabled.body.backupCodes as string[],
      cookie: cookieNamed(verified, 'session_token') ?? cookie,
    };
  }

  /** The password step of a sign in with two factor on: no session yet, only a challenge cookie. */
  async function challenge(email: string, ip = freshIp()) {
    const reply = await password(email, ip);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ twoFactorRedirect: true });
    expect(cookieNamed(reply, 'session_token')).toBeUndefined();
    const cookie = cookieNamed(reply, 'two_factor');
    if (!cookie) throw new Error('no challenge cookie');
    return { cookie, ip };
  }

  const twoFactorRow = (id: string) =>
    owner.pool
      .query<{ secret: string; backup_codes: string; verified: boolean }>(
        `SELECT secret, backup_codes, verified FROM two_factors WHERE user_id = $1::uuid`,
        [id],
      )
      .then((result) => result.rows[0]);

  const attempts = (email: string) =>
    owner.pool
      .query(`SELECT 1 FROM sign_in_attempts WHERE email_key = $1`, [email])
      .then((result) => result.rows.length);

  describe('turning it on (AC-20)', () => {
    it('needs the password, shows a link for the app and 10 backup codes once, and only counts after the first code', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);

      const wrong = await call(cookie, 'POST', '/api/auth/two-factor/enable', {
        password: 'Not-The-Password-1',
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ code: 'INVALID_PASSWORD' });

      const enabled = await call(cookie, 'POST', '/api/auth/two-factor/enable', {
        password: PASSWORD,
      });
      expect(enabled.status).toBe(200);
      const uri = new URL(enabled.body.totpURI as string);
      expect(uri.protocol).toBe('otpauth:');
      expect(decodeURIComponent(uri.pathname)).toContain(person.email);
      expect(uri.searchParams.get('issuer')).toBe('Acme Home');
      const codes = enabled.body.backupCodes as string[];
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);

      // Stored encrypted, and not yet confirmed: a sign in still needs no code.
      const row = await twoFactorRow(person.id);
      expect(row?.verified).toBe(false);
      expect(row?.secret).not.toContain(secretFromUri(enabled.body.totpURI as string));
      for (const code of codes) expect(row?.backup_codes).not.toContain(code);
      expect((await password(person.email)).body).not.toHaveProperty('twoFactorRedirect');
    });

    it('turns on only when the first code is right, and records it', async () => {
      const person = await addPerson();
      const cookie = await signIn(person.email);
      const enabled = await call(cookie, 'POST', '/api/auth/two-factor/enable', {
        password: PASSWORD,
      });
      const secret = secretFromUri(enabled.body.totpURI as string);

      const wrong = await call(cookie, 'POST', '/api/auth/two-factor/verify-totp', {
        code: '000000',
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ code: 'INVALID_CODE' });
      expect(
        (
          await owner.pool.query(`SELECT two_factor_enabled FROM users WHERE id = $1::uuid`, [
            person.id,
          ])
        ).rows[0],
      ).toEqual({ two_factor_enabled: false });

      const right = await call(cookie, 'POST', '/api/auth/two-factor/verify-totp', {
        code: totpCode(secret),
      });
      expect(right.status).toBe(200);
      const after = await owner.pool.query<{ two_factor_enabled: boolean }>(
        `SELECT two_factor_enabled FROM users WHERE id = $1::uuid`,
        [person.id],
      );
      expect(after.rows[0]?.two_factor_enabled).toBe(true);
      expect((await twoFactorRow(person.id))?.verified).toBe(true);
      const log = (api as RunningProcess).output();
      expect(
        log
          .split('\n')
          .find((l) => l.includes('"event":"TwoFactorEnabled"') && l.includes(person.id)),
      ).toBeDefined();
    });

    it('shows the new state in GET /api/me and, to an admin, in the staff list', async () => {
      const admin = await addPerson({ access: { hats: ['manager'], costView: true } });
      const person = await addPerson();
      const { cookie } = await enroll(person.email);

      expect((await call(cookie, 'GET', '/api/me')).body).toMatchObject({ twoFactorEnabled: true });
      const list = await call(await signIn(admin.email), 'GET', `/api/staff?q=${person.email}`);
      expect((list.body.rows as Array<{ twoFactorEnabled: boolean }>)[0]?.twoFactorEnabled).toBe(
        true,
      );
    });

    it('waits for a forced password change first', async () => {
      const forced = await addPerson({ mustChange: true });
      const cookie = await signIn(forced.email);

      const reply = await call(cookie, 'POST', '/api/auth/two-factor/enable', {
        password: PASSWORD,
      });

      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    });
  });

  describe('signing in with a code (AC-20, AC-3, AC-23)', () => {
    it('asks for a code after the password, and a right code finishes the sign in', async () => {
      const person = await addPerson();
      const { secret } = await enroll(person.email);
      await owner.pool.query(`UPDATE users SET last_sign_in_at = NULL WHERE id = $1::uuid`, [
        person.id,
      ]);
      const ip = freshIp();
      for (let i = 0; i < 2; i += 1) await password(person.email, ip, 'Wrong-Password-1');
      expect(await attempts(person.email)).toBeGreaterThan(0);

      const { cookie } = await challenge(person.email, ip);

      // Only the password step so far: not a sign in, and nothing is cleared.
      const pending = await owner.pool.query<{ last_sign_in_at: Date | null }>(
        `SELECT last_sign_in_at FROM users WHERE id = $1::uuid`,
        [person.id],
      );
      expect(pending.rows[0]?.last_sign_in_at).toBeNull();
      expect(await attempts(person.email)).toBeGreaterThan(0);
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(401);

      const done = await call(
        cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        {
          code: totpCode(secret),
        },
        ip,
      );
      expect(done.status).toBe(200);
      const session = cookieNamed(done, 'session_token');
      expect(session).toBeDefined();
      expect((await call(session, 'GET', '/api/me')).status).toBe(200);
      const full = await owner.pool.query<{ last_sign_in_at: Date | null }>(
        `SELECT last_sign_in_at FROM users WHERE id = $1::uuid`,
        [person.id],
      );
      expect(full.rows[0]?.last_sign_in_at).not.toBeNull();
      expect(await attempts(person.email)).toBe(0);
      const lines = (api as RunningProcess)
        .output()
        .split('\n')
        .filter((l) => l.includes(person.id));
      expect(lines.filter((l) => l.includes('"event":"SignedIn"') && l.includes(ip))).toHaveLength(
        1,
      );
    });

    it('answers a wrong code with 401 INVALID_CODE, and no cookie or code means no session', async () => {
      const person = await addPerson();
      await enroll(person.email);
      const { cookie, ip } = await challenge(person.email);

      const wrong = await call(
        cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        { code: '000000' },
        ip,
      );
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ code: 'INVALID_CODE' });
      expect(cookieNamed(wrong, 'session_token')).toBeUndefined();

      const nothing = await call(undefined, 'POST', '/api/auth/two-factor/verify-totp', {
        code: '123456',
      });
      expect(nothing.status).toBe(401);
    });

    it('counts wrong codes toward the same lock, ends the pending sign in, and gives the generic answer', async () => {
      const person = await addPerson();
      const { secret } = await enroll(person.email);
      const { cookie, ip } = await challenge(person.email);

      for (let i = 0; i < 5; i += 1) {
        const wrong = await call(
          cookie,
          'POST',
          '/api/auth/two-factor/verify-totp',
          { code: '000000' },
          ip,
        );
        expect(wrong.status).toBe(401);
      }
      const locked = await owner.pool.query(
        `SELECT 1 FROM sign_in_attempts WHERE email_key = $1 AND scope = $2 AND locked_until > now()`,
        [person.email, ip],
      );
      expect(locked.rows).toHaveLength(1);

      // The right code no longer works on that challenge, and the password step is locked too.
      const late = await call(
        cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        {
          code: totpCode(secret),
        },
        ip,
      );
      expect(late.status).toBe(401);
      expect(cookieNamed(late, 'session_token')).toBeUndefined();
      const again = await password(person.email, ip);
      expect(again.status).toBe(401);
      expect(again.body).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });

      // Another address is only turned away if the whole email is locked.
      const other = await challenge(person.email);
      const ok = await call(
        other.cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        {
          code: totpCode(secret),
        },
        other.ip,
      );
      expect(ok.status).toBe(200);
    });

    it('turns a code away with no free slot without ending the pending sign in, and gives each slot back', async () => {
      const person = await addPerson();
      const { secret } = await enroll(person.email);
      const { cookie, ip } = await challenge(person.email);
      const slots = async () =>
        (await owner.pool.query(`SELECT 1 FROM sign_in_slots WHERE email_key = $1`, [person.email]))
          .rows.length;
      // The password step waits for a code: its slot was given back, nothing counted.
      expect(await slots()).toBe(0);
      expect(await attempts(person.email)).toBe(0);

      // Five codes in flight hold every place for this pair (no lock is running).
      for (let i = 0; i < 5; i += 1) {
        await owner.pool.query(`INSERT INTO sign_in_slots (email_key, ip) VALUES ($1, $2)`, [
          person.email,
          ip,
        ]);
      }
      const turnedAway = await call(
        cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        { code: totpCode(secret) },
        ip,
      );
      expect(turnedAway.status).toBe(401);
      expect(turnedAway.body).toMatchObject({ code: 'INVALID_CODE' });
      expect(await attempts(person.email)).toBe(0);
      // Recorded like a turned away sign in: `SignInFailed` with reason `locked`, ids only.
      await expect
        .poll(
          () =>
            (api as RunningProcess)
              .output()
              .split('\n')
              .filter(
                (l) =>
                  l.includes('"event":"SignInFailed"') &&
                  l.includes('"reason":"locked"') &&
                  l.includes(`"ip":"${ip}"`) &&
                  l.includes(`"targetId":"${person.id}"`),
              ).length,
        )
        .toBe(1);

      // Those slots age out; the same challenge still works, so it was not ended.
      await owner.pool.query(
        `UPDATE sign_in_slots SET created_at = now() - interval '61 seconds' WHERE email_key = $1`,
        [person.email],
      );
      const done = await call(
        cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        { code: totpCode(secret) },
        ip,
      );
      expect(done.status).toBe(200);
      expect(cookieNamed(done, 'session_token')).toBeDefined();
      await owner.pool.query(`DELETE FROM sign_in_slots WHERE email_key = $1`, [person.email]);
    });

    it('lets a backup code sign in once, and not again', async () => {
      const person = await addPerson();
      const { backupCodes } = await enroll(person.email);
      const [first] = backupCodes as [string];

      const one = await challenge(person.email);
      const used = await call(
        one.cookie,
        'POST',
        '/api/auth/two-factor/verify-backup-code',
        { code: first },
        one.ip,
      );
      expect(used.status).toBe(200);
      expect(cookieNamed(used, 'session_token')).toBeDefined();

      const two = await challenge(person.email);
      const reused = await call(
        two.cookie,
        'POST',
        '/api/auth/two-factor/verify-backup-code',
        { code: first },
        two.ip,
      );
      expect(reused.status).toBe(401);
      expect(reused.body).toMatchObject({ code: 'INVALID_BACKUP_CODE' });
    });

    it('never remembers a device: asking for it is refused and no trust cookie is set', async () => {
      const person = await addPerson();
      const { secret } = await enroll(person.email);
      const { cookie, ip } = await challenge(person.email);

      const refused = await call(
        cookie,
        'POST',
        '/api/auth/two-factor/verify-totp',
        {
          code: totpCode(secret),
          trustDevice: true,
        },
        ip,
      );

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'TRUST_DEVICE_NOT_SUPPORTED' });
      expect(cookieNamed(refused, 'trust_device')).toBeUndefined();
      // Signing in again still asks for a code.
      expect((await password(person.email)).body).toMatchObject({ twoFactorRedirect: true });
    });

    it('keeps the email code routes and the link route closed', async () => {
      const person = await addPerson();
      const { cookie } = await enroll(person.email);

      for (const path of ['send-otp', 'verify-otp', 'get-totp-uri']) {
        const reply = await call(cookie, 'POST', `/api/auth/two-factor/${path}`, {
          password: PASSWORD,
        });
        expect(reply.status, path).toBe(404);
      }
    });
  });

  describe('backup codes and turning it off (AC-20, AC-3)', () => {
    it('makes 10 new backup codes with the password, and the old ones stop working', async () => {
      const person = await addPerson();
      const { backupCodes, cookie } = await enroll(person.email);

      const wrong = await call(cookie, 'POST', '/api/auth/two-factor/generate-backup-codes', {
        password: 'Not-The-Password-1',
      });
      expect(wrong.status).toBe(400);

      const fresh = await call(cookie, 'POST', '/api/auth/two-factor/generate-backup-codes', {
        password: PASSWORD,
      });
      expect(fresh.status).toBe(200);
      expect(fresh.body.backupCodes).toHaveLength(10);
      expect(fresh.body.backupCodes).not.toContain(backupCodes[0]);

      const attempt = await challenge(person.email);
      const old = await call(
        attempt.cookie,
        'POST',
        '/api/auth/two-factor/verify-backup-code',
        {
          code: backupCodes[0],
        },
        attempt.ip,
      );
      expect(old.status).toBe(401);
    });

    it('turns off with the password only, and a wrong one counts toward the lock', async () => {
      const person = await addPerson();
      const { cookie } = await enroll(person.email);
      const ip = freshIp();

      for (let i = 0; i < 5; i += 1) {
        const wrong = await call(
          cookie,
          'POST',
          '/api/auth/two-factor/disable',
          { password: 'Wrong-Password-1' },
          ip,
        );
        expect(wrong.status).toBe(400);
      }
      const locked = await owner.pool.query(
        `SELECT 1 FROM sign_in_attempts WHERE email_key = $1 AND scope = $2 AND locked_until > now()`,
        [person.email, ip],
      );
      expect(locked.rows).toHaveLength(1);
      // Locked: the right password is answered like a wrong one from that address.
      expect(
        (await call(cookie, 'POST', '/api/auth/two-factor/disable', { password: PASSWORD }, ip))
          .status,
      ).toBe(400);
      // The turn away writes one log line with the route and the ids (AC-23 names no event for
      // it), and never the email.
      await expect
        .poll(() =>
          (api as RunningProcess)
            .output()
            .split('\n')
            .filter((l) => l.includes('"outcome":"turned_away"') && l.includes(`"ip":"${ip}"`)),
        )
        .toHaveLength(1);
      const turnedAwayLine = (api as RunningProcess)
        .output()
        .split('\n')
        .find((l) => l.includes('"outcome":"turned_away"') && l.includes(`"ip":"${ip}"`));
      expect(turnedAwayLine).toContain('"route":"/two-factor/disable"');
      expect(turnedAwayLine).toContain(`"actorId":"${person.id}"`);
      expect(turnedAwayLine).toContain('"locked":true');
      expect(turnedAwayLine).not.toContain(person.email);

      const off = await call(cookie, 'POST', '/api/auth/two-factor/disable', {
        password: PASSWORD,
      });
      expect(off.status).toBe(200);
      expect(await twoFactorRow(person.id)).toBeUndefined();
      expect((await password(person.email)).body).not.toHaveProperty('twoFactorRedirect');
      expect(
        (api as RunningProcess)
          .output()
          .split('\n')
          .find((l) => l.includes('"event":"TwoFactorDisabled"') && l.includes(person.id)),
      ).toBeDefined();
    });
  });

  describe('an admin resetting two factor (AC-20)', () => {
    it('turns it off and ends their sessions, leaving the password alone', async () => {
      const admin = await addPerson({ access: { hats: ['manager'], costView: true } });
      const person = await addPerson();
      const { cookie } = await enroll(person.email);
      const adminCookie = await signIn(admin.email);

      const reset = await call(adminCookie, 'POST', `/api/staff/${person.id}/reset-two-factor`);

      expect(reset.status).toBe(200);
      expect(reset.body).toMatchObject({ twoFactorEnabled: false });
      expect((await call(cookie, 'GET', '/api/me')).status).toBe(401);
      expect(await twoFactorRow(person.id)).toBeUndefined();
      expect((await password(person.email)).status).toBe(200);
      expect(
        (api as RunningProcess)
          .output()
          .split('\n')
          .find(
            (l) =>
              l.includes('"event":"StaffTwoFactorReset"') && l.includes(`"actorId":"${admin.id}"`),
          ),
      ).toContain(`"targetId":"${person.id}"`);
    });

    it('is for admins only, and answers 404 for an unknown person', async () => {
      const staff = await addPerson();
      const admin = await addPerson({ access: { hats: ['manager'], costView: true } });
      const target = await addPerson();

      const forbidden = await call(
        await signIn(staff.email),
        'POST',
        `/api/staff/${target.id}/reset-two-factor`,
      );
      expect(forbidden.status).toBe(403);
      const missing = await call(
        await signIn(admin.email),
        'POST',
        '/api/staff/0190c0de-0000-7000-8000-00000000dead/reset-two-factor',
      );
      expect(missing.status).toBe(404);
    });
  });

  describe('code attempt limits (AC-4)', () => {
    it('limits code attempts to 15 per 10 minutes from one address, with X-Retry-After', async () => {
      const ip = freshIp();
      let limited: Reply | undefined;
      for (let i = 0; i < 16 && !limited; i += 1) {
        const reply = await call(
          undefined,
          'POST',
          '/api/auth/two-factor/verify-totp',
          { code: '000000' },
          ip,
        );
        if (reply.status === 429) limited = reply;
      }

      expect(limited?.status).toBe(429);
      expect(Number(limited?.headers.get('x-retry-after'))).toBeGreaterThan(0);
    });
  });
});
