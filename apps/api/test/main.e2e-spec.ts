import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { HealthResponse } from '@ssdashboard/contracts';
import { runMigrations } from '@ssdashboard/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  devDatabaseUrl,
  dropScratchDatabase,
  freePort,
  run,
  start,
  stop,
  UNREACHABLE_DB,
  waitForHttp,
  withAdmin,
  type RunningProcess,
} from './support.js';

/** The dev database URL tagged with an application name, so a test can find its own connections. */
function taggedDatabaseUrl(tag: string): string {
  const url = new URL(devDatabaseUrl());
  url.searchParams.set('application_name', tag);
  return url.toString();
}

describe('api entry point (dist/main.js)', { timeout: 30_000 }, () => {
  let api: RunningProcess | undefined;

  afterEach(async () => {
    await stop(api);
    api = undefined;
  });

  async function startApi(env: Record<string, string>): Promise<string> {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    api = start('main.js', { PORT: String(port), ...env });
    await waitForHttp(`${base}/api/health`, api);
    return base;
  }

  it('serves GET /api/health with the release version from APP_VERSION', async () => {
    const base = await startApi({ DATABASE_URL: devDatabaseUrl(), APP_VERSION: '9.9.9' });

    const response = await fetch(`${base}/api/health`);

    expect(response.status).toBe(200);
    expect(HealthResponse.parse(await response.json())).toEqual({
      status: 'ok',
      version: '9.9.9',
      database: 'up',
    });
  });

  it('keeps an idle connection open longer than the proxies in front of it do', async () => {
    const base = await startApi({ DATABASE_URL: devDatabaseUrl() });

    // node:http, not fetch: the Keep-Alive header is what the server tells every client.
    const keepAlive = await new Promise<string | string[] | undefined>((resolve, reject) => {
      get(`${base}/api/health`, (response) => {
        response.resume();
        resolve(response.headers['keep-alive']);
      }).on('error', reject);
    });

    // Caddy keeps an idle upstream connection for 2 minutes; the api must outlast it (130 s).
    expect(keepAlive).toBe('timeout=130');
  });

  it('serves routes only under the /api prefix that Caddy forwards', async () => {
    const base = await startApi({ DATABASE_URL: devDatabaseUrl() });

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(404);
  });

  it('starts and reports degraded when the database is unreachable', async () => {
    const base = await startApi({ DATABASE_URL: UNREACHABLE_DB });

    const body: unknown = await (await fetch(`${base}/api/health`)).json();

    expect(body).toMatchObject({ status: 'degraded', database: 'down' });
    expect(api?.child.exitCode).toBeNull();
  });

  // Regression: PostgreSQL closing the pool's idle connections (a restart or stop)
  // used to crash the api with an unhandled 'error' event instead of degrading.
  it('keeps running and recovers when PostgreSQL drops its connections', async () => {
    const tag = `ssd_e2e_${randomBytes(4).toString('hex')}`;
    const base = await startApi({ DATABASE_URL: taggedDatabaseUrl(tag) });
    await fetch(`${base}/api/health`);

    const terminated = await withAdmin((admin) =>
      admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
        [tag],
      ),
    );
    expect(terminated.rowCount).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(api?.child.exitCode).toBeNull();
    const body: unknown = await (await fetch(`${base}/api/health`)).json();
    expect(body).toMatchObject({ status: 'ok', database: 'up' });
  });

  // Security review S3 (a): a role setting beats the database's ssd.tenant_id, so a forged one would
  // stamp every new row with another tenant. The api stops before it listens.
  it('refuses to start when its sessions would stamp another tenant than the install row', async () => {
    const scratch = await createScratchDatabase();
    try {
      await runMigrations(scratch.url);
      const appUrl = new URL(devDatabaseUrl());
      appUrl.pathname = `/${scratch.name}`;
      await withAdmin((admin) =>
        admin.query(
          `ALTER ROLE "${decodeURIComponent(appUrl.username)}" IN DATABASE ${scratch.name}
             SET ssd.tenant_id = '01a1b120-0000-7000-8000-00000000beef'`,
        ),
      );

      const result = await run('main.js', {
        DATABASE_URL: appUrl.toString(),
        PORT: String(await freePort()),
      });

      expect(result.code).not.toBe(0);
      expect(result.output).toContain('SessionTenantMismatch');

      // The worker imports the same DatabaseModule and stops the same way.
      const worker = await run('worker.js', { DATABASE_URL: appUrl.toString() });
      expect(worker.code).not.toBe(0);
      expect(worker.output).toContain('SessionTenantMismatch');
      expect(worker.output).not.toContain('Worker started.');
    } finally {
      // Dropping the database also drops the role setting scoped to it.
      await dropScratchDatabase(scratch.name);
    }
  });

  // Security review S10: the start check runs once. A mismatch that appears later (or a database
  // that was unreachable at start) is caught by the pool, which checks every new connection before
  // it serves a query, and the api stops.
  it('stops when a connection opened after start would stamp another tenant', async () => {
    const scratch = await createScratchDatabase();
    try {
      await runMigrations(scratch.url);
      const appUrl = new URL(devDatabaseUrl());
      appUrl.pathname = `/${scratch.name}`;
      const base = await startApi({ DATABASE_URL: appUrl.toString() });
      const healthy: unknown = await (await fetch(`${base}/api/health`)).json();
      expect(healthy).toMatchObject({ status: 'ok', database: 'up' });

      await withAdmin(async (admin) => {
        await admin.query(
          `ALTER ROLE "${decodeURIComponent(appUrl.username)}" IN DATABASE ${scratch.name}
             SET ssd.tenant_id = '01a1b120-0000-7000-8000-00000000beef'`,
        );
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          [scratch.name],
        );
      });
      // The probe needs a new connection; the pool checks it and the api stops before answering
      // from the database. A probe that still meets a dropped idle connection answers degraded,
      // so it asks again until the process is gone.
      for (let attempt = 0; attempt < 20 && api?.child.exitCode === null; attempt += 1) {
        await fetch(`${base}/api/health`).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      expect(await api?.exited).toBe(1);
      expect(api?.output()).toContain('SessionTenantMismatch');
    } finally {
      await dropScratchDatabase(scratch.name);
    }
  });

  it('refuses to start without DATABASE_URL and names it', async () => {
    const result = await run('main.js', {});

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment[\s\S]*DATABASE_URL/);
  });

  it('refuses to start when a listed extension is not installed', async () => {
    const port = await freePort();

    const result = await run('main.js', {
      DATABASE_URL: devDatabaseUrl(),
      PORT: String(port),
      EXTENSIONS: '@ssdashboard/no-such-extension',
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('@ssdashboard/no-such-extension');
  });
});
