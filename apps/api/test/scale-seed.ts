import type { DatabaseConnection } from '@ssdashboard/db';

export interface ScaleSeed {
  skus: number;
  movements: number;
  locations: number;
}

/**
 * Loads a full size catalog straight into the tables, in SQL, for the AC-14 latency check:
 * `skus` SKUs, `locations` warehouses, and `movements` opening balance movements (ten per
 * group), with balances that match them. Runs as the owner role on a scratch database.
 */
export async function seedScale(owner: DatabaseConnection, seed: ScaleSeed): Promise<void> {
  const run = (text: string, values: unknown[] = []) => owner.pool.query(text, values);
  await run(
    `WITH p AS (
       INSERT INTO products (name)
       SELECT jsonb_build_object('en', 'Scale product ' || g) FROM generate_series(1, $1) g
       RETURNING id
     )
     INSERT INTO product_variants (product_id, sku, base_uom_id)
     SELECT id, 'SCALE-' || id, (SELECT id FROM uoms WHERE code = 'pc') FROM p`,
    [seed.skus],
  );
  await run(
    `INSERT INTO locations (code, name, type)
     SELECT 'SCALE-' || g, jsonb_build_object('en', 'Scale warehouse ' || g), 'warehouse'
     FROM generate_series(1, $1) g`,
    [seed.locations],
  );
  await run(
    `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
     SELECT 'scale-' || g, 'seed', 'opening_balance', uuidv7(), now() - interval '1 day'
     FROM generate_series(1, ceil($1 / 10.0)::int) g`,
    [seed.movements],
  );
  await run(
    `WITH v AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n
                FROM product_variants WHERE sku LIKE 'SCALE-%'),
          l AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n
                FROM locations WHERE code LIKE 'SCALE-%'),
          g AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n
                FROM movement_groups WHERE idempotency_key LIKE 'scale-%')
     INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost,
                                  total_cost, effective_at, recorded_at)
     SELECT g.id, v.id, l.id, 10, 2.5, 25.00, now() - interval '1 day', now()
     FROM generate_series(0, $1 - 1) i
     JOIN v ON v.n = i % $2
     JOIN l ON l.n = (i / $2) % $3
     JOIN g ON g.n = i / 10`,
    [seed.movements, seed.skus, seed.locations],
  );
  await run(
    `INSERT INTO stock_levels (variant_id, location_id, on_hand, avg_unit_cost, total_value)
     SELECT variant_id, location_id, sum(quantity), 2.5, sum(total_cost)
     FROM stock_movements GROUP BY 1, 2`,
  );
  await run('ANALYZE');
}

/** A random seeded SKU and location. */
export async function randomScaleKeys(
  owner: DatabaseConnection,
  count: number,
): Promise<{ variantId: string; locationId: string }[]> {
  const { rows } = await owner.pool.query<{ variant_id: string; location_id: string }>(
    `SELECT variant_id, location_id FROM stock_levels TABLESAMPLE SYSTEM (5) LIMIT $1`,
    [count],
  );
  return rows.map((row) => ({ variantId: row.variant_id, locationId: row.location_id }));
}
