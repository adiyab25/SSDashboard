import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Shipped inside this package so the app image always carries the matching migrations. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * The advisory lock every migrate run holds while it works. Any stable number works; it only has
 * to be the same for every run. Exported so a test can hold it to line runs up behind it.
 */
export const MIGRATION_LOCK_ID = 727_001;

/**
 * The role the api and worker connect as when `APP_DB_ROLE` is not set (spec 0002). It is the
 * fallback the baseline rules read when the `ssd.app_role` database setting is missing. The first
 * migration creates the role.
 */
export const APP_ROLE = 'ssdashboard_app';

/**
 * Thrown when `TENANT_ID` is set and differs from the tenant the database already names, in its
 * `install` row or (after an interrupted first run) in the `ssd.tenant_id` setting. `migrate`
 * throws it before it changes anything, so a wrong environment can never re-stamp a database. It
 * must never be caught and ignored.
 */
export class TenantMismatch extends Error {
  /** The tenant id the database holds. */
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

/**
 * Thrown when `APP_DB_ROLE` is set and differs from the role the database already stores in its
 * `ssd.app_role` setting. Like `TenantMismatch`, `migrate` throws it before it changes anything,
 * so a wrong environment can never reset another role's password. It names role names only.
 */
export class AppRoleMismatch extends Error {
  /** The role the database stores. */
  readonly stored: string;
  /** The role the caller asked for. */
  readonly requested: string;

  /** Names both roles, so the operator can see which environment is wrong. */
  constructor(stored: string, requested: string) {
    super(
      `APP_DB_ROLE ${requested} does not match this database's application role (${stored}). Nothing was changed.`,
    );
    this.name = 'AppRoleMismatch';
    this.stored = stored;
    this.requested = requested;
  }
}

/**
 * Thrown when the application role is one that must never serve the api: a superuser, a role that
 * can create roles, bypass row security, or replicate, the role `migrate` itself connects as or a
 * role holding its privileges, a member of any role, or a role whose own settings set `ssd.*` or
 * `search_path`. The check runs before anything changes, on every run, because `migrate` sets
 * this role's password. Its message names parameters and roles, never a setting's value.
 */
export class UnsafeAppRole extends Error {
  /** The refused role name. */
  readonly role: string;

