import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGN_IN_SLOT_LOCK } from '../src/identity/sign-in/locks.js';
import { LOCKOUT, SignInLockout } from '../src/identity/sign-in/sign-in-lockout.js';
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

interface Answer {
  status: number;
  /** The body as text, so two answers can be compared byte for byte. */
  text: string;
  cookie: string | undefined;
  retryAfter: string | null;
}

// Spec 0005, slice 2: lockout, rate limits in PostgreSQL, the session cap, audit lines.
describe('staff sign in policy', { timeout: 180_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let env: Record<string, string>;
  let hash: string;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 4 });
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
    hash = await hashPassword(PASSWORD);
    api = start('main.js', env);
    await waitForHttp(`${base}/api/health`, api);
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  /** A person with a known password. Each test uses its own email so counters never overlap. */
  async function addUser(
    options: { banned?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `person${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email, banned) VALUES ('Test Person', $1, $2) RETURNING id`,
      [email, options.banned ?? false],
    );
    const id = rows[0]?.id as string;
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    return { id, email };
  }

  /** A client address no other test uses, so the per address rate limit never leaks across tests. */
  const freshIp = () => {
    counter += 1;
    return `198.51.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
  };

  async function signIn(email: string, password: string, ip: string): Promise<Answer> {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    });
    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    return {
      status: response.status,
      text: await response.text(),
      cookie: cookie?.split(';')[0],
      retryAfter: response.headers.get('x-retry-after'),
    };
  }

  const attempts = (email: string) =>
    owner.pool
      .query<{
        scope: string;
        failures: number;
        locked: boolean;
      }>(
        `SELECT scope, failures, COALESCE(locked_until > now(), false) AS locked
           FROM sign_in_attempts WHERE email_key = $1 ORDER BY scope`,
        [email],
      )
      .then((result) => result.rows);

  const slots = (email: string) =>
    owner.pool
      .query<{ n: number }>(`SELECT count(*)::int AS n FROM sign_in_slots WHERE email_key = $1`, [
        email,
      ])
      .then((result) => result.rows[0]?.n ?? 0);

  const me = (cookie: string) => fetch(`${base}/api/me`, { headers: { cookie } });

  describe('the schema', () => {
    it('has the counter tables live after the migration', async () => {
      const { rows } = await owner.pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name IN ('rate_limits', 'sign_in_attempts', 'sign_in_slots') ORDER BY 1, 2`,
      );
      const columns = (table: string) =>
        rows.filter((row) => row.table_name === table).map((row) => row.column_name);
      expect(columns('rate_limits')).toEqual(['count', 'id', 'key', 'last_request', 'tenant_id']);
      expect(columns('sign_in_attempts')).toEqual([
        'email_key',
        'failures',
        'locked_until',
        'scope',
        'tenant_id',
        'window_started_at',
      ]);
      expect(columns('sign_in_slots')).toEqual([
        'created_at',
        'email_key',
        'id',
        'ip',
        'tenant_id',
      ]);
    });
  });

  describe('lockout (AC-2, AC-3)', () => {
    it('locks an email and address after five failures, with the same answer for everything', async () => {
      const person = await addUser();
      const ip = freshIp();

      const wrong = await signIn(person.email, 'Wrong-Password-1', ip);
      expect(wrong.status).toBe(401);
      expect(JSON.parse(wrong.text)).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
      for (let i = 1; i < 5; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);

      // Locked: the correct password gets the generic answer, byte for byte, and no cookie.
      const locked = await signIn(person.email, PASSWORD, ip);
      expect(locked.status).toBe(wrong.status);
      expect(locked.text).toBe(wrong.text);
      expect(locked.cookie).toBeUndefined();

      // A real address and an unknown address answer the same too.
      const unknown = await signIn('nobody-here@example.com', 'Wrong-Password-1', freshIp());
      expect(unknown.text).toBe(wrong.text);

      const [pair, everyone] = await attempts(person.email).then((rows) => [
        rows.find((r) => r.scope === ip),
        rows.find((r) => r.scope === '*'),
      ]);
      expect(pair).toMatchObject({ failures: 5, locked: true });
      expect(everyone).toMatchObject({ failures: 5, locked: false });
    });

    it('lets the same person in from another address, and others in from the locked address', async () => {
      const person = await addUser();
      const other = await addUser();
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);

      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(401);
      expect((await signIn(person.email, PASSWORD, freshIp())).status).toBe(200);
      expect((await signIn(other.email, PASSWORD, ip)).status).toBe(200);
    });

    it('treats an unknown email like a real one: five failures lock it', async () => {
      const ip = freshIp();
      const email = 'ghost@example.com';
      for (let i = 0; i < 5; i += 1) await signIn(email, 'Wrong-Password-1', ip);

      expect((await attempts(email)).find((row) => row.scope === ip)).toMatchObject({
        failures: 5,
        locked: true,
      });
    });

    it('ignores letter case in the email when counting', async () => {
      const person = await addUser();
      const ip = freshIp();
      const spellings = [person.email, person.email.toUpperCase()];
      for (let i = 0; i < 5; i += 1)
        await signIn(spellings[i % 2] as string, 'Wrong-Password-1', ip);

      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(401);
    });

    it('locks the email for every address after 20 failures from spread out addresses', async () => {
      const person = await addUser();
      for (let i = 0; i < 20; i += 1) await signIn(person.email, 'Wrong-Password-1', freshIp());

      const rows = await attempts(person.email);
      expect(rows.find((row) => row.scope === '*')).toMatchObject({ failures: 20, locked: true });
      // No single address reached five, but a brand new address is still turned away.
      expect(rows.filter((row) => row.scope !== '*').every((row) => !row.locked)).toBe(true);
      expect((await signIn(person.email, PASSWORD, freshIp())).status).toBe(401);
    });

    it('checks at most five passwords when attempts for one pair arrive at the same moment, and counts each one', async () => {
      const person = await addUser();
      const ip = freshIp();

      const answers = await Promise.all(
        Array.from({ length: 10 }, () => signIn(person.email, 'Wrong-Password-1', ip)),
      );

      // Every attempt gets the same generic answer: none fell over or hit a rate limit.
      expect(answers.every((a) => a.status === 401 && a.text === answers[0]?.text)).toBe(true);
      // An attempt that gets no free slot is turned away before its password is checked, and
      // is not counted (AC-3). Each attempt is read from its audit line: a checked password is
      // `bad_credentials`, a turned away one is `locked`. The lines reach the pipe a moment
      // after the answers.
      const reasons = (): string[] =>
        (api as RunningProcess)
          .output()
          .split('\n')
          .filter((l) => l.includes('"event":"SignInFailed"') && l.includes(`"ip":"${ip}"`))
          .map((l) => /"reason":"(\w+)"/.exec(l)?.[1] ?? 'none');
      await expect.poll(() => reasons().length).toBe(10);
      const checked = reasons().filter((r) => r === 'bad_credentials').length;
      expect(checked + reasons().filter((r) => r === 'locked').length).toBe(10);

      // Whatever the concurrency, no more passwords are checked than the pair limit, and every
      // checked one was counted on both rows: none was lost to the race.
      expect(checked).toBe(LOCKOUT.pairLimit);
      const rows = await attempts(person.email);
      expect(rows.find((row) => row.scope === ip)).toMatchObject({ failures: 5, locked: true });
      expect(rows.find((row) => row.scope === '*')?.failures).toBe(5);
      // Every slot was given back.
      expect(await slots(person.email)).toBe(0);
    });

    it('stops counting a slot left behind for more than 60 seconds', async () => {
      const person = await addUser();
      const ip = freshIp();
      // Five slots from requests that died before they could give them back.
      for (let i = 0; i < LOCKOUT.pairLimit; i += 1) {
        await owner.pool.query(
          `INSERT INTO sign_in_slots (email_key, ip, created_at) VALUES ($1, $2, now())`,
          [person.email, ip],
        );
      }
      // While they are young they hold every place: the right password is turned away.
      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(401);
      expect(await attempts(person.email)).toEqual([]);

      await owner.pool.query(
        `UPDATE sign_in_slots SET created_at = now() - interval '61 seconds' WHERE email_key = $1`,
        [person.email],
      );
      const answer = await signIn(person.email, PASSWORD, ip);
      expect(answer.status).toBe(200);
      expect(answer.cookie).toBeDefined();
    });

    it('caps the email across addresses: held slots plus failures at 20 turn a new address away', async () => {
      const person = await addUser();
      // 16 failures in the window from eight addresses, two each, then four slots held from four
      // of them: no pair reaches five (at most 2 + 1), but the email is at 16 + 4 = 20.
      const ips = Array.from({ length: 8 }, () => freshIp());
      for (const ip of ips) {
        await owner.pool.query(
          `INSERT INTO sign_in_attempts (email_key, scope, failures, window_started_at)
           VALUES ($1, $2, 2, now())`,
          [person.email, ip],
        );
      }
      await owner.pool.query(
        `INSERT INTO sign_in_attempts (email_key, scope, failures, window_started_at)
         VALUES ($1, '*', 16, now())`,
        [person.email],
      );
      for (const ip of ips.slice(0, 4)) {
        await owner.pool.query(
          `INSERT INTO sign_in_slots (email_key, ip, created_at) VALUES ($1, $2, now())`,
          [person.email, ip],
        );
      }
      const before = await attempts(person.email);

      // A fresh address with the right password is turned away, and nothing is counted.
      const newIp = freshIp();
      const turnedAway = await signIn(person.email, PASSWORD, newIp);
      expect(turnedAway.status).toBe(401);
      expect(turnedAway.cookie).toBeUndefined();
      expect(await attempts(person.email)).toEqual(before);
      expect(await slots(person.email)).toBe(4);

      // Once the held slots are older than 60 seconds they hold no place: 16 is under 20.
      await owner.pool.query(
        `UPDATE sign_in_slots SET created_at = now() - interval '61 seconds' WHERE email_key = $1`,
        [person.email],
      );
      const answer = await signIn(person.email, PASSWORD, newIp);
      expect(answer.status).toBe(200);
      expect(answer.cookie).toBeDefined();
    });

    it('turns a request away, uncounted, when it waits too long for its turn on the email', async () => {
      const email = `waiting${counter}@example.com`;
      const appUrl = new URL(scratch.url);
      appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
      const app = createDatabase(appUrl.toString(), { max: 2 });
      const holder = await owner.pool.connect();
      try {
        // Another request holds the email's turn for longer than the lock timeout.
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))`, [
          SIGN_IN_SLOT_LOCK,
          email,
        ]);
        const taken = await new SignInLockout(app).takeSlot(email, freshIp());
        expect(taken).toEqual({ slot: null, locked: false });
        expect(await slots(email)).toBe(0);
        expect(await attempts(email)).toEqual([]);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await app.pool.end();
      }
    });

    it('gives the slot back after an attempt that is not counted', async () => {
      const banned = await addUser({ banned: true });
      const ip = freshIp();
      expect((await signIn(banned.email, PASSWORD, ip)).status).toBe(403);
      expect(await slots(banned.email)).toBe(0);

      const person = await addUser();
      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(200);
      expect(await slots(person.email)).toBe(0);
    });

    it('counts every one of many failures recorded at the same moment, and locks once', async () => {
      // Straight at the upsert, with no password hashing to spread the calls out, so a read
      // then write counter would lose counts here.
      const appUrl = new URL(scratch.url);
      appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
      const app = createDatabase(appUrl.toString(), { max: 20 });
      try {
        const lockout = new SignInLockout(app);
        const email = `burst${counter}@example.com`;
        // Three addresses at once, so they also contend on the shared all addresses row.
        const ips = [freshIp(), freshIp(), freshIp()];
        const outcomes = await Promise.all(
          Array.from({ length: 60 }, (_, i) => lockout.recordFailure(email, ips[i % 3] as string)),
        );

        const rows = await attempts(email);
        for (const ip of ips) {
          expect(rows.find((row) => row.scope === ip)).toMatchObject({
            failures: 20,
            locked: true,
          });
        }
        expect(rows.find((row) => row.scope === '*')).toMatchObject({
          failures: 60,
          locked: true,
        });
        // Exactly one failure starts each lock, so each `AccountLocked` is written once.
        expect(outcomes.filter((o) => o.pairLocked)).toHaveLength(3);
        expect(outcomes.filter((o) => o.emailLocked)).toHaveLength(1);
      } finally {
        await app.pool.end();
      }
    });

    it('lets the person in once the lock has ended, and then clears the counters', async () => {
      const person = await addUser();
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);
      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(401);

      // The clock moves past the lock and its window (the rows are aged instead of waiting).
      await owner.pool.query(
        `UPDATE sign_in_attempts
            SET locked_until = now() - interval '1 minute',
                window_started_at = now() - interval '30 minutes'
          WHERE email_key = $1`,
        [person.email],
      );
      const answer = await signIn(person.email, PASSWORD, ip);
      expect(answer.status).toBe(200);
      expect(answer.cookie).toBeDefined();
      expect(await attempts(person.email)).toEqual([]);
    });

    it('restarts a counter whose window is over, so old failures do not add up', async () => {
      const person = await addUser();
      const ip = freshIp();
      for (let i = 0; i < 4; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);
      await owner.pool.query(
        `UPDATE sign_in_attempts SET window_started_at = now() - interval '11 minutes'
          WHERE email_key = $1`,
        [person.email],
      );

      await signIn(person.email, 'Wrong-Password-1', ip);

      expect((await attempts(person.email)).find((row) => row.scope === ip)).toMatchObject({
        failures: 1,
        locked: false,
      });
    });

    it('resets the counters only after a full sign in', async () => {
      const person = await addUser();
      const ip = freshIp();
      for (let i = 0; i < 4; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);
      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(200);
      expect(await attempts(person.email)).toEqual([]);

      // Four more failures are four, not eight: the person is not locked.
      for (let i = 0; i < 4; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);
      expect((await signIn(person.email, PASSWORD, ip)).status).toBe(200);
    });

    it('tells a disabled account apart only when the password is right (AC-2)', async () => {
      const person = await addUser({ banned: true });
      const ip = freshIp();

      const wrong = await signIn(person.email, 'Wrong-Password-1', ip);
      expect(wrong.status).toBe(401);
      expect(JSON.parse(wrong.text)).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
      expect(await attempts(person.email)).toHaveLength(2);

      const right = await signIn(person.email, PASSWORD, ip);
      expect(right.status).toBe(403);
      expect(JSON.parse(right.text)).toMatchObject({ code: 'BANNED_USER' });
      expect(right.cookie).toBeUndefined();
      // Neither a failure nor a reset: the one earlier failure is still the only count.
      expect((await attempts(person.email)).find((row) => row.scope === ip)?.failures).toBe(1);
    });
  });

  describe('the Origin check (AC-7)', () => {
    it('refuses a sign in from another site', async () => {
      const person = await addUser();
      const response = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          'x-forwarded-for': freshIp(),
        },
        body: JSON.stringify({ email: person.email, password: PASSWORD }),
      });

      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    });
  });

  describe('sessions (AC-5)', () => {
    async function signedIn() {
      const person = await addUser();
      const answer = await signIn(person.email, PASSWORD, freshIp());
      expect(answer.cookie).toBeDefined();
      return { person, cookie: answer.cookie as string };
    }

    it('keeps a fresh session without renewing it again at once', async () => {
      const { cookie } = await signedIn();

      const response = await me(cookie);

      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('renews an idle session and its cookie when it is used after the first hour', async () => {
      const { person, cookie } = await signedIn();
      await owner.pool.query(
        `UPDATE sessions SET expires_at = now() + interval '10 hours' WHERE user_id = $1::uuid`,
        [person.id],
      );

      const response = await me(cookie);

      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie().some((c) => c.includes('session_token'))).toBe(true);
      const { rows } = await owner.pool.query<{ hours: number }>(
        `SELECT extract(epoch FROM expires_at - now()) / 3600 AS hours
           FROM sessions WHERE user_id = $1::uuid`,
        [person.id],
      );
      expect(Number(rows[0]?.hours)).toBeGreaterThan(11.9);
    });

    it('ends a session left idle for 12 hours', async () => {
      const { person, cookie } = await signedIn();
      await owner.pool.query(
        `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1::uuid`,
        [person.id],
      );

      const response = await me(cookie);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('ends a session 7 days after sign in even when it was used a minute ago', async () => {
      const { person, cookie } = await signedIn();
      expect((await me(cookie)).status).toBe(200);
      await owner.pool.query(
        `UPDATE sessions SET created_at = now() - interval '7 days 1 minute'
          WHERE user_id = $1::uuid`,
        [person.id],
      );

      const response = await me(cookie);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
      const { rows } = await owner.pool.query(`SELECT 1 FROM sessions WHERE user_id = $1::uuid`, [
        person.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('answers a disabled person on their very next request', async () => {
      const { person, cookie } = await signedIn();
      await owner.pool.query(`UPDATE users SET banned = true WHERE id = $1::uuid`, [person.id]);

      const response = await me(cookie);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('rate limits in PostgreSQL (AC-4)', () => {
    it('answers 429 with X-Retry-After after 30 sign ins a minute, and a restart does not reset it', async () => {
      const ip = freshIp();
      for (let i = 0; i < 30; i += 1) {
        const answer = await signIn(`spray${i}@example.com`, 'Wrong-Password-1', ip);
        expect(answer.status).toBe(401);
      }

      const limited = await signIn('spray-extra@example.com', 'Wrong-Password-1', ip);
      expect(limited.status).toBe(429);
      expect(Number(limited.retryAfter)).toBeGreaterThan(0);

      const { rows } = await owner.pool.query<{ count: number }>(
        `SELECT count FROM rate_limits WHERE key LIKE $1`,
        [`%${ip}%sign-in%`],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(30);

      await stop(api);
      api = start('main.js', env);
      await waitForHttp(`${base}/api/health`, api);
      const afterRestart = await signIn('spray-again@example.com', 'Wrong-Password-1', ip);
      expect(afterRestart.status).toBe(429);
    });

    it('limits one address and leaves the others alone', async () => {
      const person = await addUser();
      expect((await signIn(person.email, PASSWORD, freshIp())).status).toBe(200);
    });
  });

  describe('audit lines (AC-23)', () => {
    it('logs sign in outcomes with who, from where, and never the password or the email', async () => {
      const person = await addUser();
      const ip = freshIp();
      await signIn(person.email, 'Wrong-Password-1', ip);
      await signIn(person.email, PASSWORD, ip);

      const log = (api as RunningProcess).output();
      const failed = log
        .split('\n')
        .find((l) => l.includes('"event":"SignInFailed"') && l.includes(ip));
      const signedInLine = log
        .split('\n')
        .find((l) => l.includes('"event":"SignedIn"') && l.includes(ip));
      expect(failed).toContain('"reason":"bad_credentials"');
      expect(failed).toContain(`"targetId":"${person.id}"`);
      expect(signedInLine).toContain(`"actorId":"${person.id}"`);
      expect(log).not.toContain('Wrong-Password-1');
      expect(log).not.toContain(PASSWORD);
      expect(log).not.toContain(person.email);

      const { rows } = await owner.pool.query<{ last_sign_in_at: Date | null }>(
        `SELECT last_sign_in_at FROM users WHERE id = $1::uuid`,
        [person.id],
      );
      expect(rows[0]?.last_sign_in_at).not.toBeNull();
    });

    it('logs a lock start once, and a locked attempt with its reason', async () => {
      const person = await addUser();
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) await signIn(person.email, 'Wrong-Password-1', ip);
      await signIn(person.email, PASSWORD, ip);

      const lines = (api as RunningProcess)
        .output()
        .split('\n')
        .filter((l) => l.includes(ip));
      expect(lines.filter((l) => l.includes('"event":"AccountLocked"'))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('"reason":"locked"'))).toHaveLength(1);
    });
  });

  describe('the route allowlist', () => {
    it('keeps routes that later slices open closed for now', async () => {
      for (const path of ['/get-session', '/sign-up/email', '/update-user']) {
        const response = await fetch(`${base}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base },
          body: '{}',
        });
        expect(response.status, path).toBe(404);
      }
    });
  });
});
