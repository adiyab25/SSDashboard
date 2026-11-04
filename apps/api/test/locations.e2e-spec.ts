import { LocationListResponse } from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  signInAs,
  start,
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

// Spec 0003, AC-10: GET /api/locations, served by the built api against PostgreSQL.
describe('GET /api/locations', { timeout: 60_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let api: RunningProcess | undefined;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 2 });
    await owner.pool.query(
      `INSERT INTO locations (code, name, type, archived_at) VALUES
        ('WH-B', '{"en": "Back store"}', 'warehouse', NULL),
        ('SR-1', '{"ar": "صالة العرض"}', 'showroom', NULL),
        ('WH-a', '{"en": "Annex"}', 'warehouse', NULL),
        ('WH-A', '{"en": "Main warehouse", "ar": "المخزن"}', 'warehouse', NULL),
        ('TR-1', '{"en": "In transit"}', 'transit', NULL),
        ('VR-1', '{"en": "Adjustments"}', 'virtual', NULL),
        ('WH-OLD', '{"en": "Closed"}', 'warehouse', now())`,
    );
    const appUrl = new URL(scratch.url);
    // Connect as the application role, exactly as the api does in an install.
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
    });
    await waitForHttp(`${base}/api/health`, api);
    cookie = await signInAs(base, owner.pool);
  });

  afterAll(async () => {
    await stop(api);
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  async function list(query = '') {
    const response = await fetch(`${base}/api/locations${query}`, { headers: { cookie } });
    return { status: response.status, body: (await response.json()) as unknown };
  }

  it('lists active warehouses and showrooms by code, never transit, virtual, or archived', async () => {
    const { status, body } = await list();

    expect(status).toBe(200);
    const page = LocationListResponse.parse(body);
    // "C" collation: byte order, so upper case sorts before lower case.
    expect(page.items.map((item) => item.code)).toEqual(['SR-1', 'WH-A', 'WH-B', 'WH-a']);
    expect(page.items[1]).toMatchObject({
      name: { en: 'Main warehouse', ar: 'المخزن' },
      type: 'warehouse',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('walks every row exactly once one page at a time', async () => {
    const codes: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const page = LocationListResponse.parse((await list(query)).body);
      expect(page.items.length).toBeLessThanOrEqual(1);
      codes.push(...page.items.map((item) => item.code));
      cursor = page.nextCursor;
    } while (cursor);

    expect(codes).toEqual(['SR-1', 'WH-A', 'WH-B', 'WH-a']);
  });

  it('answers 400 INVALID_QUERY for a cursor that does not decode', async () => {
    const { status, body } = await list('?cursor=not*a*cursor');

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_QUERY' });
  });

  it('answers 400 INVALID_QUERY for a limit out of range', async () => {
    const { status, body } = await list('?limit=500');

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_QUERY' });
  });
});
