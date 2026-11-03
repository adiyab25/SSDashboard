import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Shipped inside this package so the app image always carries the matching migrations. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

// Any stable number works; it only has to be the same for every migrate run.
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies every pending migration while holding a PostgreSQL advisory lock,
 * so two migrate runs against one database can never overlap.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}

/** The role the api and worker connect as (spec 0002). The core data model migration creates it. */
export const APP_ROLE = 'ssdashboard_app';

/**
 * Lets the application role log in with the given password. Runs as the owner role after
 * migrating, so each install sets (or rotates) the password from its own secret.
 */
export async function setAppRoleLogin(connectionString: string, password: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ statement: string }>(
      "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement",
      [APP_ROLE, password],
    );
    const statement = rows[0]?.statement;
    if (!statement) throw new Error('Could not build the application role statement');
    await client.query(statement);
  } finally {
    await client.end();
  }
}
