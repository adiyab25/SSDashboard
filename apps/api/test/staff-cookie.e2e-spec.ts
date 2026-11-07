import { randomBytes } from 'node:crypto';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  giveHats,
  secretFromUri,
  start,
  stop,
  totpCode,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const PASSWORD = 'Cookie-Contract-1';
const PORTAL_HOST = 'shop.example.test';
const SECURE_ORIGIN = 'https://erp.example.test';

interface Reply {
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}

/** One running api: its address, the staff origin it trusts, and its process. */
interface Api {
  base: string;
  /** `PUBLIC_URL`, sent as `Origin`: the plain address unless the api was given another one. */
  origin: string;
  proc: RunningProcess;
}

/** The value of one attribute of a Set-Cookie line, or undefined when it is absent. */
const attribute = (cookie: string, name: string): string | undefined =>
  cookie
    .split(';')
    .slice(1)
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith(`${name.toLowerCase()}=`))
    ?.slice(name.length + 1);

const hasDomain = (cookie: string) =>
  cookie
    .split(';')
    .slice(1)
    .some((part) => /^domain(=|$)/i.test(part.trim()));

/** The `name=value` of a cookie the answer sets with a value. A cookie with no value is a clear. */
const cookieNamed = (reply: Reply, name: string): string | undefined =>
  reply.cookies
    .map((c) => c.split(';')[0] as string)
    .find((c) => c.includes(name) && !c.endsWith('='));

