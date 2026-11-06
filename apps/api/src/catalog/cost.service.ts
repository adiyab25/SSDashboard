import { Inject, Injectable } from '@nestjs/common';
import type { CostBasis } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';
import {
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

/**
 * Reads the cost of a SKU on a day from `cost_records` (spec 0002, A12). Read only: records are
 * append only and written by imports and screens of later features. Never changes a movement's
 * frozen cost, and never answers 0 for a cost that is not set.
 */
@Injectable()
export class CostService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

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
    const records: CostRecordCandidate[] = rows.map((row) => ({
      id: row.id,
      variantId: row.variant_id,
      unitCost: row.unit_cost,
      costBasis: row.cost_basis,
      effectiveFrom: row.effective_from,
      recordedAt: row.recorded_at,
    }));
    return selectCost(records, onDate);
  }
}
