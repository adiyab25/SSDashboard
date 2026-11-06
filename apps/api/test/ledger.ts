import { randomUUID } from 'node:crypto';
import type { PostingInput, PostingLine } from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { SettingsService } from '../src/platform/settings.service.js';
import { createScratchDatabase, dropScratchDatabase } from './support.js';

/**
 * A migrated scratch database with the ledger service connected as the application role,
 * plus an owner connection for fixtures and for what only the owner may do in tests.
 */
export interface LedgerHarness {
  ledger: LedgerService;
  app: DatabaseConnection;
  owner: DatabaseConnection;
  close(): Promise<void>;
}

/**
 * Creates a migrated scratch database and connects the ledger as the application role, so tests
 * hit the same privileges as production. Call `close` to drop the database.
 */
export async function ledgerHarness(): Promise<LedgerHarness> {
  const scratch = await createScratchDatabase();
  await runMigrations(scratch.url);
  const appUrl = new URL(scratch.url);
  // The owner logs in, then acts with exactly the application role's privileges.
  appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
  const app = createDatabase(appUrl.toString(), { max: 40 });
  const owner = createDatabase(scratch.url, { max: 4 });
  const ledger = new LedgerService(app, new SettingsService(app));
  return {
    ledger,
    app,
    owner,
    async close() {
      await app.pool.end();
      await owner.pool.end();
      await dropScratchDatabase(scratch.name);
    },
  };
}

let sequence = 0;
const next = () => `${Date.now().toString(36)}${(sequence += 1)}`;

async function insertOne(owner: DatabaseConnection, text: string, values: unknown[]) {
  const { rows } = await owner.pool.query<{ id: string }>(text, values);
  const row = rows[0];
  if (!row) throw new Error(`no row from: ${text}`);
  return row.id;
}

/**
 * Inserts rows as the owner (users, SKUs, locations and the like) that ledger tests need, and
 * returns their ids. Bypasses the services on purpose, so a test sets up exactly the state it
 * names.
 */
export function fixtures(owner: DatabaseConnection) {
  return {
    /** A staff account, so `posted_by` has a real user to point at (spec 0005, AC-22). */
    async user(): Promise<string> {
      const tag = next();
      return insertOne(owner, `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id`, [
        `Test user ${tag}`,
        `user-${tag}@example.test`,
      ]);
    },
    async variant(
      options: {
        tracking?: 'none' | 'lot' | 'serial';
        kind?: 'stocked' | 'service' | 'bundle';
      } = {},
    ): Promise<string> {
      const product = await insertOne(
        owner,
        `INSERT INTO products (style_code, product_group_id, name) VALUES ($1, (SELECT id FROM product_groups WHERE code = 'MAIN'), '{"en": "Test product"}') RETURNING id`,
        [`STYLE-${next()}`],
      );
      return insertOne(
        owner,
        `INSERT INTO product_variants (product_id, sku, kind, tracking, base_uom_id)
         VALUES ($1, $2, $3, $4, (SELECT id FROM uoms WHERE code = 'pc')) RETURNING id`,
        [product, `SKU-${next()}`, options.kind ?? 'stocked', options.tracking ?? 'none'],
      );
    },
    location(options: { allowNegative?: boolean; isSellable?: boolean } = {}): Promise<string> {
      return insertOne(
        owner,
        `INSERT INTO locations (code, name, kind, allow_negative, is_sellable)
         VALUES ($1, '{"en": "Warehouse"}', 'warehouse', $2, $3) RETURNING id`,
        [`WH-${next()}`, options.allowNegative ?? false, options.isSellable ?? true],
      );
    },
    bin(locationId: string, options: { isSellable?: boolean } = {}): Promise<string> {
      return insertOne(
        owner,
        `INSERT INTO bins (location_id, code, is_sellable) VALUES ($1, $2, $3) RETURNING id`,
        [locationId, `BIN-${next()}`, options.isSellable ?? true],
      );
    },
    lot(variantId: string): Promise<string> {
      return insertOne(owner, `INSERT INTO lots (variant_id, code) VALUES ($1, $2) RETURNING id`, [
        variantId,
        `LOT-${next()}`,
      ]);
    },
    async archive(table: 'product_variants' | 'locations' | 'bins', id: string): Promise<void> {
      await owner.pool.query(`UPDATE ${table} SET archived_at = now() WHERE id = $1`, [id]);
    },
  };
}

/** A posting with a fresh key and source unless given. */
export function posting(
  lines: PostingLine[],
  overrides: Partial<Omit<PostingInput, 'lines'>> = {},
): PostingInput {
  return {
    idempotencyKey: randomUUID(),
    sourceType: 'adjustment',
    sourceId: randomUUID(),
    postedBy: null,
    lines,
    ...overrides,
  };
}

/** Balances that differ from their movement sums (AC-1). Empty when the ledger is consistent. */
export async function driftedBalances(owner: DatabaseConnection): Promise<unknown[]> {
  const { rows } = await owner.pool.query<Record<string, unknown>>(`
    SELECT coalesce(sl.variant_id, m.variant_id) AS variant_id, sl.on_hand, m.quantity,
           sl.total_value, m.value
    FROM stock_levels sl
    FULL JOIN (
      SELECT variant_id, location_id, bin_id, lot_id, sum(quantity) AS quantity,
             sum(total_cost) AS value
      FROM stock_movements GROUP BY 1, 2, 3, 4
    ) m ON m.variant_id = sl.variant_id AND m.location_id = sl.location_id
       AND m.bin_id IS NOT DISTINCT FROM sl.bin_id AND m.lot_id IS NOT DISTINCT FROM sl.lot_id
    WHERE coalesce(sl.on_hand, 0) <> coalesce(m.quantity, 0)
       OR coalesce(sl.total_value, 0) <> coalesce(m.value, 0)`);
  return rows;
}

/** Reads one place's balance row as the owner; a place that never held stock reads as zero. */
export async function level(
  owner: DatabaseConnection,
  key: { variantId: string; locationId: string; binId?: string; lotId?: string },
): Promise<{ onHand: number; totalValue: string; avgUnitCost: string }> {
  const { rows } = await owner.pool.query<{
    on_hand: number;
    total_value: string;
    avg_unit_cost: string;
  }>(
    `SELECT on_hand, total_value, avg_unit_cost FROM stock_levels
     WHERE variant_id = $1 AND location_id = $2
       AND bin_id IS NOT DISTINCT FROM $3::uuid AND lot_id IS NOT DISTINCT FROM $4::uuid`,
    [key.variantId, key.locationId, key.binId ?? null, key.lotId ?? null],
  );
  const row = rows[0];
  if (!row) return { onHand: 0, totalValue: '0.00', avgUnitCost: '0.0000' };
  return { onHand: row.on_hand, totalValue: row.total_value, avgUnitCost: row.avg_unit_cost };
}
