import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type DatabaseConnection } from '../src/index.js';
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
      admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]),
    );
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('Idle database client error')));

    const result = await connection.db.execute(sql`select 2 as two`);
    expect(result.rows).toEqual([{ two: 2 }]);
  });
});
