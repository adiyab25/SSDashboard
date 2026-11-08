import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, APPEND_ONLY_TABLES, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

/** One foreign key whose columns no index leads with. */
type UnindexedKey = string;

/**
 * Foreign keys in schema public that no index serves (spec 0002 item 19, AC-36). PostgreSQL does not
 * index the referencing side of a foreign key, so a delete or update of the parent scans the child.
 * An index serves a key when it is valid, has the key's columns as its leading columns in order, and
 * either has no predicate or has exactly `<column> IS NOT NULL` for one of the key's columns (a
 * foreign key with a null column is not checked, and a parent lookup `col = $1` implies the column
 * is not null, so that index serves every lookup that matters). Any other partial index does not
 * serve every row and does not count. Printed as `table(columns) -> referenced`.
 */
async function unindexedForeignKeys(client: pg.Client): Promise<UnindexedKey[]> {
  const keys = await client.query<{ table: string; ref: string; cols: string[] }>(
    `SELECT c.relname AS "table", r.relname AS ref,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_class r ON r.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
      ORDER BY 1, 3`,
  );
  const indexes = await client.query<{
    table: string;
    cols: (string | null)[];
    pred: string | null;
  }>(
    `SELECT c.relname AS "table", pg_get_expr(x.indpred, x.indrelid) AS pred,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
              WHERE k.ord <= x.indnkeyatts) AS cols
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND x.indisvalid`,
  );
  return keys.rows
    .filter((key) => {
      const served = indexes.rows.some((index) => {
        if (index.table !== key.table) return false;
        if (!key.cols.every((col, position) => index.cols[position] === col)) return false;
        if (index.pred === null) return true;
        const predicate = index.pred.replace(/[()"]/g, '');
        return key.cols.some((col) => predicate === `${col} IS NOT NULL`);
      });
      return !served;
    })
    .map((key) => `${key.table}(${key.cols.join(', ')}) -> ${key.ref}`);
}

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

    // Review R7: a movement is kept for ever, so its reason is a code like every newer history row.
    it('takes a movement reason only as a code (R7)', async () => {
      const { groupId, variantId } = await makeMovement();
      const locationId = await makeLocation();
      const insert = (reason: string) =>
        app.query(
          `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, reason_code)
           VALUES ($1, $2, $3, 1, 1, 1, now(), $4)`,
          [groupId, variantId, locationId, reason],
        );

      for (const note of ['wrong supplier', 'Found in the back room', 'UPPER']) {
        await expect(insert(note)).rejects.toThrow(/stock_movements_reason_code_shape/);
      }
      await insert('wrong_supplier');
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

    // Security review S6: the guard reads the original itself. One it cannot see (not committed
    // yet) is refused here, never left to the foreign key, which checks later on a newer snapshot.
    it('refuses to reverse a group another transaction has not committed yet (S6)', async () => {
      const writer = new pg.Client({ connectionString: url });
      await writer.connect();
      try {
        await writer.query(`SET ROLE ${APP_ROLE}`);
        await writer.query('BEGIN');
        const original = await one<{ id: string }>(
          writer,
          `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
           VALUES (gen_random_uuid()::text, 'h', 'adjustment', gen_random_uuid(), now()) RETURNING id`,
        );
        const reverse = `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, reverses_group_id, effective_at)
           VALUES (gen_random_uuid()::text, 'h', 'adjustment', gen_random_uuid(), $1, now())`;

        await expect(app.query(reverse, [original.id])).rejects.toThrow(
          /movement_groups_reverses_existing_group/,
        );
        await writer.query('COMMIT');
        await app.query(reverse, [original.id]);
      } finally {
        await writer.end();
      }
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
  // the owner on the trigger. `licenses` and `license_checks` joined with spec 0009 milestone 2
  // (`0004_license_rules.sql`). The A4 table not built yet joins with its feature: `export_runs` (feature 45, its
  // status columns stay updatable). `audit_entries` (spec 0010) is here, and its own suite
  // (`audit-append-only.e2e-spec.ts`) adds the planted grant.
  describe('the append only tables (AC-33)', () => {
    type Seeded = { update: string; remove: string; params: string[] };

    /** A carrier settlement account with one statement and one line, for the settlement seeds. */
    async function makeSettlementLine(): Promise<{
      accountId: string;
      statementId: string;
      lineId: string;
    }> {
      counter += 1;
      const connection = await one<{ id: string }>(
        owner,
        "INSERT INTO connections (provider, label) VALUES ('bosta', $1) RETURNING id",
        [`Bosta ${counter}`],
      );
      const account = await one<{ id: string }>(
        owner,
        `INSERT INTO settlement_accounts (code, name, owner_type, owner_connection_id)
         VALUES ($1, '{"en": "Bosta"}', 'carrier', $2) RETURNING id`,
        [`BOSTA-${counter}`, connection.id],
      );
      const statement = await one<{ id: string }>(
        owner,
        `INSERT INTO settlement_statements (account_id, kind, external_reference)
         VALUES ($1, 'carrier_file', 'cycle-1') RETURNING id`,
        [account.id],
      );
      const line = await one<{ id: string }>(
        owner,
        `INSERT INTO settlement_lines (account_id, statement_id, line_kind, amount, external_line_ref, occurred_on)
         VALUES ($1, $2, 'cod_collected', 100, '1', '2026-11-03') RETURNING id`,
        [account.id, statement.id],
      );
      return { accountId: account.id, statementId: statement.id, lineId: line.id };
    }

    /**
     * Records one license row (a Warehouse grant with a unique hash) through `client`, with the
     * `recorded_at` a writer asks for, and returns its id and whether the stored instant is now.
     */
    async function makeLicense(
      client: pg.Client,
      recordedAt: string | null = null,
    ): Promise<{ id: string; stamped: boolean }> {
      return one<{ id: string; stamped: boolean }>(
        client,
        `INSERT INTO licenses (license_id, key_id, envelope, sha256, payload_sha256, client_code, bundles, issued_on, source, recorded_at)
         VALUES ('LIC-T', 'dev-1', '{}', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
                 encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'dev',
                 ARRAY['warehouse'], '2026-11-07', 'file', coalesce($1::timestamptz, now()))
         RETURNING id, recorded_at < now() + interval '1 minute' AS stamped`,
        [recordedAt],
      );
    }

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
      order_events: async () => {
        counter += 1;
        const order = await one<{ id: string }>(
          owner,
          `INSERT INTO orders (store_id, channel_id, order_number, placed_at, fulfillment_state, cash_state, outcome, payment_method)
           VALUES ((SELECT id FROM stores WHERE code = 'MAIN'), (SELECT id FROM channels WHERE code = 'manual'),
                   $1, now(), 'new', 'nothing_to_collect', 'open', 'none') RETURNING id`,
          [`AO-${counter}`],
        );
        const event = await one<{ id: string }>(
          owner,
          `INSERT INTO order_events (order_id, machine, to_state, actor_type, occurred_at)
           VALUES ($1, 'fulfillment', 'new', 'system_job', now()) RETURNING id`,
          [order.id],
        );
        return {
          update: "UPDATE order_events SET to_state = 'confirmed' WHERE id = $1",
          remove: 'DELETE FROM order_events WHERE id = $1',
          params: [event.id],
        };
      },
      customer_merges: async () => {
        counter += 1;
        const user = await one<{ id: string }>(
          owner,
          "INSERT INTO users (name, email) VALUES ('M', $1) RETURNING id",
          [`merge-${counter}@example.test`],
        );
        const merge = await one<{ id: string }>(
          owner,
          `WITH survivor AS (INSERT INTO customers DEFAULT VALUES RETURNING id),
                merged AS (INSERT INTO customers DEFAULT VALUES RETURNING id)
           INSERT INTO customer_merges (action, survivor_id, merged_id, actor_id)
           SELECT 'merge', survivor.id, merged.id, $1 FROM survivor, merged RETURNING id`,
          [user.id],
        );
        return {
          update: "UPDATE customer_merges SET reason = 'x' WHERE id = $1",
          remove: 'DELETE FROM customer_merges WHERE id = $1',
          params: [merge.id],
        };
      },
      credit_entries: async () => {
        const entry = await one<{ id: string }>(
          owner,
          `WITH customer AS (INSERT INTO customers DEFAULT VALUES RETURNING id)
           INSERT INTO credit_entries (posting_id, customer_id, kind, funding, amount, reason_code, actor_type, idempotency_key, request_hash, effective_at)
           SELECT gen_random_uuid(), customer.id, 'opening_balance', 'credit_only', 50, 'opening', 'import', gen_random_uuid()::text, 'h', now()
           FROM customer RETURNING id`,
        );
        return {
          update: 'UPDATE credit_entries SET amount = 60 WHERE id = $1',
          remove: 'DELETE FROM credit_entries WHERE id = $1',
          params: [entry.id],
        };
      },
      settlement_statements: async () => {
        const { statementId } = await makeSettlementLine();
        return {
          update: "UPDATE settlement_statements SET external_reference = 'x' WHERE id = $1",
          remove: 'DELETE FROM settlement_statements WHERE id = $1',
          params: [statementId],
        };
      },
      settlement_lines: async () => {
        const { lineId } = await makeSettlementLine();
        return {
          update: 'UPDATE settlement_lines SET amount = 1 WHERE id = $1',
          remove: 'DELETE FROM settlement_lines WHERE id = $1',
          params: [lineId],
        };
      },
      settlement_line_matches: async () => {
        const { lineId } = await makeSettlementLine();
        const match = await one<{ id: string }>(
          owner,
          `INSERT INTO settlement_line_matches (line_id, result, reason_code, matched_by_type)
           VALUES ($1, 'unmatched', 'not_yet_matched', 'rule') RETURNING id`,
          [lineId],
        );
        return {
          update: "UPDATE settlement_line_matches SET reason_code = 'amount_differs' WHERE id = $1",
          remove: 'DELETE FROM settlement_line_matches WHERE id = $1',
          params: [match.id],
        };
      },
      settlement_period_events: async () => {
        const { accountId } = await makeSettlementLine();
        const event = await one<{ id: string }>(
          owner,
          `WITH period AS (
             INSERT INTO settlement_periods (account_id, starts_on, ends_on)
             VALUES ($1, '2026-11-01', '2026-11-30') RETURNING id)
           INSERT INTO settlement_period_events (period_id, action, evidence, actor_type)
           SELECT period.id, 'closed', '{"statement_total": "0.00"}', 'rule' FROM period RETURNING id`,
          [accountId],
        );
        return {
          update: "UPDATE settlement_period_events SET reason = 'x' WHERE id = $1",
          remove: 'DELETE FROM settlement_period_events WHERE id = $1',
          params: [event.id],
        };
      },
      audit_entries: async () => {
        const entry = await one<{ id: string }>(
          owner,
          `INSERT INTO audit_entries (correlation_id, actor_kind, actor_ref, action, record_type, record_id)
           VALUES (gen_random_uuid(), 'carrier', 'bosta', 'stock_receipt.voided', 'stock_receipt', gen_random_uuid())
           RETURNING id`,
        );
        return {
          update: "UPDATE audit_entries SET reason = 'x' WHERE id = $1",
          remove: 'DELETE FROM audit_entries WHERE id = $1',
          params: [entry.id],
        };
      },
      licenses: async () => {
        const license = await makeLicense(owner);
        return {
          update: "UPDATE licenses SET license_id = 'x' WHERE id = $1",
          remove: 'DELETE FROM licenses WHERE id = $1',
          params: [license.id],
        };
      },
      license_checks: async () => {
        const check = await one<{ id: string }>(
          owner,
          `INSERT INTO license_checks (checked_at, trigger, outcome, operations_phase, warehouse_phase)
           VALUES (now(), 'daily', 'none_configured', 'not_licensed', 'not_licensed') RETURNING id`,
        );
        return {
          update: "UPDATE license_checks SET outcome = 'valid' WHERE id = $1",
          remove: 'DELETE FROM license_checks WHERE id = $1',
          params: [check.id],
        };
      },
      order_cost_rules: async () => {
        const rule = await one<{ id: string }>(
          owner,
          `INSERT INTO order_cost_rules (kind, status, value, effective_from)
           VALUES ('cod_fee_percent', 'set', 2.5, '2027-01-01') RETURNING id`,
        );
        return {
          update: 'UPDATE order_cost_rules SET value = 3 WHERE id = $1',
          remove: 'DELETE FROM order_cost_rules WHERE id = $1',
          params: [rule.id],
        };
      },
    };

    it('covers every table the database marks append only', async () => {
      const { rows } = await owner.query<{ table: string }>(
        `SELECT DISTINCT event_object_table AS table FROM information_schema.triggers
         WHERE right(trigger_name, 12) = '_append_only' ORDER BY 1`,
      );

      expect(rows.map((row) => row.table)).toEqual(Object.keys(seeds).sort());
    });

    // Security review S7: the declared list (APPEND_ONLY_TABLES in table-ownership.ts, the tables
    // built so far), the tables with both ssd_reject_change triggers, and the tables the app role
    // may insert into but never update, delete, or truncate are one and the same set. A new
    // history table missing from the list, a trigger, or a revoke fails here by name.
    it('keeps the declared append only list, the trigger set, and the revoked set equal (S7)', async () => {
      const built = await owner.query<{ table: string }>(
        `SELECT tablename::text AS table FROM pg_tables
          WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1`,
        [[...APPEND_ONLY_TABLES]],
      );
      const triggered = await owner.query<{ table: string }>(
        `SELECT c.relname::text AS table FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          WHERE c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                         WHERE t.tgrelid = c.oid AND p.proname = 'ssd_reject_change'
                           AND t.tgname = c.relname || '_append_only')
            AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                         WHERE t.tgrelid = c.oid AND p.proname = 'ssd_reject_change'
                           AND t.tgname = c.relname || '_no_truncate')
          ORDER BY 1`,
      );
      const revoked = await owner.query<{ table: string }>(
        `SELECT tablename::text AS table FROM pg_tables
          WHERE schemaname = 'public'
            AND has_table_privilege($1, format('%I.%I', schemaname, tablename), 'INSERT')
            AND NOT has_table_privilege($1, format('%I.%I', schemaname, tablename), 'UPDATE')
            AND NOT has_table_privilege($1, format('%I.%I', schemaname, tablename), 'DELETE')
            AND NOT has_table_privilege($1, format('%I.%I', schemaname, tablename), 'TRUNCATE')
          ORDER BY 1`,
        [APP_ROLE],
      );
      const names = (result: { rows: { table: string }[] }) => result.rows.map((row) => row.table);

      expect(names(built)).toEqual(Object.keys(seeds).sort());
      expect(names(triggered)).toEqual(names(built));
      expect(names(revoked)).toEqual(names(built));
    });

    // Security review S1: on append only history `recorded_at` belongs to the database. Each case
    // inserts a row with a writer chosen recorded_at in 2999 and reads back what was stored.
    const FUTURE = '2999-01-01T00:00:00Z';
    const stampCases: Record<string, () => Promise<{ stamped: boolean }>> = {
      movement_groups: () =>
        one(
          app,
          `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at, recorded_at)
           VALUES (gen_random_uuid()::text, 'h', 'opening_balance', gen_random_uuid(), now(), $1)
           RETURNING recorded_at = now() AS stamped`,
          [FUTURE],
        ),
      stock_movements: async () => {
        const { groupId, variantId } = await makeMovement();
        return one(
          owner,
          `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost, effective_at, recorded_at)
           VALUES ($1, $2, $3, 1, 1, 1, now(), $4) RETURNING recorded_at = now() AS stamped`,
          [groupId, variantId, await makeLocation(), FUTURE],
        );
      },
      credit_entries: () =>
        one(
          app,
          `WITH customer AS (INSERT INTO customers DEFAULT VALUES RETURNING id)
           INSERT INTO credit_entries (posting_id, customer_id, kind, funding, amount, reason_code, actor_type, idempotency_key, request_hash, effective_at, recorded_at)
           SELECT gen_random_uuid(), customer.id, 'opening_balance', 'credit_only', 50, 'opening', 'import', gen_random_uuid()::text, 'h', now(), $1
           FROM customer RETURNING recorded_at = now() AS stamped`,
          [FUTURE],
        ),
      cost_records: async () =>
        one(
          app,
          `INSERT INTO cost_records (product_id, season_id, cost_basis, unit_cost, effective_from, recorded_at)
           SELECT product_id, (SELECT id FROM seasons WHERE code = 'CORE'), 'estimate', 10, '2026-01-01', $2
           FROM product_variants WHERE id = $1
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [await makeVariant(), FUTURE],
        ),
      order_cost_rules: () =>
        one(
          app,
          `INSERT INTO order_cost_rules (kind, status, value, effective_from, recorded_at)
           VALUES ('cod_fee_percent', 'set', 2.5, '2027-01-01', $1)
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [FUTURE],
        ),
      order_events: async () => {
        counter += 1;
        const order = await one<{ id: string }>(
          owner,
          `INSERT INTO orders (store_id, channel_id, order_number, placed_at, fulfillment_state, cash_state, outcome, payment_method)
           VALUES ((SELECT id FROM stores WHERE code = 'MAIN'), (SELECT id FROM channels WHERE code = 'manual'),
                   $1, now(), 'new', 'nothing_to_collect', 'open', 'none') RETURNING id`,
          [`RA-${counter}`],
        );
        return one(
          app,
          `INSERT INTO order_events (order_id, machine, to_state, actor_type, occurred_at, recorded_at)
           VALUES ($1, 'fulfillment', 'new', 'system_job', now(), $2)
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [order.id, FUTURE],
        );
      },
      customer_merges: async () => {
        counter += 1;
        const user = await one<{ id: string }>(
          owner,
          "INSERT INTO users (name, email) VALUES ('M', $1) RETURNING id",
          [`stamp-${counter}@example.test`],
        );
        return one(
          app,
          `WITH survivor AS (INSERT INTO customers DEFAULT VALUES RETURNING id),
                merged AS (INSERT INTO customers DEFAULT VALUES RETURNING id)
           INSERT INTO customer_merges (action, survivor_id, merged_id, actor_id, recorded_at)
           SELECT 'merge', survivor.id, merged.id, $1, $2 FROM survivor, merged
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [user.id, FUTURE],
        );
      },
      settlement_line_matches: async () =>
        one(
          app,
          `INSERT INTO settlement_line_matches (line_id, result, reason_code, matched_by_type, recorded_at)
           VALUES ($1, 'unmatched', 'not_yet_matched', 'rule', $2)
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [(await makeSettlementLine()).lineId, FUTURE],
        ),
      settlement_period_events: async () => {
        const { accountId } = await makeSettlementLine();
        const period = await one<{ id: string }>(
          owner,
          `INSERT INTO settlement_periods (account_id, starts_on, ends_on)
           VALUES ($1, '2026-11-01', '2026-11-30') RETURNING id`,
          [accountId],
        );
        return one(
          app,
          `INSERT INTO settlement_period_events (period_id, action, evidence, actor_type, recorded_at)
           VALUES ($1, 'closed', '{"statement_total": "0.00"}', 'rule', $2)
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [period.id, FUTURE],
        );
      },
      // Spec 0009: a recorded license's instant is the database's too.
      licenses: async () => {
        const { stamped } = await makeLicense(app, FUTURE);
        return { stamped };
      },
      // Spec 0010 AS1: the audit trail's instant is the database's too (its id stamp follows).
      audit_entries: () =>
        one(
          app,
          `INSERT INTO audit_entries (recorded_at, correlation_id, actor_kind, actor_ref, action, record_type, record_id)
           VALUES ($1, gen_random_uuid(), 'carrier', 'bosta', 'stock_receipt.voided', 'stock_receipt', gen_random_uuid())
           RETURNING recorded_at < now() + interval '1 minute' AS stamped`,
          [FUTURE],
        ),
    };

    it('stamps recorded_at on every append only table that has one, first of its insert triggers (S1)', async () => {
      // The row (1), BEFORE (2), and INSERT (4) bits of pg_trigger.tgtype.
      const { rows } = await owner.query<{ table: string; first: string | null }>(
        `SELECT c.table_name::text AS table,
                (SELECT t.tgname::text FROM pg_trigger t
                  WHERE t.tgrelid = format('public.%I', c.table_name)::regclass
                    AND NOT t.tgisinternal AND (t.tgtype & 7) = 7
                  ORDER BY t.tgname COLLATE "C" LIMIT 1) AS first
           FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.column_name = 'recorded_at'
            AND c.table_name::text = ANY($1::text[])
          ORDER BY 1`,
        [[...APPEND_ONLY_TABLES]],
      );

      expect(rows.map((row) => row.table)).toEqual(Object.keys(stampCases).sort());
      for (const row of rows) expect(row.first).toBe(`${row.table}_0_stamp_recorded_at`);
    });

    it.each(Object.keys(stampCases))(
      'overwrites a writer chosen recorded_at on %s (S1)',
      async (table) => {
        const result = await stampCases[table]?.();

        expect(result).toEqual({ stamped: true });
      },
    );

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

    // Spec 0009, security review M2-2 and M2-6: a writer never chooses a license row's id, nor a
    // check's id or its place in insert order (`seq`), not even with OVERRIDING SYSTEM VALUE.
    it('stamps the id of a license and the id and seq of a check, whatever the writer sends', async () => {
      const chosen = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
      const license = await one<{ id: string }>(
        app,
        `INSERT INTO licenses (id, license_id, key_id, envelope, sha256, payload_sha256, client_code, bundles, issued_on, source)
         VALUES ($1, 'LIC-ID', 'dev-1', '{}', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
                 encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'dev', ARRAY['warehouse'],
                 '2026-11-07', 'file')
         RETURNING id`,
        [chosen],
      );
      expect(license.id).not.toBe(chosen);
      const insertCheck = (client: pg.Client, id: string, seq: number) =>
        one<{ id: string; seq: string }>(
          client,
          `INSERT INTO license_checks (id, seq, checked_at, trigger, outcome, operations_phase, warehouse_phase)
           OVERRIDING SYSTEM VALUE
           VALUES ($1, $2, now(), 'daily', 'none_configured', 'not_licensed', 'not_licensed')
           RETURNING id, seq`,
          [id, seq],
        );
      const first = await insertCheck(app, chosen, 9_000_000_000);
      const second = await insertCheck(owner, chosen, 9_000_000_001);
      expect([first.id, second.id]).not.toContain(chosen);
      expect(Number(first.seq)).toBeLessThan(9_000_000_000);
      expect(Number(second.seq)).toBe(Number(first.seq) + 1);
    });

    // Spec 0009 AC-14 and D18 (verify.md, Commands): a Warehouse expiry exists only on a license
    // that grants Warehouse, and an Operations grant always carries its expiry, so even a row
    // written past the api cannot claim a term its bundles do not have.
    it('refuses a Warehouse expiry without a Warehouse grant, and an Operations grant without its expiry (AC-14)', async () => {
      const insertLicense = (
        bundles: string,
        operationsExpiresOn: string | null,
        warehouseExpiresOn: string | null,
      ) =>
        app.query(
          `INSERT INTO licenses (license_id, key_id, envelope, sha256, payload_sha256, client_code, bundles,
                                 operations_expires_on, warehouse_expires_on, issued_on, source)
           VALUES ('LIC-TERM', 'dev-1', '{}', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
                   encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'dev', $1::text[],
                   $2::date, $3::date, '2026-11-08', 'upload')`,
          [bundles, operationsExpiresOn, warehouseExpiresOn],
        );

      await expect(insertLicense('{operations}', '2027-01-01', '2027-01-01')).rejects.toThrow(
        /licenses_warehouse_expiry/,
      );
      await expect(insertLicense('{operations}', null, null)).rejects.toThrow(
        /licenses_operations_expiry/,
      );
      await expect(insertLicense('{warehouse}', '2027-01-01', null)).rejects.toThrow(
        /licenses_operations_expiry/,
      );
      // A pilot license: Warehouse with its expiry is a sound row.
      const pilot = await insertLicense('{warehouse}', null, '2027-05-31');
      expect(pilot.rowCount).toBe(1);
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

    // Spec 0009 AC-24 (migration 0011): no writer, the owner included, can make a policy row
    // contradict itself or offer partner or customer stock online.
    it('refuses a policy row that contradicts itself', async () => {
      const update = (set: string, ownerType: string) =>
        owner.query(`UPDATE location_owner_policies SET ${set} WHERE owner_type = $1`, [ownerType]);
      await expect(update('can_sell_online = true', 'consignment_partner')).rejects.toThrow(
        /location_owner_policies_online_needs_brand_stock/,
      );
      await expect(update('can_sell_online = true', 'wholesale_customer')).rejects.toThrow(
        /location_owner_policies_online_needs_brand_stock/,
      );
      await expect(update("settlement_owner_type = 'carrier'", 'own')).rejects.toThrow(
        /location_owner_policies_online_needs_brand_stock/,
      );
      await expect(update('handover_is_sale = true', 'consignment_partner')).rejects.toThrow(
        /location_owner_policies_handover_is_sale/,
      );
      await expect(update("sale_recorded_at = 'at_handover'", 'own')).rejects.toThrow(
        /location_owner_policies_sale_at_handover/,
      );
      // Owner ruling 2026-11-08: the consignment row always settles with its partner.
      await expect(update('settlement_owner_type = NULL', 'consignment_partner')).rejects.toThrow(
        /location_owner_policies_consignment_settles_with_partner/,
      );
      // A consistent edit passes: who refunds a defect is free to change.
      await update("defective_piece_refund_by = 'location_owner'", 'consignment_partner');
      await update("defective_piece_refund_by = 'brand'", 'consignment_partner');
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

  // A bare Drizzle `.desc()` makes `DESC NULLS LAST`, which a plain `ORDER BY x DESC` cannot use.
  it('has no index key column ordered DESC NULLS LAST', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%DESC NULLS LAST%' ORDER BY 1",
    );
    expect(rows.map((row) => row.indexdef)).toEqual([]);
  });

  it('catches a DESC NULLS LAST index, and accepts DESC NULLS FIRST', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(
        `CREATE TABLE planted_desc (id uuid PRIMARY KEY, at timestamptz);
         CREATE INDEX planted_desc_first ON planted_desc (at DESC NULLS FIRST);
         CREATE INDEX planted_desc_last ON planted_desc (at DESC NULLS LAST);`,
      );
      const { rows } = await owner.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%DESC NULLS LAST%'",
      );
      expect(rows.map((row) => row.indexname)).toEqual(['planted_desc_last']);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  // AC-36 (spec 0002 item 19): every foreign key column has an index that leads with it.
  describe('foreign key indexes (AC-36)', () => {
    it('serves every foreign key with an index that leads with its columns', async () => {
      expect(await unindexedForeignKeys(owner)).toEqual([]);
    });

    it('scans a real set of foreign keys, so an empty result is not an empty scan', async () => {
      const { rows } = await owner.query<{ count: string }>(
        "SELECT count(*) FROM pg_constraint WHERE contype = 'f'",
      );
      expect(Number(rows[0]?.count)).toBeGreaterThan(50);
    });

    // Planted failures, rolled back so the schema stays clean.
    it('reports a foreign key without an index, a wrong order, and a partial composite index', async () => {
      const planted = async () =>
        (await unindexedForeignKeys(owner)).filter((key) => key.startsWith('planted_'));
      await owner.query('BEGIN');
      try {
        await owner.query(
          `CREATE TABLE planted_parent (a uuid, b uuid, PRIMARY KEY (a, b));
           CREATE TABLE planted_child (
             id uuid PRIMARY KEY, a uuid, b uuid, c uuid, d uuid, e uuid, f uuid,
             CONSTRAINT planted_child_ab_fk FOREIGN KEY (a, b) REFERENCES planted_parent (a, b),
             CONSTRAINT planted_child_cd_fk FOREIGN KEY (c, d) REFERENCES planted_parent (a, b),
             CONSTRAINT planted_child_ef_fk FOREIGN KEY (e, f) REFERENCES planted_parent (a, b));
           CREATE INDEX planted_child_b_a ON planted_child (b, a);
           CREATE INDEX planted_child_c_d_partial ON planted_child (c, d) WHERE id IS NOT NULL;
           CREATE INDEX planted_child_e_f_partial ON planted_child (e, f) WHERE e IS NOT NULL;`,
        );

        // (b, a) is the wrong order; a partial index on another column does not serve every row;
        // a partial index on `e IS NOT NULL` does.
        expect(await planted()).toEqual([
          'planted_child(a, b) -> planted_parent',
          'planted_child(c, d) -> planted_parent',
        ]);

        await owner.query('CREATE INDEX planted_child_a_b ON planted_child (a, b, id)');
        await owner.query('CREATE INDEX planted_child_c_d ON planted_child (c, d)');
        expect(await planted()).toEqual([]);
      } finally {
        await owner.query('ROLLBACK');
      }
    });
  });
});
