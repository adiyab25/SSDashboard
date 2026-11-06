import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// One migrated scratch database for the file; each test makes its own rows.
describe('core data model schema (spec 0002)', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let app: pg.Client;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
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
      `INSERT INTO products (style_code, product_group_id, name) VALUES ('MUG-${counter}', (SELECT id FROM product_groups WHERE code = 'MAIN'), '{"en": "Mug"}') RETURNING id`,
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
      `INSERT INTO locations (code, name, kind) VALUES ($1, '{"en": "Main"}', 'warehouse') RETURNING id`,
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
      'default_language',
      'document_prefixes',
      'inventory_lock_date',
      'languages',
      'operating_day_cutoff_hour',
      'prices_include_vat',
      'timezone',
    ]);
    const locations = await owner.query<{ kind: string; owner_type: string; sellable: boolean }>(
      "SELECT kind, owner_type, sellable_online AS sellable FROM locations WHERE code IN ('TRANSIT', 'SCRAP') ORDER BY code",
    );
    expect(locations.rows).toEqual([
      { kind: 'virtual', owner_type: 'own', sellable: false },
      { kind: 'transit', owner_type: 'own', sellable: false },
    ]);
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

  // Security review M1: the app role may create TEMP tables, and a temp table hides an unqualified
  // name. The guards name public.<table> and pin their search_path, so a shadow changes nothing.
  describe('the guards under a shadowing temp table (security M1)', () => {
    it('still refuses a reversal of a reversal and keeps the operating day', async () => {
      const { groupId } = await makeMovement();
      const reverse = (of: string) =>
        `INSERT INTO public.movement_groups (idempotency_key, request_hash, source_type, source_id, reverses_group_id, effective_at)
         VALUES (gen_random_uuid()::text, 'h', 'opening_balance', gen_random_uuid(), '${of}', now())`;
      const reversal = await one<{ id: string }>(owner, `${reverse(groupId)} RETURNING id`);
      const day = "SELECT to_char(ssd_operating_day('2026-11-05 12:00+00'), 'YYYY-MM-DD') AS day";
      const expected = (await one<{ day: string }>(owner, day)).day;

      const attacker = new pg.Client({ connectionString: url });
      await attacker.connect();
      try {
        await attacker.query(`SET ROLE ${APP_ROLE}`);
        await attacker.query('CREATE TEMP TABLE movement_groups (id uuid, reverses_group_id uuid)');
        await attacker.query('CREATE TEMP TABLE settings (tenant_id uuid, key text, value jsonb)');
        await attacker.query(
          `INSERT INTO pg_temp.settings VALUES (current_setting('ssd.tenant_id')::uuid, 'timezone', '"Pacific/Kiritimati"')`,
        );

        await expect(attacker.query(reverse(reversal.id))).rejects.toThrow(/cannot be reversed/);
        expect((await one<{ day: string }>(attacker, day)).day).toBe(expected);
      } finally {
        await attacker.end();
      }
    });
  });

  // AC-33 (spec 0002, A4): every table that can only grow. The app role is refused on permissions,
  // the owner on the trigger. Later features add their tables to this list.
  describe('the append only tables (AC-33)', () => {
    type Seeded = { update: string; remove: string; params: string[] };

    const seeds: Record<string, () => Promise<Seeded>> = {
      movement_groups: async () => {
        const { groupId } = await makeMovement();
        return {
          update: "UPDATE movement_groups SET request_hash = 'x' WHERE id = $1",
          remove: 'DELETE FROM movement_groups WHERE id = $1',
          params: [groupId],
        };
      },
      stock_movements: async () => {
        const { movementId } = await makeMovement();
        return {
          update: 'UPDATE stock_movements SET quantity = 6 WHERE id = $1',
          remove: 'DELETE FROM stock_movements WHERE id = $1',
          params: [movementId],
        };
      },
      movement_serials: async () => {
        const { movementId, variantId } = await makeMovement();
        const serial = await one<{ id: string }>(
          owner,
          "INSERT INTO serials (variant_id, serial, status) VALUES ($1, 'S-1', 'out') RETURNING id",
          [variantId],
        );
        await owner.query('INSERT INTO movement_serials (movement_id, serial_id) VALUES ($1, $2)', [
          movementId,
          serial.id,
        ]);
        return {
          update: 'UPDATE movement_serials SET serial_id = serial_id WHERE movement_id = $1',
          remove: 'DELETE FROM movement_serials WHERE movement_id = $1',
          params: [movementId],
        };
      },
      cost_records: async () => {
        const variantId = await makeVariant();
        await owner.query(
          `INSERT INTO cost_records (product_id, season_id, cost_basis, unit_cost, effective_from)
           SELECT product_id, (SELECT id FROM seasons WHERE code = 'CORE'), 'estimate', 10, '2026-01-01'
           FROM product_variants WHERE id = $1`,
          [variantId],
        );
        return {
          update:
            'UPDATE cost_records SET unit_cost = 11 WHERE product_id = (SELECT product_id FROM product_variants WHERE id = $1)',
          remove:
            'DELETE FROM cost_records WHERE product_id = (SELECT product_id FROM product_variants WHERE id = $1)',
          params: [variantId],
        };
      },
      stock_receipt_lines: async () => {
        const { groupId, variantId } = await makeMovement();
        counter += 1;
        const user = await one<{ id: string }>(
          owner,
          "INSERT INTO users (name, email) VALUES ('R', $1) RETURNING id",
          [`receipt-${counter}@example.test`],
        );
        const receipt = await one<{ id: string }>(
          owner,
          `INSERT INTO stock_receipts (id, request_hash, number, location_id, effective_at, movement_group_id, posted_by)
           VALUES (gen_random_uuid(), 'h', $1, $2, now(), $3, $4) RETURNING id`,
          [`SR-T-${counter}`, await makeLocation(), groupId, user.id],
        );
        await owner.query(
          `INSERT INTO stock_receipt_lines (id, receipt_id, position, variant_id, uom_id, quantity, unit_cost, line_total)
           VALUES (gen_random_uuid(), $1, 1, $2, (SELECT id FROM uoms WHERE code = 'pc'), 1, 1, 1)`,
          [receipt.id, variantId],
        );
        return {
          update: 'UPDATE stock_receipt_lines SET quantity = 2 WHERE receipt_id = $1',
          remove: 'DELETE FROM stock_receipt_lines WHERE receipt_id = $1',
          params: [receipt.id],
        };
      },
    };

    it.each(Object.keys(seeds))('refuses UPDATE, DELETE, and TRUNCATE on %s', async (table) => {
      const seed = await seeds[table]?.();
      if (!seed) throw new Error(`no seed for ${table}`);

      for (const statement of [seed.update, seed.remove]) {
        await expect(app.query(statement, seed.params)).rejects.toThrow(/permission denied/);
        await expect(owner.query(statement, seed.params)).rejects.toThrow(/append only/);
      }
      await expect(app.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/permission denied/);
      await expect(owner.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append only/);
    });

    it('keeps the install row read only for the app role', async () => {
      await expect(
        app.query(
          "INSERT INTO install (id, client_code, name) VALUES (gen_random_uuid(), 'x', 'x')",
        ),
      ).rejects.toThrow(/permission denied/);
      const rows = await app.query('SELECT id FROM install');
      expect(rows.rowCount).toBe(1);
    });
  });

  describe('styles, seasons, and cost records (AC-30)', () => {
    const MAIN = "(SELECT id FROM product_groups WHERE code = 'MAIN')";

    it('seeds the MAIN group and the CORE season', async () => {
      await one(owner, "SELECT 1 FROM product_groups WHERE code = 'MAIN'");
      await one(owner, "SELECT 1 FROM seasons WHERE code = 'CORE' AND starts_on IS NULL");
    });

    it('keeps a style code unique per tenant and requires a product group', async () => {
      await owner.query(
        `INSERT INTO products (style_code, product_group_id, name) VALUES ('DUP-1', ${MAIN}, '{"en": "a"}')`,
      );
      await expect(
        owner.query(
          `INSERT INTO products (style_code, product_group_id, name) VALUES ('DUP-1', ${MAIN}, '{"en": "b"}')`,
        ),
      ).rejects.toThrow(/products_style_code_unique/);
      await expect(
        owner.query(`INSERT INTO products (style_code, name) VALUES ('NO-GROUP', '{"en": "c"}')`),
      ).rejects.toThrow(/product_group_id/);
    });

    it('orders season dates', async () => {
      await expect(
        owner.query(
          `INSERT INTO seasons (code, name, starts_on, ends_on) VALUES ('BAD', '{"en": "x"}', '2027-02-01', '2027-01-01')`,
        ),
      ).rejects.toThrow(/seasons_dates_in_order/);
    });

    it('keeps a cost override in its own style and refuses negative costs', async () => {
      const variantId = await makeVariant();
      const other = await makeVariant();
      const insert = (product: string, variant: string, cost: number) =>
        owner.query(
          `INSERT INTO cost_records (product_id, variant_id, season_id, cost_basis, unit_cost, effective_from)
           VALUES ((SELECT product_id FROM product_variants WHERE id = $1), $2,
                   (SELECT id FROM seasons WHERE code = 'CORE'), 'estimate', $3, '2026-01-01')`,
          [product, variant, cost],
        );
      await insert(variantId, variantId, 10);
      await expect(insert(variantId, other, 10)).rejects.toThrow(/foreign key/);
      await expect(insert(variantId, variantId, -1)).rejects.toThrow(
        /cost_records_unit_cost_not_negative/,
      );
    });
  });

  describe('locations with an owner type (AC-29)', () => {
    async function party(roles: string): Promise<string> {
      counter += 1;
      return (
        await one<{ id: string }>(
          owner,
          `INSERT INTO parties (code, name, ${roles}) VALUES ($1, 'P', true) RETURNING id`,
          [`P-${counter}`],
        )
      ).id;
    }

    it('seeds the three policy rows', async () => {
      const rows = await owner.query<{ owner_type: string; handover_is_sale: boolean }>(
        'SELECT owner_type, handover_is_sale FROM location_owner_policies ORDER BY owner_type',
      );
      expect(rows.rows).toEqual([
        { owner_type: 'own', handover_is_sale: false },
        { owner_type: 'consignment_partner', handover_is_sale: false },
        { owner_type: 'wholesale_customer', handover_is_sale: true },
      ]);
    });

    it('needs a party exactly when the owner is not the brand', async () => {
      const partner = await party('is_consignment_partner');
      await expect(
        owner.query(
          `INSERT INTO locations (code, name, kind, owner_type) VALUES ('NP-1', '{"en": "x"}', 'shop', 'consignment_partner')`,
        ),
      ).rejects.toThrow(/locations_party_matches_owner/);
      await expect(
        owner.query(
          `INSERT INTO locations (code, name, kind, party_id) VALUES ('NP-2', '{"en": "x"}', 'shop', $1)`,
          [partner],
        ),
      ).rejects.toThrow(/locations_party_matches_owner/);
    });

    it('rejects changing the owner type or party with OwnerTypeFixed', async () => {
      const partner = await party('is_consignment_partner');
      await owner.query(
        `INSERT INTO locations (code, name, kind, owner_type, party_id) VALUES ('FIX-1', '{"en": "x"}', 'shop', 'consignment_partner', $1)`,
        [partner],
      );
      await expect(
        owner.query(
          `UPDATE locations SET owner_type = 'own', party_id = NULL WHERE code = 'FIX-1'`,
        ),
      ).rejects.toThrow(/OwnerTypeFixed/);
      await expect(
        app.query("UPDATE locations SET party_id = $1 WHERE code = 'FIX-1'", [
          await party('is_consignment_partner'),
        ]),
      ).rejects.toThrow(/OwnerTypeFixed/);
      await owner.query('UPDATE locations SET name = \'{"en": "y"}\' WHERE code = \'FIX-1\'');
    });

    it('needs at least one party role', async () => {
      await expect(
        owner.query("INSERT INTO parties (code, name) VALUES ('NOROLE', 'x')"),
      ).rejects.toThrow(/parties_has_a_role/);
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
