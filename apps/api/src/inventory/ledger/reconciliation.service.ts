import { Inject, Injectable } from '@nestjs/common';
import type { StockLevel } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { CatalogLocks } from '../../catalog/catalog-locks.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray } from '../../database/sql.js';
import { LedgerError } from './ledger.errors.js';
import { ledgerTransaction, lockPairs } from './locks.js';

/** What one place should hold according to its movements, and what the balance says. */
const KEY = 'variant_id, location_id, bin_id, lot_id';

/**
 * The nightly proof that balances match the ledger (AC-11). It only reads movements and
 * records mismatches; an admin approves each rebuild. Movements are never touched.
 */
@Injectable()
export class ReconciliationService {
  /** Takes the app database connection. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CatalogLocks) private readonly catalog: CatalogLocks,
  ) {}

  /**
   * Compares every balance with its movement sums, reservation totals with on hand, and
   * in stock serial counts with on hand, all in one REPEATABLE READ snapshot, so postings
   * running meanwhile never show up as a false mismatch. Returns how many it found; each
   * stays one open record per balance and kind, however many runs see it.
   */
  async reconcile(): Promise<number> {
    return this.connection.db.transaction(
      async (tx) => {
        const balances = await tx.execute<{ found: number }>(sql`
          WITH sums AS (
            SELECT ${sql.raw(KEY)}, sum(quantity) AS on_hand, sum(total_cost) AS total_value
            FROM stock_movements GROUP BY 1, 2, 3, 4
          ), found AS (
            SELECT sl.id AS stock_level_id,
                   coalesce(sl.variant_id, s.variant_id) AS variant_id,
                   coalesce(sl.location_id, s.location_id) AS location_id,
                   coalesce(sl.bin_id, s.bin_id) AS bin_id,
                   coalesce(sl.lot_id, s.lot_id) AS lot_id,
                   jsonb_build_object('onHand', coalesce(s.on_hand, 0),
                                      'totalValue', coalesce(s.total_value, 0)::numeric(14,2)::text) AS expected,
                   jsonb_build_object('onHand', coalesce(sl.on_hand, 0),
                                      'totalValue', coalesce(sl.total_value, 0)::numeric(14,2)::text) AS actual
            FROM stock_levels sl
            FULL JOIN sums s
              ON s.variant_id = sl.variant_id AND s.location_id = sl.location_id
             AND s.bin_id IS NOT DISTINCT FROM sl.bin_id AND s.lot_id IS NOT DISTINCT FROM sl.lot_id
            WHERE coalesce(sl.on_hand, 0) <> coalesce(s.on_hand, 0)
               OR coalesce(sl.total_value, 0) <> coalesce(s.total_value, 0)
          ), recorded AS (
            ${this.record('balance')}
          )
          SELECT count(*)::int AS found FROM found`);

        // Reserved stock never exceeds on hand (summed over bins, floored at 0: a carrier shipment may
        // leave on hand below zero, where nothing is held) where stock cannot go negative.
        const reservations = await tx.execute<{ found: number }>(sql`
          WITH reserved AS (
            SELECT variant_id, location_id, lot_id, sum(open_quantity) AS reserved
            FROM reservations WHERE status = 'active' GROUP BY 1, 2, 3
          ), on_hand AS (
            SELECT variant_id, location_id, lot_id, sum(on_hand) AS on_hand
            FROM stock_levels GROUP BY 1, 2, 3
          ), found AS (
            SELECT NULL::uuid AS stock_level_id, r.variant_id, r.location_id, NULL::uuid AS bin_id,
                   r.lot_id,
                   jsonb_build_object('maxReserved', greatest(coalesce(o.on_hand, 0), 0)) AS expected,
                   jsonb_build_object('reserved', r.reserved) AS actual
            FROM reserved r
            JOIN locations l ON l.id = r.location_id AND NOT l.allow_negative
            LEFT JOIN on_hand o
              ON o.variant_id = r.variant_id AND o.location_id = r.location_id
             AND o.lot_id IS NOT DISTINCT FROM r.lot_id
            WHERE r.reserved > greatest(coalesce(o.on_hand, 0), 0)
          ), recorded AS (
            ${this.record('reservation')}
          )
          SELECT count(*)::int AS found FROM found`);

        // For serial SKUs, the serials in stock at a place equal its on hand. Which SKUs are
        // serial tracked is the catalog's to say (spec 0011 AC-18), read inside this snapshot.
        const serialVariantIds = await this.catalog.serialTrackedVariantIds(tx);
        const serials = await tx.execute<{ found: number }>(sql`
          WITH counted AS (
            SELECT ${sql.raw(KEY)}, count(*)::int AS in_stock
            FROM serials WHERE status = 'in_stock' GROUP BY 1, 2, 3, 4
          ), levels AS (
            SELECT sl.* FROM stock_levels sl
            WHERE sl.variant_id = ANY(${pgArray(serialVariantIds)}::uuid[])
          ), found AS (
            SELECT lv.id AS stock_level_id,
                   coalesce(lv.variant_id, c.variant_id) AS variant_id,
                   coalesce(lv.location_id, c.location_id) AS location_id,
                   coalesce(lv.bin_id, c.bin_id) AS bin_id,
                   coalesce(lv.lot_id, c.lot_id) AS lot_id,
                   jsonb_build_object('inStockSerials', coalesce(lv.on_hand, 0)) AS expected,
                   jsonb_build_object('inStockSerials', coalesce(c.in_stock, 0)) AS actual
            FROM levels lv
            FULL JOIN counted c
              ON c.variant_id = lv.variant_id AND c.location_id = lv.location_id
             AND c.bin_id IS NOT DISTINCT FROM lv.bin_id AND c.lot_id IS NOT DISTINCT FROM lv.lot_id
            WHERE coalesce(lv.on_hand, 0) <> coalesce(c.in_stock, 0)
          ), recorded AS (
            ${this.record('serial')}
          )
          SELECT count(*)::int AS found FROM found`);

        return [balances, reservations, serials].reduce(
          (total, result) => total + (result.rows[0]?.found ?? 0),
          0,
        );
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  /**
   * Recomputes one balance from its movements, as an admin approved fix for an open
   * discrepancy, and records who did it and when. The average follows the rebuild formula:
   * round(total_value / on_hand, 4) when on hand is above 0, else the kept one. It reads the
   * SKU and location rows `FOR SHARE` before `lockPairs`, like every other balance writer
   * (spec 0006, Key invariants).
   */
  async rebuildLevel(input: { discrepancyId: string; resolvedBy: string }): Promise<StockLevel> {
    return ledgerTransaction(this.connection.db, async (tx) => {
      const discrepancy = (
        await tx.execute<{
          variant_id: string;
          location_id: string;
          bin_id: string | null;
          lot_id: string | null;
          kind: 'balance' | 'reservation' | 'serial';
          resolved: boolean;
        }>(sql`
            SELECT variant_id, location_id, bin_id, lot_id, kind,
                   resolved_at IS NOT NULL AS resolved
            FROM stock_level_discrepancies WHERE id = ${input.discrepancyId} FOR UPDATE`)
      ).rows[0];
      if (!discrepancy) {
        throw new LedgerError('NotFound', `Discrepancy ${input.discrepancyId} not found`);
      }
      if (discrepancy.resolved) {
        throw new LedgerError('DiscrepancyClosed', 'This discrepancy is already resolved');
      }
      // Recomputing a balance cannot fix a reservation total or a serial count, so marking
      // those "rebuilt" would record a fix that never happened.
      if (discrepancy.kind !== 'balance') {
        throw new LedgerError(
          'NotRebuildable',
          `A ${discrepancy.kind} discrepancy is not fixed by rebuilding a balance`,
        );
      }
      const { variant_id: variantId, location_id: locationId } = discrepancy;
      // The SKU and location rows FOR SHARE, as `loadMaster` (SKU first, then location), before
      // `lockPairs`: a rebuild joins the archive exclusion, so an archive (row FOR UPDATE in
      // `lockForArchive`) waits for it, and it waits for an archive holding the row.
      const variant = await this.catalog.lockForShare(tx, [variantId]);
      if (!variant.has(variantId)) throw new LedgerError('NotFound', `SKU ${variantId} not found`);
      const location = await tx.execute(
        sql`SELECT id FROM locations WHERE id = ${locationId} FOR SHARE`,
      );
      if (!location.rows.length) {
        throw new LedgerError('NotFound', `Location ${locationId} not found`);
      }
      await lockPairs(tx, [[variantId, locationId]]);
      const level = (
        await tx.execute<{
          id: string;
          on_hand: number;
          avg_unit_cost: string;
          total_value: string;
        }>(sql`
            WITH sums AS (
              SELECT coalesce(sum(quantity), 0)::int AS on_hand,
                     coalesce(sum(total_cost), 0) AS total_value
              FROM stock_movements
              WHERE variant_id = ${variantId} AND location_id = ${locationId}
                AND bin_id IS NOT DISTINCT FROM ${discrepancy.bin_id}::uuid
                AND lot_id IS NOT DISTINCT FROM ${discrepancy.lot_id}::uuid
            )
            INSERT INTO stock_levels (variant_id, location_id, bin_id, lot_id, on_hand, total_value,
                                      avg_unit_cost)
            SELECT ${variantId}, ${locationId}, ${discrepancy.bin_id}::uuid, ${discrepancy.lot_id}::uuid,
                   on_hand, total_value,
                   CASE WHEN on_hand > 0 THEN round(total_value / on_hand, 4) ELSE 0 END
            FROM sums
            ON CONFLICT ON CONSTRAINT stock_levels_key_unique DO UPDATE
            SET on_hand = excluded.on_hand,
                total_value = excluded.total_value,
                avg_unit_cost = CASE WHEN excluded.on_hand > 0 THEN excluded.avg_unit_cost
                                     ELSE stock_levels.avg_unit_cost END,
                updated_at = now()
            RETURNING id, on_hand, avg_unit_cost, total_value`)
      ).rows[0];
      if (!level) throw new Error('The rebuild returned no balance');
      await tx.execute(sql`
          UPDATE stock_level_discrepancies
          SET resolved_at = now(), resolved_by = ${input.resolvedBy}, resolution = 'rebuilt',
              stock_level_id = ${level.id}
          WHERE id = ${input.discrepancyId}`);
      return {
        id: level.id,
        variantId,
        locationId,
        binId: discrepancy.bin_id,
        lotId: discrepancy.lot_id,
        onHand: level.on_hand,
        avgUnitCost: level.avg_unit_cost,
        totalValue: level.total_value,
      };
    });
  }

  /** Inserts the `found` rows as open discrepancies, at most one open per balance and kind. */
  private record(kind: 'balance' | 'reservation' | 'serial') {
    return sql`
      INSERT INTO stock_level_discrepancies (stock_level_id, ${sql.raw(KEY)}, kind, expected, actual)
      SELECT stock_level_id, ${sql.raw(KEY)}, ${kind}::discrepancy_kind, expected, actual FROM found
      ON CONFLICT (tenant_id, kind, ${sql.raw(KEY)}) WHERE resolved_at IS NULL DO NOTHING
      RETURNING 1`;
  }
}
