import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

/** The typed Drizzle handle over the full schema, used by every module's repositories. */
export type Database = NodePgDatabase<typeof schema>;

/** A Drizzle handle plus the pool behind it, so the owner of the connection can close it. */
export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
}

/** Opens a pooled connection for the given URL. The api and worker pass the app role URL; only migrate uses the owner URL. */
export function createDatabase(
  connectionString: string,
  options: { max?: number } = {},
): DatabaseConnection {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // An idle client loses its connection when PostgreSQL restarts or goes away. The pool already
  // discards that client; without a listener the 'error' event would crash the process.
  pool.on('error', (error) => {
    console.error(`Idle database client error: ${error.message}`);
  });
  return { db: drizzle(pool, { schema }), pool };
}
