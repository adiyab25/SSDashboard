import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// One migrated scratch database for the file; each test makes its own rows.
describe('core data model schema (spec 0002)', () => {
  let name: string;
  let owner: pg.Client;
  let app: pg.Client;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    app = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await app.connect();
    // The application role's privileges, without needing its login in the test cluster.
    await app.query(`SET ROLE ${APP_ROLE}`);
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await dropScratchDatabase(name);
  });

  async function one<T extends pg.QueryResultRow>(
    client: pg.Client,
    text: string,
    values: unknown[] = [],
  ): Promise<T> {
    const { rows } = await client.query<T>(text, values);
    const row = rows[0];
    if (!row) throw new Error(`no row from: ${text}`);
    return row;
  }

  async function makeVariant(): Promise<string> {
    counter += 1;
    const product = await one<{ id: string }>(
      owner,
      `INSERT INTO products (name) VALUES ('{"en": "Mug"}') RETURNING id`,
    );
    const variant = await one<{ id: string }>(
      owner,
      `INSERT INTO product_variants (product_id, sku, base_uom_id)
       VALUES ($1, $2, (SELECT id FROM uoms WHERE code = 'pc')) RETURNING id`,
      [product.id, `SKU-${counter}`],
    );
    return variant.id;
  }

  async function makeLocation(): Promise<string> {
    counter += 1;
    const row = await one<{ id: string }>(
      owner,
      `INSERT INTO locations (code, name, type) VALUES ($1, '{"en": "Main"}', 'warehouse') RETURNING id`,
      [`WH-${counter}`],
    );
    return row.id;
  }

  async function makeMovement(): Promise<{
    groupId: string;
    movementId: string;
    variantId: string;
  }> {
    const variantId = await makeVariant();
    const locationId = await makeLocation();
    const group = await one<{ id: string }>(
      owner,
      `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
       VALUES (gen_random_uuid()::text, 'h', 'opening_balance', gen_random_uuid(), now()) RETURNING id`,
    );
    const movement = await one<{ id: string }>(
      owner,
      `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, recorded_at)
       VALUES ($1, $2, $3, 5, 2, 10, now(), now()) RETURNING id`,
      [group.id, variantId, locationId],
    );
    return { groupId: group.id, movementId: movement.id, variantId };
  }

  it('seeds the settings, the base unit, and the transit and scrap locations', async () => {
    const settings = await owner.query<{ key: string }>('SELECT key FROM settings ORDER BY key');
    expect(settings.rows.map((row) => row.key)).toEqual([
      'currency',
      'document_prefixes',
      'inventory_lock_date',
      'prices_include_vat',
      'timezone',
    ]);
    const locations = await owner.query<{ type: string }>(
      "SELECT type FROM locations WHERE code IN ('TRANSIT', 'SCRAP') ORDER BY code",
    );
    expect(locations.rows.map((row) => row.type)).toEqual(['virtual', 'transit']);
    await one(owner, "SELECT 1 FROM uoms WHERE code = 'pc'");
  });

  describe('the append only ledger (AC-2)', () => {
    it.each([
      'UPDATE stock_movements SET quantity = 6 WHERE id = $1',
      'DELETE FROM stock_movements WHERE id = $1',
    ])('refuses "%s" from the application role on permissions', async (statement) => {
      const { movementId } = await makeMovement();

      await expect(app.query(statement, [movementId])).rejects.toThrow(/permission denied/);
    });

    it.each([
      'UPDATE stock_movements SET quantity = 6 WHERE id = $1',
      'DELETE FROM stock_movements WHERE id = $1',
    ])('refuses "%s" from the owner role on the trigger', async (statement) => {
      const { movementId } = await makeMovement();

      await expect(owner.query(statement, [movementId])).rejects.toThrow(/append only/);
    });

    it.each(['stock_movements', 'movement_groups', 'movement_serials'])(
      'refuses to truncate %s, for every role',
      async (table) => {
        await expect(app.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/permission denied/);
        await expect(owner.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append only/);
      },
    );

    it('refuses to change a movement group', async () => {
      const { groupId } = await makeMovement();

      await expect(
        owner.query("UPDATE movement_groups SET request_hash = 'x' WHERE id = $1", [groupId]),
      ).rejects.toThrow(/append only/);
    });

    it('lets the application role insert and read movements', async () => {
      const variantId = await makeVariant();
      const locationId = await makeLocation();
      const group = await one<{ id: string }>(
        app,
        `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
         VALUES (gen_random_uuid()::text, 'h', 'adjustment', gen_random_uuid(), now()) RETURNING id`,
      );
      await app.query(
        `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, recorded_at)
         VALUES ($1, $2, $3, 1, 1, 1, now(), now())`,
        [group.id, variantId, locationId],
      );

      const count = await one<{ count: string }>(
        app,
        'SELECT count(*) FROM stock_movements WHERE group_id = $1',
        [group.id],
      );
      expect(count.count).toBe('1');
    });

    it('refuses a movement whose cost has the opposite sign to its quantity', async () => {
      const { groupId, variantId } = await makeMovement();
      const locationId = await makeLocation();

      await expect(
        owner.query(
          `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, recorded_at)
           VALUES ($1, $2, $3, -1, 1, 1, now(), now())`,
          [groupId, variantId, locationId],
        ),
      ).rejects.toThrow(/stock_movements_cost_sign/);
    });

    it('refuses to reverse a reversal group', async () => {
      const { groupId } = await makeMovement();
      const reversal = await one<{ id: string }>(
        owner,
        `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, reverses_group_id, effective_at)
         VALUES (gen_random_uuid()::text, 'h', 'opening_balance', gen_random_uuid(), $1, now()) RETURNING id`,
        [groupId],
      );

      await expect(
        owner.query(
          `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, reverses_group_id, effective_at)
           VALUES (gen_random_uuid()::text, 'h', 'opening_balance', gen_random_uuid(), $1, now())`,
          [reversal.id],
        ),
      ).rejects.toThrow(/cannot be reversed/);
    });
  });

  describe('referenced master data (AC-13)', () => {
    it('refuses to delete a SKU that has movements, but lets it be archived', async () => {
      const { variantId } = await makeMovement();

      await expect(
        app.query('DELETE FROM product_variants WHERE id = $1', [variantId]),
      ).rejects.toThrow(/foreign key/);
      await app.query('UPDATE product_variants SET archived_at = now() WHERE id = $1', [variantId]);
      const row = await one<{ archived: boolean }>(
        app,
        'SELECT archived_at IS NOT NULL AS archived FROM product_variants WHERE id = $1',
        [variantId],
      );
      expect(row.archived).toBe(true);
    });

    it('deletes a SKU nothing references', async () => {
      const variantId = await makeVariant();

      const result = await app.query('DELETE FROM product_variants WHERE id = $1', [variantId]);

      expect(result.rowCount).toBe(1);
    });

    it('refuses to delete a location that holds a bin', async () => {
      const locationId = await makeLocation();
      await owner.query("INSERT INTO bins (location_id, code) VALUES ($1, 'A-1')", [locationId]);

      await expect(app.query('DELETE FROM locations WHERE id = $1', [locationId])).rejects.toThrow(
        /foreign key/,
      );
    });
  });

  describe('composite keys', () => {
    it('refuses a balance whose bin belongs to another location', async () => {
      const variantId = await makeVariant();
      const home = await makeLocation();
      const other = await makeLocation();
      const bin = await one<{ id: string }>(
        owner,
        "INSERT INTO bins (location_id, code) VALUES ($1, 'B-1') RETURNING id",
        [home],
      );

      await expect(
        app.query(
          'INSERT INTO stock_levels (variant_id, location_id, bin_id) VALUES ($1, $2, $3)',
          [variantId, other, bin.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('refuses a balance whose lot belongs to another SKU', async () => {
      const lotOwner = await makeVariant();
      const other = await makeVariant();
      const locationId = await makeLocation();
      const lot = await one<{ id: string }>(
        owner,
        "INSERT INTO lots (variant_id, code) VALUES ($1, 'L1') RETURNING id",
        [lotOwner],
      );

      await expect(
        app.query(
          'INSERT INTO stock_levels (variant_id, location_id, lot_id) VALUES ($1, $2, $3)',
          [other, locationId, lot.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('keeps one balance per SKU, location, bin, and lot even when bin and lot are empty', async () => {
      const variantId = await makeVariant();
      const locationId = await makeLocation();
      await app.query('INSERT INTO stock_levels (variant_id, location_id) VALUES ($1, $2)', [
        variantId,
        locationId,
      ]);

      await expect(
        app.query('INSERT INTO stock_levels (variant_id, location_id) VALUES ($1, $2)', [
          variantId,
          locationId,
        ]),
      ).rejects.toThrow(/stock_levels_key_unique/);
    });
  });
});
