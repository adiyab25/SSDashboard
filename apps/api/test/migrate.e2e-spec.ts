import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '@ssdashboard/db';
import { createScratchDatabase, dropScratchDatabase, run, UNREACHABLE_DB } from './support.js';

describe('migrate entry point (dist/migrate.js)', { timeout: 30_000 }, () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dropScratchDatabase));
  });

  it('applies migrations, prints a confirmation, and exits 0 so Compose starts the api', async () => {
    const db = await createScratchDatabase();
    scratch.push(db.name);

    const result = await run('migrate.js', {
      DATABASE_URL: db.url,
      MIGRATION_DATABASE_URL: db.url,
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('Migrations applied.');
  });

  it('seeds one not_set cost rule per kind on the install day, and a rerun adds none (AC-32)', async () => {
    const db = await createScratchDatabase();
    scratch.push(db.name);
    const env = { DATABASE_URL: db.url, MIGRATION_DATABASE_URL: db.url };

    expect((await run('migrate.js', env)).code).toBe(0);
    expect((await run('migrate.js', env)).code).toBe(0);

    const owner = createDatabase(db.url, { max: 1 });
    try {
      const { rows } = await owner.pool.query<{ kind: string; status: string; today: boolean }>(
        `SELECT kind, status, effective_from = ssd_operating_day(now()) AS today
         FROM order_cost_rules ORDER BY kind`,
      );
      expect(rows).toEqual(
        [
          'cod_fee_percent',
          'gateway_fee_percent',
          'packaging_per_order',
          'rto_unrestocked_percent',
        ].map((kind) => ({ kind, status: 'not_set', today: true })),
      );
    } finally {
      await owner.pool.end();
    }
  });

  it('exits 1 when the database cannot be reached, so the api never starts', async () => {
    const result = await run('migrate.js', {
      DATABASE_URL: UNREACHABLE_DB,
      MIGRATION_DATABASE_URL: UNREACHABLE_DB,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('Migration failed');
  });

  it('exits 1 and names MIGRATION_DATABASE_URL when it is missing', async () => {
    const result = await run('migrate.js', { DATABASE_URL: UNREACHABLE_DB });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment[\s\S]*MIGRATION_DATABASE_URL/);
  });

  it('gives the application role a login when APP_DB_PASSWORD is set', async () => {
    const db = await createScratchDatabase();
    scratch.push(db.name);
    // The role is shared by the whole cluster, so keep the password every other suite uses.
    const password = process.env.APP_DB_PASSWORD ?? 'ssdashboard_app';

    const result = await run('migrate.js', {
      DATABASE_URL: db.url,
      MIGRATION_DATABASE_URL: db.url,
      APP_DB_PASSWORD: password,
    });

    expect(result.code).toBe(0);
    const appUrl = new URL(db.url);
    appUrl.username = 'ssdashboard_app';
    appUrl.password = password;
    const app = createDatabase(appUrl.toString(), { max: 1 });
    try {
      const { rows } = await app.pool.query<{ user: string }>('SELECT current_user AS user');
      expect(rows[0]?.user).toBe('ssdashboard_app');
    } finally {
      await app.pool.end();
    }
  });

  it('exits 1 and names MIGRATION_DATABASE_URL when nothing is set', async () => {
    const result = await run('migrate.js', {});

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment[\s\S]*MIGRATION_DATABASE_URL/);
    // migrate no longer reads the application role's address (loadMigrateEnv).
    expect(result.output).not.toMatch(/(?<!MIGRATION_)DATABASE_URL/);
  });
});
