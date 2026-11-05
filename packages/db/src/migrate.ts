import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Shipped inside this package so the app image always carries the matching migrations. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

// Any stable number works; it only has to be the same for every migrate run.
const MIGRATION_LOCK_ID = 727_001;

/**
 * The role the api and worker connect as when `APP_DB_ROLE` is not set (spec 0002). It is the
 * fallback the baseline rules read when the `ssd.app_role` database setting is missing. The first
 * migration creates the role.
 */
export const APP_ROLE = 'ssdashboard_app';

/**
 * Thrown when `TENANT_ID` is set and differs from the tenant the `install` row already names.
 * `migrate` throws it before it changes anything, so a wrong environment can never re-stamp a
 * database. It must never be caught and ignored.
 */
export class TenantMismatch extends Error {
  /** The tenant id the `install` row holds. */
  readonly installed: string;
  /** The tenant id the caller asked for. */
  readonly requested: string;

  /** Names both ids, so the operator can see which environment is wrong. */
  constructor(installed: string, requested: string) {
    super(
      `TENANT_ID ${requested} does not match this database's install row (${installed}). Nothing was changed.`,
    );
    this.name = 'TenantMismatch';
    this.installed = installed;
    this.requested = requested;
  }
}

/** What a migrate run may be told. Both values only matter on the first run of a database. */
export interface MigrateOptions {
  /** The tenant id for a new install (`TENANT_ID`). Unset: a generated `uuidv7()`. Later runs only check it. */
  tenantId?: string | undefined;
  /** The application role's name for a new install (`APP_DB_ROLE`). Unset: `APP_ROLE`. */
  appRole?: string | undefined;
}

/**
 * Derives the install's `client_code` from the app role name: `ssd_<code>_app` gives `<code>`,
 * anything else gives `dev`. Feature 47 provisioning sets the code and name properly.
 */
function clientCodeFor(appRole: string): string {
  return /^ssd_([a-z0-9_]+)_app$/.exec(appRole)?.[1] ?? 'dev';
}

/** Runs one statement built by the database itself with `format`, so identifiers and literals are quoted by PostgreSQL. */
async function runFormatted(client: pg.Client, template: string, values: string[]): Promise<void> {
  const { rows } = await client.query<{ statement: string }>(
    `SELECT format(${template}) AS statement`,
    values,
  );
  const statement = rows[0]?.statement;
  if (!statement) throw new Error('Could not build a database setting statement');
  await client.query(statement);
}

/**
 * Applies every pending migration while holding a PostgreSQL advisory lock,
 * so two migrate runs against one database can never overlap.
 *
 * First run (no `install` row), in order: set `ssd.tenant_id` and `ssd.app_role` on the database
 * and in this session, apply the migrations, then write the `install` row. Later runs read the
 * tenant from the `install` row and throw `TenantMismatch` if `options.tenantId` differs.
 */
export async function runMigrations(
  connectionString: string,
  options: MigrateOptions = {},
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const installed = await readInstalledTenant(client);
      if (installed) {
        if (options.tenantId && options.tenantId.toLowerCase() !== installed) {
          throw new TenantMismatch(installed, options.tenantId);
        }
        await client.query("SELECT set_config('ssd.tenant_id', $1, false)", [installed]);
        await migrate(drizzle(client), { migrationsFolder });
        return;
      }
      const appRole = options.appRole ?? APP_ROLE;
      const tenantId = options.tenantId?.toLowerCase() ?? (await pendingTenant(client));
      await runFormatted(
        client,
        "'ALTER DATABASE %I SET ssd.tenant_id = %L', current_database(), $1::text",
        [tenantId],
      );
      await runFormatted(
        client,
        "'ALTER DATABASE %I SET ssd.app_role = %L', current_database(), $1::text",
        [appRole],
      );
      // ALTER DATABASE only reaches new sessions, so this one is set by hand.
      await client.query("SELECT set_config('ssd.tenant_id', $1, false)", [tenantId]);
      await client.query("SELECT set_config('ssd.app_role', $1, false)", [appRole]);
      await migrate(drizzle(client), { migrationsFolder });
      const code = clientCodeFor(appRole);
      await client.query(
        'INSERT INTO install (id, client_code, name) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING',
        [tenantId, code],
      );
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}

/** The tenant id in the `install` row, or undefined when the table or the row does not exist yet. */
async function readInstalledTenant(client: pg.Client): Promise<string | undefined> {
  const table = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.install') IS NOT NULL AS present",
  );
  if (!table.rows[0]?.present) return undefined;
  const row = await client.query<{ id: string }>('SELECT id FROM install LIMIT 1');
  return row.rows[0]?.id;
}

/**
 * The tenant id for a first run with no `TENANT_ID`. A earlier run that stopped after migrating
 * but before writing the install row left the tenant in the database setting, so reuse it (the
 * seeded rows already carry it); otherwise generate one.
 */
async function pendingTenant(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT CASE WHEN to_regclass('public.install') IS NOT NULL
                  AND nullif(current_setting('ssd.tenant_id', true), '') IS NOT NULL
                 THEN current_setting('ssd.tenant_id', true)
                 ELSE uuidv7()::text END AS id`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Could not choose a tenant id');
  return id;
}

/**
 * Lets the application role log in with the given password. Runs as the owner role after
 * migrating, so each install sets (or rotates) the password from its own secret. The role is
 * `appRole`, else the `ssd.app_role` database setting, else `APP_ROLE`.
 */
export async function setAppRoleLogin(
  connectionString: string,
  password: string,
  appRole?: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ statement: string }>(
      `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L',
         coalesce($1::text, nullif(current_setting('ssd.app_role', true), ''), $3::text), $2::text) AS statement`,
      [appRole ?? null, password, APP_ROLE],
    );
    const statement = rows[0]?.statement;
    if (!statement) throw new Error('Could not build the application role statement');
    await client.query(statement);
  } finally {
    await client.end();
  }
}
