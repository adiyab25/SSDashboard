import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type DatabaseConnection } from '../src/index.js';

// pg.Pool connects lazily, so no database is needed to build one.
const URL = 'postgres://user:pass@127.0.0.1:1/none';

describe('createDatabase', () => {
  let connection: DatabaseConnection | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await connection?.pool.end();
    connection = undefined;
  });

  it('returns a drizzle database and the pool behind it', () => {
    connection = createDatabase(URL);

    expect(typeof connection.db.execute).toBe('function');
    expect(connection.pool.totalCount).toBe(0);
  });

  it('caps the pool at 10 connections by default', () => {
    connection = createDatabase(URL);

    expect(connection.pool.options.max).toBe(10);
  });

  it('uses the max connections it is given', () => {
    connection = createDatabase(URL, { max: 2 });

    expect(connection.pool.options.max).toBe(2);
  });

  // Regression: without a listener, an idle client losing its connection
  // (PostgreSQL restarted or stopped) emitted an unhandled 'error' and killed the api.
  it('survives an error emitted by an idle client instead of crashing the process', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    connection = createDatabase(URL);
    const pool = connection.pool;

    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
  });

  it('logs the idle client error message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    connection = createDatabase(URL);

    connection.pool.emit('error', new Error('terminating connection due to administrator command'));

    expect(log).toHaveBeenCalledWith(
      'Idle database client error: terminating connection due to administrator command',
    );
  });
});
