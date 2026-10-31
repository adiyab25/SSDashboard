import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
}

export function createDatabase(connectionString: string, options: { max?: number } = {}): DatabaseConnection {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // An idle client loses its connection when PostgreSQL restarts or goes away. The pool already
  // discards that client; without a listener the 'error' event would crash the process.
  pool.on('error', (error) => {
    console.error(`Idle database client error: ${error.message}`);
  });
  return { db: drizzle(pool, { schema }), pool };
}
