import { randomBytes } from 'node:crypto';
import { HealthResponse } from '@ssdashboard/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  devDatabaseUrl,
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
    expect(HealthResponse.parse(await response.json())).toEqual({ status: 'ok', version: '9.9.9', database: 'up' });
  });

  it('serves routes only under the /api prefix that Caddy forwards', async () => {
    const base = await startApi({ DATABASE_URL: devDatabaseUrl() });

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(404);
  });

  it('starts and reports degraded when the database is unreachable', async () => {
    const base = await startApi({ DATABASE_URL: UNREACHABLE_DB });

    const body = await (await fetch(`${base}/api/health`)).json();

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
      admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [tag]),
    );
    expect(terminated.rowCount).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(api?.child.exitCode).toBeNull();
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body).toMatchObject({ status: 'ok', database: 'up' });
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
