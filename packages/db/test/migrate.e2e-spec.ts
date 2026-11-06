import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppRoleMismatch,
  MIGRATION_LOCK_ID,
  runMigrations,
  setAppRoleLogin,
  TenantMismatch,
  UnsafeAppRole,
} from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase, withAdmin } from './database.js';

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

// Every migration in the journal, so adding one never makes this file stale.
const shipped = (
  JSON.parse(
    readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: unknown[] }
).entries.length;

const countMigrations = async (url: string) =>
  (await query<{ count: string }>(url, 'SELECT count(*) FROM drizzle.__drizzle_migrations'))[0]
    ?.count;

describe('runMigrations', () => {
  const scratch: string[] = [];

  async function freshDatabase(): Promise<string> {
    const db = await createScratchDatabase();
    scratch.push(db.name);
    return db.url;
  }

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dropScratchDatabase));
  });

  it('enables the pg_trgm, unaccent, and btree_gist extensions on an empty database', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    const extensions = await query<{ extname: string }>(url, 'SELECT extname FROM pg_extension');
    expect(extensions.map((row) => row.extname)).toEqual(
      expect.arrayContaining(['pg_trgm', 'unaccent', 'btree_gist']),
    );
  });

  it('records each applied migration once', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    expect(await countMigrations(url)).toBe(String(shipped));
  });

  it('does nothing when run again on an up to date database', async () => {
    const url = await freshDatabase();
    await runMigrations(url);

    await runMigrations(url);

    expect(await countMigrations(url)).toBe(String(shipped));
  });

  // Two installs' migrate containers (or a retry) must never apply the same migration twice.
  it('lets concurrent runs finish without applying a migration twice', async () => {
    const url = await freshDatabase();

    await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);

    expect(await countMigrations(url)).toBe(String(shipped));
  });

  it('releases the advisory lock when it finishes', async () => {
    const url = await freshDatabase();

    await runMigrations(url);

    const locks = await query(url, "SELECT 1 FROM pg_locks WHERE locktype = 'advisory'");
    expect(locks).toHaveLength(0);
  });

  // AC-16 (spec 0002, A2): the first run names the tenant and the app role, and writes the install row.
  describe('the install (AC-16)', () => {
    const databaseSettings = async (url: string) =>
      (
        await query<{ setting: string }>(
          url,
          `SELECT unnest(setconfig) AS setting FROM pg_db_role_setting
            WHERE setrole = 0 AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
            ORDER BY 1`,
        )
      ).map((row) => row.setting);
    const installRows = (url: string) =>
      query<{ id: string; client_code: string; name: string; created_at: Date }>(
        url,
        'SELECT id, client_code, name, created_at FROM install',
      );

    it('generates a tenant id, sets both database settings, and writes the install row', async () => {
      const url = await freshDatabase();

      await runMigrations(url);

      const rows = await installRows(url);
      expect(rows).toHaveLength(1);
      const id = rows[0]?.id ?? '';
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(rows[0]).toMatchObject({ client_code: 'dev', name: 'dev' });
      expect(await databaseSettings(url)).toEqual([
        'ssd.app_role=ssdashboard_app',
        `ssd.tenant_id=${id}`,
      ]);
    });

    it('stamps the given TENANT_ID on the install row and the seeded rows', async () => {
      const url = await freshDatabase();
      const tenant = '0192f7a0-0000-7000-8000-0000000000aa';

      await runMigrations(url, { tenantId: tenant });

      expect((await installRows(url)).map((row) => row.id)).toEqual([tenant]);
      const seeded = await query<{ tenant_id: string }>(
        url,
        'SELECT DISTINCT tenant_id FROM settings',
      );
      expect(seeded).toEqual([{ tenant_id: tenant }]);
    });

    it('changes nothing on a rerun, with or without the same TENANT_ID', async () => {
      const url = await freshDatabase();
      const tenant = '0192f7a0-0000-7000-8000-0000000000bb';
      await runMigrations(url, { tenantId: tenant });
      const before = {
        install: await installRows(url),
        settings: await databaseSettings(url),
        history: await query(
          url,
          'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
        ),
      };

      await runMigrations(url);
      await runMigrations(url, { tenantId: tenant });

      expect({
        install: await installRows(url),
        settings: await databaseSettings(url),
        history: await query(
          url,
          'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
        ),
      }).toEqual(before);
    });

    it('stops with TenantMismatch, changing nothing, when TENANT_ID differs from the install row', async () => {
      const url = await freshDatabase();
      await runMigrations(url, { tenantId: '0192f7a0-0000-7000-8000-0000000000cc' });
      const before = {
        install: await installRows(url),
        settings: await databaseSettings(url),
        history: await countMigrations(url),
      };

      await expect(
        runMigrations(url, { tenantId: '0192f7a0-0000-7000-8000-0000000000dd' }),
      ).rejects.toBeInstanceOf(TenantMismatch);

      expect({
        install: await installRows(url),
        settings: await databaseSettings(url),
        history: await countMigrations(url),
      }).toEqual(before);
    });

    it('treats a tenant left in the database setting as installed after an interrupted first run', async () => {
      const url = await freshDatabase();
      const first = '0192f7a0-0000-7000-8000-0000000000e1';
      await runMigrations(url, { tenantId: first });
      // Simulate the crash between the migrations and the install insert: the owner removes the row.
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query('DELETE FROM install');
      } finally {
        await client.end();
      }

      await expect(
        runMigrations(url, { tenantId: '0192f7a0-0000-7000-8000-0000000000e2' }),
      ).rejects.toBeInstanceOf(TenantMismatch);
      expect(await installRows(url)).toHaveLength(0);

      // Without TENANT_ID, or with the same one, the setting wins and the row comes back.
      await runMigrations(url);
      expect((await installRows(url)).map((row) => row.id)).toEqual([first]);
      expect(await query(url, "SELECT 1 FROM settings WHERE tenant_id <> '" + first + "'")).toEqual(
        [],
      );
    });

    it('treats an empty TENANT_ID like an absent one', async () => {
      const url = await freshDatabase();

      await runMigrations(url, { tenantId: '' });

      expect(await installRows(url)).toHaveLength(1);
    });

    it('stops with AppRoleMismatch, changing nothing, when APP_DB_ROLE differs on a rerun', async () => {
      const url = await freshDatabase();
      await runMigrations(url);
      const before = await databaseSettings(url);

      const error = await runMigrations(url, { appRole: 'ssd_other_app' }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AppRoleMismatch);
      expect((error as Error).message).toContain('ssdashboard_app');
      expect((error as Error).message).toContain('ssd_other_app');
      expect(await databaseSettings(url)).toEqual(before);
      expect(await query(url, "SELECT 1 FROM pg_roles WHERE rolname = 'ssd_other_app'")).toEqual(
        [],
      );
    });

    it('uses the stored role on a rerun without APP_DB_ROLE, also for the login', async () => {
      const url = await freshDatabase();
      const role = `ssd_stored${Date.now()}_app`;
      try {
        await runMigrations(url, { appRole: role });

        await runMigrations(url);
        await setAppRoleLogin(url, 'secret-for-test');

        const login = await query<{ rolcanlogin: boolean }>(
          url,
          `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${role}'`,
        );
        expect(login).toEqual([{ rolcanlogin: true }]);
        expect(await databaseSettings(url)).toContain(`ssd.app_role=${role}`);
      } finally {
        await Promise.all(scratch.splice(0).map(dropScratchDatabase));
        await withAdmin((client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
      }
    });

    it('stores one role when two overlapping runs ask for different ones', async () => {
      const url = await freshDatabase();
      const stamp = Date.now();
      const roles = [`ssd_race_a${stamp}_app`, `ssd_race_b${stamp}_app`];
      // A third connection holds the migrate lock until both runs have connected and wait for it.
      // Both sessions then started before either stored anything, so only a read from the catalog
      // after the lock can see what the winner stored.
      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      try {
        const runs = roles.map((appRole) => runMigrations(url, { appRole }));
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = await query<{ n: number }>(
            url,
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
          );
          if ((waiting[0]?.n ?? 0) >= 2) break;
          if (Date.now() > deadline) throw new Error('The two runs never queued on the lock');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
        const results = await Promise.allSettled(runs);

        const rejected = results.filter((result) => result.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toBeInstanceOf(AppRoleMismatch);
        const winner = roles[results.findIndex((result) => result.status === 'fulfilled')];
        expect(await databaseSettings(url)).toContain(`ssd.app_role=${winner}`);
        const granted = await query<{ ok: boolean }>(
          url,
          `SELECT has_table_privilege('${winner}', 'movement_groups', 'INSERT') AS ok`,
        );
        expect(granted).toEqual([{ ok: true }]);
      } finally {
        await holder.end();
        await Promise.all(scratch.splice(0).map(dropScratchDatabase));
        for (const role of roles) {
          await withAdmin((client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
        }
      }
    });

    it('lets a first run that failed before its migrations committed be rerun with a corrected role', async () => {
      const url = await freshDatabase();
      const role = `ssd_fixed${Date.now()}_app`;
      // What a failed first run leaves: the database settings, but no tables.
      await withAdmin((client) =>
        client.query(
          `ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET ssd.app_role = 'ssd_typo_app'`,
        ),
      );
      try {
        await runMigrations(url, { appRole: role });

        expect(await databaseSettings(url)).toContain(`ssd.app_role=${role}`);
      } finally {
        await Promise.all(scratch.splice(0).map(dropScratchDatabase));
        await withAdmin((client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
      }
    });

    it.each([
      ['a superuser', 'SUPERUSER'],
      ['a role that can create roles', 'CREATEROLE'],
      ['a role that bypasses row security', 'BYPASSRLS'],
    ])('refuses %s as the app role, before changing anything', async (_name, attribute) => {
      const url = await freshDatabase();
      const role = `ssd_priv${Date.now()}_app`;
      await withAdmin((client) => client.query(`CREATE ROLE "${role}" ${attribute}`));
      try {
        await expect(runMigrations(url, { appRole: role })).rejects.toBeInstanceOf(UnsafeAppRole);

        expect(await databaseSettings(url)).toEqual([]);
        expect(await query(url, "SELECT 1 FROM pg_tables WHERE tablename = 'install'")).toEqual([]);
      } finally {
        await dropScratchDatabase(scratch.splice(0)[0] ?? '');
        await withAdmin((client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
      }
    });

    it('refuses the owner role itself as the app role', async () => {
      const url = await freshDatabase();
      const owner = (await query<{ current_user: string }>(url, 'SELECT current_user'))[0];

      await expect(runMigrations(url, { appRole: owner?.current_user })).rejects.toBeInstanceOf(
        UnsafeAppRole,
      );
    });

    it('creates a custom app role and grants it the append only rules', async () => {
      const url = await freshDatabase();
      const role = `ssd_acme_${Date.now()}_app`;
      try {
        await runMigrations(url, { appRole: role });

        const privileges = await query<Record<string, boolean>>(
          url,
          `SELECT has_table_privilege('${role}', 'movement_groups', 'INSERT') AS insert_ledger,
                  has_table_privilege('${role}', 'movement_groups', 'UPDATE') AS update_ledger,
                  has_table_privilege('${role}', 'settings', 'UPDATE') AS update_settings,
                  has_table_privilege('${role}', 'install', 'INSERT') AS insert_install,
                  has_table_privilege('${role}', 'location_owner_policies', 'SELECT') AS read_policies,
                  has_table_privilege('${role}', 'location_owner_policies', 'INSERT') AS insert_policies,
                  has_table_privilege('${role}', 'location_owner_policies', 'UPDATE') AS update_policies,
                  has_table_privilege('${role}', 'location_owner_policies', 'DELETE') AS delete_policies,
                  (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'pgboss') = '${role}' AS owns_pgboss`,
        );
        expect(privileges[0]).toEqual({
          insert_ledger: true,
          update_ledger: false,
          update_settings: true,
          insert_install: false,
          read_policies: true,
          insert_policies: false,
          update_policies: false,
          delete_policies: false,
          owns_pgboss: true,
        });
      } finally {
        await Promise.all(scratch.splice(0).map(dropScratchDatabase));
        await withAdmin((client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
      }
    });

    it('derives the client code from an ssd_<code>_app role name', async () => {
      const url = await freshDatabase();
      const role = `ssd_acme${Date.now()}_app`;
      try {
        await runMigrations(url, { appRole: role });

        expect((await installRows(url))[0]).toMatchObject({
          client_code: role.slice(4, -4),
          name: role.slice(4, -4),
        });
      } finally {
        await Promise.all(scratch.splice(0).map(dropScratchDatabase));
        await withAdmin((client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
      }
    });
  });

  it('rejects when the database cannot be reached', async () => {
    await expect(runMigrations('postgres://nobody:nothing@127.0.0.1:1/none')).rejects.toThrow();
  });
});
