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
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

const EMAIL = 'leak.check@example.com';
const PASSWORD = 'Correct-Horse-1';

// Better Auth routes run outside the Nest filter. A failed query there must reach the log as its
// pg code only: never the SQL, the params (the email), or the raw error.
describe('Better Auth failures in the log', { timeout: 120_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    const { rows } = await owner.pool.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES ('Leak Check', $1) RETURNING id`,
      [EMAIL],
    );
    await giveHats(owner.pool, rows[0]?.id as string, 'staff');
    await owner.pool.query(
      `INSERT INTO accounts (user_id, provider_id, account_id, password)
       VALUES ($1::uuid, 'credential', $1::text, $2)`,
      [rows[0]?.id, await hashPassword(PASSWORD)],
    );
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    });
    await waitForHttp(`${base}/api/health`, api);
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  const signIn = () =>
    fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });

  /** The log written since `from`, once it holds `line`. */
  const logAfter = (from: number, line: string) =>
    eventually(
      () => {
        const text = api?.output().slice(from) ?? '';
        return text.includes(line) ? text : undefined;
      },
      { what: line, timeoutMs: 10_000 },
    );

  it('signs in while the database is healthy', async () => {
    expect((await signIn()).status).toBe(200);
  });

  it('logs a failed query inside a Better Auth route by its pg code, without the email', async () => {
    const from = api?.output().length ?? 0;
    await owner.pool.query('ALTER TABLE users RENAME COLUMN email TO email_moved');
    try {
      const response = await signIn();
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('');

      const text = await logAfter(
        from,
        'POST /sign-in/email failed: FailedQueryError: Failed query (pg 42703)',
      );
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain('params');
      expect(text).not.toContain('email_moved');
      expect(text).not.toContain('SERVER_ERROR');
    } finally {
      await owner.pool.query('ALTER TABLE users RENAME COLUMN email_moved TO email');
    }
  });

  it('logs a failed query before the route runs (the rate limit) the same way', async () => {
    const from = api?.output().length ?? 0;
    await owner.pool.query('ALTER TABLE rate_limits RENAME TO rate_limits_moved');
    try {
      const response = await signIn();
      expect(response.status).toBe(500);

      const text = await logAfter(
        from,
        'POST /sign-in/email failed: FailedQueryError: Failed query (pg 42P01)',
      );
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain('rate_limits');
    } finally {
      await owner.pool.query('ALTER TABLE rate_limits_moved RENAME TO rate_limits');
    }
  });

  it('signs in again once the database is healthy', async () => {
    expect((await signIn()).status).toBe(200);
  });
});