  /** Says which role was refused and why, without any secret. */
  constructor(role: string, reason: string) {
    super(`The application role ${role} is refused: ${reason}. Nothing was changed.`);
    this.name = 'UnsafeAppRole';
    this.role = role;
  }
}

/**
 * What a migrate run may be told. `tenantId` and `appRole` name a new install; a database that
 * already has them only checks the values, and a different one throws `TenantMismatch` or
 * `AppRoleMismatch`. An empty string counts as absent.
 */
export interface MigrateOptions {
  /** The tenant id for a new install (`TENANT_ID`). Unset: a generated `uuidv7()`. */
  tenantId?: string | undefined;
  /** The application role's name for a new install (`APP_DB_ROLE`). Unset: the stored role, else `APP_ROLE`. */
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
 * The tenant and the app role are stored once, as the `ssd.tenant_id` and `ssd.app_role` database
 * settings, and checked on every later run: a different `TENANT_ID` throws `TenantMismatch`, a
 * different `APP_DB_ROLE` throws `AppRoleMismatch`, and a privileged role throws `UnsafeAppRole`,
 * all before anything changes; so does a database setting that names another tenant than the
 * `install` row. Order: checks, set either setting where it is missing (a new database, or one whose
 * setting was reset or lost in a restore: the tenant comes from the `install` row, the role from
 * the `pgboss` schema owner) and both in this session, apply the migrations, write the `install`
 * row if it is missing, then seed the per order cost rules a new install starts with
 * (`seedOrderCostRules`).
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
      const requestedTenant = options.tenantId?.trim().toLowerCase() || undefined;
      const requestedRole = options.appRole?.trim() || undefined;
      const installed = await readInstalledTenant(client);
      const settingTenant = await tenantSetting(client);
      // A database setting that names another tenant than the install row is never overwritten.
      if (installed && settingTenant && settingTenant !== installed) {
        throw new TenantMismatch(installed, settingTenant);
      }
      // An interrupted first run (migrated, install row not written yet) left the tenant in the
      // database setting and stamped it on the seeded rows, so that setting counts as installed.
      const storedTenant = installed ?? settingTenant;
      if (storedTenant && requestedTenant && requestedTenant !== storedTenant) {
        throw new TenantMismatch(storedTenant, requestedTenant);
      }
      const settingRole = await roleSetting(client);
      // With the setting cleared, the baseline still names the role: it owns the pgboss schema.
      const storedRole = settingRole ?? (await baselineAppRole(client));
      if (storedRole && requestedRole && requestedRole !== storedRole) {
        throw new AppRoleMismatch(storedRole, requestedRole);
      }
      const appRole = storedRole ?? requestedRole ?? APP_ROLE;
      await assertSafeAppRole(client, appRole);
      const tenantId = storedTenant ?? requestedTenant ?? (await generatedTenant(client));
      // Both settings are (re)asserted on every run where they are missing: a first run stores
      // them, and a later run restores a setting someone reset or a restore left out, from the
      // install row and the role the baseline names. Each is written only when absent.
      if (!settingTenant) {
        await runFormatted(
          client,
          "'ALTER DATABASE %I SET ssd.tenant_id = %L', current_database(), $1::text",
          [tenantId],
        );
      }
      // TODO(feature 26): refuse a role that already exists on a first run unless the host
      // bootstrap created it on purpose. Dev and test servers share ssdashboard_app across
      // databases today, so only the privileged roles are refused.
      if (!settingRole) {
        await runFormatted(
          client,
          "'ALTER DATABASE %I SET ssd.app_role = %L', current_database(), $1::text",
          [appRole],
        );
      }
      // ALTER DATABASE only reaches new sessions, so this one is set by hand.
      await client.query("SELECT set_config('ssd.tenant_id', $1, false)", [tenantId]);
      await client.query("SELECT set_config('ssd.app_role', $1, false)", [appRole]);
      await migrate(drizzle(client), { migrationsFolder });
      if (!installed) {
        await client.query(
          'INSERT INTO install (id, client_code, name) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING',
          [tenantId, clientCodeFor(appRole)],
        );
      }
      await seedOrderCostRules(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Seeds one `not_set` row per kind of `order_cost_rules` (spec 0002, catalog child, AC-32), from
 * the install's operating day, so a new install reads "not set", never 0. Runs after the `install`
 * row on every migrate, and adds a row only for a kind that has none: a rerun adds nothing and a
 * rule someone set is never touched (the table is append only).
 */
async function seedOrderCostRules(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO order_cost_rules (kind, status, effective_from)
     SELECT k.kind, 'not_set', ssd_operating_day(now())
     FROM unnest(enum_range(NULL::order_cost_rule_kind)) AS k(kind)
     WHERE NOT EXISTS (SELECT 1 FROM order_cost_rules r WHERE r.kind = k.kind)
     ORDER BY k.kind`,
  );
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
 * A database-level setting, read from the catalog. `current_setting` would not do: it is fixed
 * when the session connects, so a run that connected before another run's `ALTER DATABASE` would
 * not see what that run stored once it gets the advisory lock.
 */
async function databaseSetting(client: pg.Client, name: string): Promise<string | undefined> {
  const { rows } = await client.query<{ value: string | null }>(
    `SELECT substr(s, length($1::text) + 2) AS value
     FROM pg_db_role_setting, unnest(setconfig) AS s
     WHERE setrole = 0
       AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND split_part(s, '=', 1) = $1::text`,
    [name],
  );
  return rows[0]?.value || undefined;
}

/** Whether the baseline tables exist, which means the first run's migrations committed. */
async function baselineApplied(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.install') IS NOT NULL AS present",
  );
  return rows[0]?.present === true;
}

/**
 * The tenant in the `ssd.tenant_id` database setting, once the baseline tables exist: the
 * migrations ran (they are one transaction), so the seeded rows already carry it. Before that the
 * setting is leftover from a failed first run and is not stored. Otherwise undefined.
 */
async function tenantSetting(client: pg.Client): Promise<string | undefined> {
  if (!(await baselineApplied(client))) return undefined;
  return (await databaseSetting(client, 'ssd.tenant_id'))?.toLowerCase();
}

/**
 * The application role the database stores in `ssd.app_role`, once the baseline tables exist
 * (the same rule as the tenant), so a first run that failed before its migrations committed can be
 * rerun with a corrected `APP_DB_ROLE`. Undefined on a new database.
 */
async function roleSetting(client: pg.Client): Promise<string | undefined> {
  if (!(await baselineApplied(client))) return undefined;
  return databaseSetting(client, 'ssd.app_role');
}

/**
 * The application role the baseline was applied for, read from the owner of the `pgboss` schema
 * (`0002_baseline_rules.sql` creates it `AUTHORIZATION` the app role), once the baseline exists.
 * Used only when the `ssd.app_role` setting is missing, so a cleared setting is restored to the
 * role the grants name, never to the default. Undefined on a new database.
 */
async function baselineAppRole(client: pg.Client): Promise<string | undefined> {
  if (!(await baselineApplied(client))) return undefined;
  const { rows } = await client.query<{ role: string }>(
    `SELECT r.rolname AS role FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
     WHERE n.nspname = 'pgboss'`,
  );
  return rows[0]?.role;
}

/** A new tenant id for a first run with no `TENANT_ID`. */
async function generatedTenant(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>('SELECT uuidv7()::text AS id');
  const id = rows[0]?.id;
  if (!id) throw new Error('Could not choose a tenant id');
  return id;
}

/**
 * Refuses an application role that is a superuser, can create roles, bypasses row security, can
 * replicate, is the role this connection runs as, holds the privileges of that role, or is a
 * member of any role at all (a member of `pg_write_all_data` writes every table, so the revokes on
 * the history tables would mean nothing). It also refuses a role whose own settings, for every
 * database or this one, set `ssd.*` or `search_path` (security review S3): role settings beat the
 * database settings `migrate` stores, so they could swap the tenant or hide a table. It refuses
 * rather than resets, so an operator sees the change. Runs on every run and before the login is
 * set. A role that does not exist yet is fine: the baseline creates it.
 */
async function assertSafeAppRole(client: pg.Client, role: string): Promise<void> {
  const { rows } = await client.query<{
    super: boolean;
    createrole: boolean;
    bypassrls: boolean;
    replication: boolean;
    self: boolean;
    inheritsOwner: boolean;
    memberOf: string | null;
    settings: string | null;
  }>(
    `SELECT r.rolsuper AS super, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls,
            r.rolreplication AS replication, r.rolname = current_user AS self,
            pg_has_role(r.oid, current_user, 'USAGE') AS "inheritsOwner",
            (SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname)
               FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
              WHERE m.member = r.oid) AS "memberOf",
            (SELECT string_agg(DISTINCT split_part(c, '=', 1), ', ')
               FROM pg_db_role_setting s, unnest(s.setconfig) AS c
              WHERE s.setrole = r.oid
                AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                AND (split_part(c, '=', 1) LIKE 'ssd.%' OR split_part(c, '=', 1) = 'search_path')
            ) AS settings
     FROM pg_roles r WHERE r.rolname = $1`,
    [role],
  );
  const found = rows[0];
  if (!found) return;
  if (found.self) throw new UnsafeAppRole(role, 'it is the role migrate connects as');
  if (found.super) throw new UnsafeAppRole(role, 'it is a superuser');
  if (found.createrole) throw new UnsafeAppRole(role, 'it can create roles');
  if (found.bypassrls) throw new UnsafeAppRole(role, 'it bypasses row security');
  if (found.replication) throw new UnsafeAppRole(role, 'it can replicate');
  if (found.inheritsOwner) {
    throw new UnsafeAppRole(role, 'it holds the privileges of the role migrate connects as');
  }
  if (found.memberOf) throw new UnsafeAppRole(role, `it is a member of ${found.memberOf}`);
  if (found.settings) {
    throw new UnsafeAppRole(
      role,
      `its own role settings set ${found.settings}; remove them with ALTER ROLE ... RESET`,
    );
  }
}

/**
 * Lets the application role log in with the given password. Runs as the owner role after
 * migrating, so each install sets (or rotates) the password from its own secret. The role is the
 * `ssd.app_role` database setting `runMigrations` stored, else `APP_ROLE`; an `appRole` that
 * differs from the stored one throws `AppRoleMismatch`, and a privileged role throws
 * `UnsafeAppRole`.
 */
export async function setAppRoleLogin(
  connectionString: string,
  password: string,
  appRole?: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const stored = await roleSetting(client);
    if (appRole && stored && appRole !== stored) throw new AppRoleMismatch(stored, appRole);
    const role = appRole ?? stored ?? APP_ROLE;
    await assertSafeAppRole(client, role);
    const { rows } = await client.query<{ statement: string }>(
      `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement`,
      [role, password],
    );
    const statement = rows[0]?.statement;
    if (!statement) throw new Error('Could not build the application role statement');
    await client.query(statement);
  } finally {
    await client.end();
  }
}
