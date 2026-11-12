import { Inject, Injectable } from '@nestjs/common';
import type { CostBasis, VariantCost } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray, type Executor } from '../database/sql.js';
import {
  pickCostRecord,
  selectCost,
  type CostRecordCandidate,
  type CostSet,
  type NotSet,
} from './cost-selection.js';

export type { CostSet, NotSet } from './cost-selection.js';

interface CostRow extends Record<string, unknown> {
  id: string;
  variant_id: string | null;
  unit_cost: string;
  cost_basis: CostBasis;
  effective_from: string;
  recorded_at: string;
}

/** A candidate row of `costForMany`, tagged with the variant it was read for. */
interface ManyCostRow extends CostRow {
  for_id: string;
}

const toCandidate = (row: CostRow): CostRecordCandidate => ({
  id: row.id,
  variantId: row.variant_id,
  unitCost: row.unit_cost,
  costBasis: row.cost_basis,
  effectiveFrom: row.effective_from,
  recordedAt: row.recorded_at,
});

/**
 * Reads the cost of a SKU on a day from `cost_records` (spec 0002, A12), one variant
 * (`costFor`) or many in one query (`costForMany`, spec 0012 AC-12). Read only: records are
 * append only and added by `cost-records/` (`CostRecordsService`) and later imports. Never
 * changes a movement's frozen cost, and never answers 0 for a cost that is not set.
 */
@Injectable()
export class CostService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Today's operating day (`ssd_operating_day(now())`, `YYYY-MM-DD`): the day the style page
   * reads cost for and the backdating rule of a new record compares with (spec 0012).
   */
  async today(executor: Executor = this.connection.db): Promise<string> {
    const { rows } = await executor.execute<{ day: string }>(
      sql`SELECT to_char(ssd_operating_day(now()), 'YYYY-MM-DD') AS day`,
    );
    const day = rows[0]?.day;
    if (!day) throw new Error('ssd_operating_day returned no row');
    return day;
  }

  /**
   * The unit cost and cost basis of a variant on `onDate` (`YYYY-MM-DD`), from the variant's own
   * override or its style's record by the selection rule in `selectCost`; `not_set` when none
   * applies or the variant does not exist.
   */
  async costFor(
    variantId: string,
    onDate: string,
    executor: Executor = this.connection.db,
  ): Promise<CostSet | NotSet> {
    // Only the records on the latest applicable day come back; the rule picks among them.
    const { rows } = await executor.execute<CostRow>(sql`
      WITH candidates AS (
        SELECT c.id, c.variant_id, c.unit_cost, c.cost_basis, c.effective_from, c.recorded_at
        FROM product_variants v
        JOIN cost_records c ON c.product_id = v.product_id
         AND (c.variant_id = v.id OR c.variant_id IS NULL)
        WHERE v.id = ${variantId} AND c.effective_from <= ${onDate}::date)
      SELECT id, variant_id, unit_cost, cost_basis,
             to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
             to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS recorded_at
      FROM candidates
      WHERE effective_from = (SELECT max(effective_from) FROM candidates)
      ORDER BY id`);
    return selectCost(rows.map(toCandidate), onDate);
  }

  /**
   * The cost in force on `onDate` (`YYYY-MM-DD`) of every variant in `variantIds`, in one query
   * (spec 0012, AC-12): for each id exactly what `costFor` answers for it (the same candidates and
   * the same `selectCost` rule), plus the chosen record's `effectiveFrom` and `inheritedFrom`
   * (`style` for the style's record, `variant` for an override). An unknown id is `not_set`.
   * Keyed by each id as given. Read only; never answers 0 for a cost that is not set.
   */
  async costForMany(
    variantIds: readonly string[],
    onDate: string,
    executor: Executor = this.connection.db,
  ): Promise<Map<string, VariantCost>> {
    const result = new Map<string, VariantCost>();
    if (!variantIds.length) return result;
    const ids = [...new Set(variantIds.map((id) => id.toLowerCase()))];
    // Per variant, only the records on its latest applicable day come back, as in `costFor`.
    const { rows } = await executor.execute<ManyCostRow>(sql`
      WITH candidates AS (
        SELECT v.id AS for_id, c.id, c.variant_id, c.unit_cost, c.cost_basis, c.effective_from,
               c.recorded_at,
               max(c.effective_from) OVER (PARTITION BY v.id) AS latest
        FROM product_variants v
        JOIN cost_records c ON c.product_id = v.product_id
         AND (c.variant_id = v.id OR c.variant_id IS NULL)
        WHERE v.id = ANY(${pgArray(ids)}::uuid[]) AND c.effective_from <= ${onDate}::date)
      SELECT for_id, id, variant_id, unit_cost, cost_basis,
             to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
             to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS recorded_at
      FROM candidates
      WHERE effective_from = latest
      ORDER BY for_id, id`);
    const byVariant = new Map<string, CostRecordCandidate[]>();
    for (const row of rows) {
      const key = row.for_id.toLowerCase();
      byVariant.set(key, [...(byVariant.get(key) ?? []), toCandidate(row)]);
    }
    for (const id of variantIds) {
      const best = pickCostRecord(byVariant.get(id.toLowerCase()) ?? [], onDate);
      result.set(
        id,
        best
          ? {
              status: 'set',
              unitCost: best.unitCost,
              costBasis: best.costBasis,
              effectiveFrom: best.effectiveFrom,
              inheritedFrom: best.variantId === null ? 'style' : 'variant',
            }
          : { status: 'not_set' },
      );
    }
    return result;
  }
}