// Spec 0005 amendment, AC-30 and AC-31: the staff cookie contract. Host only (never a Domain),
// Path from STAFF_BASE_PATH on every cookie Better Auth sets and clears, and Better Auth answers
// 404 on the portal host when PORTAL_ORIGIN is set.
describe('staff cookie contract', { timeout: 300_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let scoped: Api | undefined;
  let plain: Api | undefined;
  let secure: Api | undefined;
  let hash: string;
  let counter = 0;

  async function startApi(extra: Record<string, string>): Promise<Api> {
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const proc = start('main.js', {
      DATABASE_URL: appUrl.toString(),
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      PORT: String(port),
      PUBLIC_URL: base,
      ...extra,
    });
    await waitForHttp(`${base}/api/health`, proc);
    return { base, origin: extra.PUBLIC_URL ?? base, proc };
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    hash = await hashPassword(PASSWORD);
    scoped = await startApi({
      STAFF_BASE_PATH: '/ops',
      PORTAL_ORIGIN: `https://${PORTAL_HOST}`,
    });
    plain = await startApi({});
    // An https staff origin; the test still talks plain http to the process, as Caddy does.
    secure = await startApi({ PUBLIC_URL: SECURE_ORIGIN, STAFF_BASE_PATH: '/ops' });
  }, 120_000);

  afterAll(async () => {
    await stop(scoped?.proc);
    await stop(plain?.proc);
    await stop(secure?.proc);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const freshIp = () => {
    counter += 1;
    return `100.65.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
  };

  async function addPerson(): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `cookie${counter}@example.com`;
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id`,
      [`Person ${counter}`, email],
    );
    const id = rows[0]?.id as string;
    await giveHats(owner.pool, id, { hats: ['support', 'operations', 'warehouse'] });
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [id, hash],
    );
    return { id, email };
  }

  async function call(
    api: Api | undefined,
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    if (!api) throw new Error('the api did not start');
    const response = await fetch(`${api.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-forwarded-for': freshIp(),
        ...(options.cookie && { cookie: options.cookie }),
        ...options.headers,
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      cookies: response.headers.getSetCookie(),
    };
  }

  const signIn = (api: Api | undefined, email: string, headers?: Record<string, string>) =>
    call(api, 'POST', '/api/auth/sign-in/email', {
      body: { email, password: PASSWORD },
      ...(headers && { headers }),
    });

  /** Every Set-Cookie line must be host only and carry exactly this path. */
  function expectScoped(reply: Reply, path: string) {
    expect(reply.cookies.length).toBeGreaterThan(0);
    for (const cookie of reply.cookies) {
      expect(hasDomain(cookie), cookie).toBe(false);
      expect(attribute(cookie, 'Path'), cookie).toBe(path);
    }
  }

  describe('with STAFF_BASE_PATH=/ops (AC-31)', () => {
    it('sets the session cookie host only, on Path=/ops (AC-30)', async () => {
      const person = await addPerson();

      const reply = await signIn(scoped, person.email);

      expect(reply.status).toBe(200);
      expect(cookieNamed(reply, 'session_token')).toBeDefined();
      expectScoped(reply, '/ops');
      const session = reply.cookies.find((c) => c.includes('session_token')) as string;
      expect(session).toMatch(/HttpOnly/i);
      expect(attribute(session, 'SameSite')?.toLowerCase()).toBe('lax');
    });

    it('renews the session cookie on Path=/ops', async () => {
      const person = await addPerson();
      const cookie = cookieNamed(await signIn(scoped, person.email), 'session_token');
      await owner.pool.query(
        `UPDATE sessions SET expires_at = now() + interval '10 hours' WHERE user_id = $1::uuid`,
        [person.id],
      );

      const reply = await call(scoped, 'GET', '/api/me', { cookie: cookie as string });

      expect(reply.status).toBe(200);
      expect(reply.cookies.some((c) => c.includes('session_token'))).toBe(true);
      expectScoped(reply, '/ops');
    });

    it('sets the two factor challenge cookie and the final session cookie on Path=/ops', async () => {
      const person = await addPerson();
      const first = cookieNamed(await signIn(scoped, person.email), 'session_token') as string;
      const enabled = await call(scoped, 'POST', '/api/auth/two-factor/enable', {
        cookie: first,
        body: { password: PASSWORD },
      });
      expect(enabled.status).toBe(200);
      const secret = secretFromUri(enabled.body.totpURI as string);
      const confirmed = await call(scoped, 'POST', '/api/auth/two-factor/verify-totp', {
        cookie: first,
        body: { code: totpCode(secret) },
      });
      expect(confirmed.status).toBe(200);
      expectScoped(confirmed, '/ops');

      const challenge = await signIn(scoped, person.email);
      expect(challenge.body).toMatchObject({ twoFactorRedirect: true });
      const pending = cookieNamed(challenge, 'two_factor');
      expect(pending).toBeDefined();
      expectScoped(challenge, '/ops');

      const done = await call(scoped, 'POST', '/api/auth/two-factor/verify-totp', {
        cookie: pending as string,
        body: { code: totpCode(secret) },
      });
      expect(done.status).toBe(200);
      expect(cookieNamed(done, 'session_token')).toBeDefined();
      expectScoped(done, '/ops');
    });

    it('clears the cookie on sign out with the same path, so the browser drops it', async () => {
      const person = await addPerson();
      const cookie = cookieNamed(await signIn(scoped, person.email), 'session_token') as string;

      const out = await call(scoped, 'POST', '/api/auth/sign-out', { cookie, body: {} });

      expect(out.status).toBe(200);
      const cleared = out.cookies.find((c) => c.includes('session_token'));
      expect(cleared).toBeDefined();
      expect(attribute(cleared as string, 'Max-Age')).toBe('0');
      expectScoped(out, '/ops');
    });
  });

  describe('with no STAFF_BASE_PATH', () => {
    it('sets every cookie host only, on Path=/ (AC-30)', async () => {
      const person = await addPerson();

      const reply = await signIn(plain, person.email);

      expect(reply.status).toBe(200);
      expectScoped(reply, '/');
    });
  });

  describe('with an https PUBLIC_URL (AC-30)', () => {
    /** Every Set-Cookie line is Secure, named with the `__Secure-` prefix, host only, on /ops. */
    function expectSecure(reply: Reply) {
      expectScoped(reply, '/ops');
      for (const cookie of reply.cookies) {
        expect(cookie, cookie).toMatch(/^__Secure-/);
        expect(
          cookie
            .split(';')
            .slice(1)
            .some((part) => part.trim().toLowerCase() === 'secure'),
          cookie,
        ).toBe(true);
      }
    }

    it('sets the session cookie Secure with the __Secure- prefix, host only, on Path=/ops', async () => {
      const person = await addPerson();

      const reply = await signIn(secure, person.email);

      expect(reply.status).toBe(200);
      expect(cookieNamed(reply, '__Secure-better-auth.session_token')).toBeDefined();
      expectSecure(reply);
    });

    it('serves the session and clears it on sign out with the same attributes', async () => {
      const person = await addPerson();
      const cookie = cookieNamed(await signIn(secure, person.email), 'session_token') as string;

      const me = await call(secure, 'GET', '/api/me', { cookie });
      expect(me.status).toBe(200);

      const out = await call(secure, 'POST', '/api/auth/sign-out', { cookie, body: {} });
      expect(out.status).toBe(200);
      const cleared = out.cookies.find((c) => c.includes('session_token'));
      expect(cleared).toBeDefined();
      expect(attribute(cleared as string, 'Max-Age')).toBe('0');
      expectSecure(out);
    });
  });

  describe('the portal host (AC-30)', () => {
    it('answers 404 on every auth route for the portal host when PORTAL_ORIGIN is set', async () => {
      const person = await addPerson();
      const portal = { 'x-forwarded-host': PORTAL_HOST };

      const reply = await signIn(scoped, person.email, portal);
      expect(reply.status).toBe(404);
      expect(reply.cookies).toEqual([]);

      const out = await call(scoped, 'POST', '/api/auth/sign-out', { headers: portal, body: {} });
      expect(out.status).toBe(404);
      const link = await call(scoped, 'GET', '/api/auth/reset-password/some-token', {
        headers: portal,
      });
      expect(link.status).toBe(404);
      const { rows } = await owner.pool.query(`SELECT 1 FROM sessions WHERE user_id = $1::uuid`, [
        person.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('signs in as usual on the staff host of the same api', async () => {
      const person = await addPerson();

      const reply = await signIn(scoped, person.email, {
        'x-forwarded-host': new URL(scoped?.base ?? 'http://x').host,
      });

      expect(reply.status).toBe(200);
      expect(cookieNamed(reply, 'session_token')).toBeDefined();
    });

    it('ignores the portal host when PORTAL_ORIGIN is unset', async () => {
      const person = await addPerson();

      const reply = await signIn(plain, person.email, { 'x-forwarded-host': PORTAL_HOST });

      expect(reply.status).toBe(200);
      expect(cookieNamed(reply, 'session_token')).toBeDefined();
    });
  });
});
