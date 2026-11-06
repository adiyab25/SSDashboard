import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// AC-15 (spec 0002, A1): every table carries a tenant_id the database fills in, and every key
// that holds a business column leads with it. The scans below read the catalog, so a table added
// later is checked without touching this file.

const DEFAULT_TEXT = "(current_setting('ssd.tenant_id'::text))::uuid";
// The tool owned schemas and the one table whose own id is the tenant id.
const SKIPPED_SCHEMAS = "('pgboss', 'drizzle', 'pg_catalog', 'information_schema')";
const INSTALL = 'install';

/** Base tables that lack a `tenant_id uuid not null` column with the expected default. */
async function tablesWithoutTenantColumn(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT t.table_name
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant_id'
      WHERE t.table_type = 'BASE TABLE'
        AND t.table_schema NOT IN ${SKIPPED_SCHEMAS}
        AND t.table_name <> $1
        AND (c.column_name IS NULL OR c.data_type <> 'uuid' OR c.is_nullable <> 'NO'
             OR c.column_default IS DISTINCT FROM $2)
      ORDER BY 1`,
    [INSTALL, DEFAULT_TEXT],
  );
  return rows.map((row) => row.table_name);
}

/**
 * Unique indexes (primary keys and unique constraints included) that hold a column not of type
 * `uuid`, or an expression, and do not include `tenant_id`. A key made only of uuid columns is exempt.
 */
async function keysWithoutTenant(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname || '.' || i.relname AS name
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indisunique AND c.relkind = 'r'
        AND n.nspname NOT IN ${SKIPPED_SCHEMAS}
        AND c.relname <> $1
        AND EXISTS (
          SELECT 1 FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
            LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
           WHERE k.ord <= x.indnkeyatts AND (k.attnum = 0 OR a.atttypid <> 'uuid'::regtype))
        AND NOT EXISTS (
          SELECT 1 FROM unnest(x.indkey::int2[]) k(attnum)
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
           WHERE a.attname = 'tenant_id')
      ORDER BY 1`,
    [INSTALL],
  );
  return rows.map((row) => row.name);
}

describe('tenant id on every table (AC-15)', () => {
  const names: string[] = [];
  let owner: pg.Client;
  let url: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    names.push(db.name);
    url = db.url;
    await runMigrations(url);
    owner = new pg.Client({ connectionString: url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await Promise.all(names.map(dropScratchDatabase));
  });

  it('gives every table a not null uuid tenant_id defaulting to the ssd.tenant_id setting', async () => {
    expect(await tablesWithoutTenantColumn(owner)).toEqual([]);
  });

  it('leads every key that holds a non uuid column with tenant_id', async () => {
    expect(await keysWithoutTenant(owner)).toEqual([]);
  });

  it('scans a real set of tables, so an empty result is not an empty scan', async () => {
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND table_schema = 'public' AND table_name <> $1`,
      [INSTALL],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(20);
  });

  it('has no tenant_id on install, whose own id is the tenant id', async () => {
    const { rows } = await owner.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'install' AND column_name = 'tenant_id'",
    );
    expect(rows).toHaveLength(0);
  });

  // Planted failures, rolled back so the schema stays clean.
  it('detects a table without the column and its key without tenant_id', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('CREATE TABLE planted_no_tenant (id uuid PRIMARY KEY, code text UNIQUE)');

      expect(await tablesWithoutTenantColumn(owner)).toEqual(['planted_no_tenant']);
      expect(await keysWithoutTenant(owner)).toEqual([
        'planted_no_tenant.planted_no_tenant_code_key',
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('detects a unique key without tenant_id on a table that has the column', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(
        `CREATE TABLE planted_bad_key (
           id uuid PRIMARY KEY,
           tenant_id uuid NOT NULL DEFAULT current_setting('ssd.tenant_id')::uuid,
           code text,
           CONSTRAINT planted_bad_key_code_unique UNIQUE (code))`,
      );

      expect(await tablesWithoutTenantColumn(owner)).toEqual([]);
      expect(await keysWithoutTenant(owner)).toEqual([
        'planted_bad_key.planted_bad_key_code_unique',
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('detects a nullable tenant_id and a missing default', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('CREATE TABLE planted_nullable (id uuid PRIMARY KEY, tenant_id uuid)');

      expect(await tablesWithoutTenantColumn(owner)).toEqual(['planted_nullable']);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('exempts a key made only of uuid columns, such as movement_serials (movement_id, serial_id)', async () => {
    const { rows } = await owner.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'movement_serials_movement_id_serial_id_pk'",
    );
    expect(rows).toHaveLength(1);
    expect(await keysWithoutTenant(owner)).not.toContain(
      'movement_serials.movement_serials_movement_id_serial_id_pk',
    );
  });

  it('gives an insert without tenant_id the install id', async () => {
    const install = await owner.query<{ id: string }>('SELECT id FROM install');
    const row = await owner.query<{ tenant_id: string }>(
      "INSERT INTO parties (code, name, is_supplier) VALUES ('TENANT-1', 'A', true) RETURNING tenant_id",
    );

    expect(row.rows[0]?.tenant_id).toBe(install.rows[0]?.id);
  });

  it('refuses a second install row and an install id that is not the tenant', async () => {
    await expect(
      owner.query("INSERT INTO install (id, client_code, name) VALUES (uuidv7(), 'x', 'x')"),
    ).rejects.toThrow(/install_id_is_tenant_id|install_single_row_unique/);
  });

  // A database that never received the setting: the default must fail, not write a null or a wrong id.
  it('fails an insert in a session where the setting is absent', async () => {
    const db = await createScratchDatabase();
    names.push(db.name);
    await runMigrations(db.url);
    const admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    try {
      await admin.query(`ALTER DATABASE ${db.name} RESET ssd.tenant_id`);
    } finally {
      await admin.end();
    }
    const session = new pg.Client({ connectionString: db.url });
    await session.connect();
    try {
      await expect(
        session.query("INSERT INTO parties (code, name, is_supplier) VALUES ('X', 'X', true)"),
      ).rejects.toThrow(/unrecognized configuration parameter "ssd.tenant_id"/);
    } finally {
      await session.end();
    }
  });
});
