import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import {
  assertSessionTenant,
  createDatabase,
  runMigrations,
  SessionTenantMismatch,
  type DatabaseConnection,
} from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase, withAdmin } from './database.js';

describe('createDatabase against a real PostgreSQL', () => {
  let name: string;
  let connection: DatabaseConnection;

  beforeEach(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    connection = createDatabase(db.url);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await connection.pool.end();
    await dropScratchDatabase(name);
  });

  it('runs queries through drizzle', async () => {
    const result = await connection.db.execute(sql`select 1 as one`);

    expect(result.rows).toEqual([{ one: 1 }]);
  });

  // Regression: the server closing idle connections (a restart or stop) used to
  // crash the process with an unhandled 'error' event on the pool.
  it('recovers after the server terminates its idle connections', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await connection.db.execute(sql`select 1`);
    expect(connection.pool.idleCount).toBe(1);

    await withAdmin((admin) =>
      admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
        name,
      ]),
    );
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Idle database client error')),
    );

    const result = await connection.db.execute(sql`select 2 as two`);
    expect(result.rows).toEqual([{ two: 2 }]);
  });
});

// Security review S3 (a): the api and worker stop at start when the tenant their sessions would
// stamp on new rows is not the install's tenant.
describe('assertSessionTenant', () => {
  let name: string;
  let url: string;

  beforeEach(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    await runMigrations(url);
  });

  afterEach(async () => {
    await dropScratchDatabase(name);
  });

  /** A pool whose sessions start with the given ssd.tenant_id, like a forged role setting would. */
  function poolWith(tenant?: string): pg.Pool {
    const options = tenant === undefined ? undefined : `-c ssd.tenant_id=${tenant}`;
    return new pg.Pool({ connectionString: url, max: 1, options });
  }

  it('passes when the session tenant is the install row', async () => {
    const pool = poolWith();
    try {
      await assertSessionTenant(pool);
    } finally {
      await pool.end();
    }
  });

  it.each([
    ['another tenant', '01a1b120-0000-7000-8000-00000000beef'],
    ['an empty setting', ''],
  ])('throws SessionTenantMismatch for %s', async (_case, tenant) => {
    const pool = poolWith(tenant);
    try {
      const failure = await assertSessionTenant(pool).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SessionTenantMismatch);
      expect((failure as SessionTenantMismatch).session).toBe(tenant === '' ? null : tenant);
    } finally {
      await pool.end();
    }
  });

  // Security review S10: with onTenantMismatch, every new connection of the pool checks its
  // tenant before it serves a query, so a database that was unreachable at start (when the start
  // check could only log) is still checked before anything is written.
  describe('the per connection check of createDatabase', () => {
    function urlWith(tenant: string): string {
      const forged = new URL(url);
      forged.searchParams.set('options', `-c ssd.tenant_id=${tenant}`);
      return forged.toString();
    }

    it('refuses the first query on a connection whose tenant is not the install row, and calls the handler', async () => {
      const onTenantMismatch = vi.fn();
      const connection = createDatabase(urlWith('01a1b120-0000-7000-8000-00000000beef'), {
        onTenantMismatch,
      });
      try {
        // Drizzle wraps the error ("Failed query"); the pool's own error is the cause.
        const failure = await connection.db.execute(sql`select 1`).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect((failure as Error | undefined)?.cause).toBeInstanceOf(SessionTenantMismatch);
        expect(onTenantMismatch).toHaveBeenCalledTimes(1);
        expect(onTenantMismatch.mock.calls[0]?.[0]).toBeInstanceOf(SessionTenantMismatch);
        expect(connection.pool.totalCount).toBe(0);
      } finally {
        await connection.pool.end();
      }
    });

    it('serves queries on connections whose tenant is the install row', async () => {
      const onTenantMismatch = vi.fn();
      const connection = createDatabase(url, { onTenantMismatch, max: 2 });
      try {
        const [first, second] = await Promise.all([
          connection.db.execute(sql`select 1 as one`),
          connection.db.execute(sql`select 2 as two`),
        ]);
        expect(first.rows).toEqual([{ one: 1 }]);
        expect(second.rows).toEqual([{ two: 2 }]);
        expect(onTenantMismatch).not.toHaveBeenCalled();
      } finally {
        await connection.pool.end();
      }
    });
  });
});
