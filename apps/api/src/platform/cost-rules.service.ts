import { Inject, Injectable } from '@nestjs/common';
import type { CostRule, OrderCostRuleKind, OrderCostRuleStatus } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';
import {
  assertOperatingDay,
  selectCostRule,
  type CostRuleCandidate,
} from './cost-rule-selection.js';

interface CostRuleRow extends Record<string, unknown> {
  id: string;
  status: OrderCostRuleStatus;
  value: string | null;
  effective_from: string;
  recorded_at: string;
}

/**
 * Reads the per order cost rules (COD fee percent, gateway fee percent, packaging per order,
 * unrestockable returned to origin percent) from `order_cost_rules` (spec 0002, catalog child,
 * AC-32). Read only: the rows are append only, seeded `not_set` by `migrate`, and edited by a
 * later feature's screen (feature 9). Never answers 0 for a rule that is not set.
 */
@Injectable()
export class CostRulesService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * The rule of `kind` in force on `onDay` (`YYYY-MM-DD`, an operating day): status `set` with
   * the value as `numeric(14,4)` text (a percent from 0 to 100, or EGP for `packaging_per_order`),
   * or status `not_set` before the first row or when the winning row is `not_set`, never 0.
   * Selection is `selectCostRule`. A day that is not a `YYYY-MM-DD` calendar date throws
   * `InvalidOperatingDay` before any query runs.
   */
  async ruleFor(
    kind: OrderCostRuleKind,
    onDay: string,
    executor: Executor = this.connection.db,
  ): Promise<CostRule> {
    assertOperatingDay(onDay);
    // Only the rows on the latest applicable day come back; the rule picks among them.
    const { rows } = await executor.execute<CostRuleRow>(sql`
      WITH candidates AS (
        SELECT id, status, value, effective_from, recorded_at
        FROM order_cost_rules
        WHERE kind = ${kind}::order_cost_rule_kind AND effective_from <= ${onDay}::date)
      SELECT id, status, value,
             to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
             to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS recorded_at
      FROM candidates
      WHERE effective_from = (SELECT max(effective_from) FROM candidates)
      ORDER BY id`);
    const candidates: CostRuleCandidate[] = rows.map((row) => ({
      id: row.id,
      status: row.status,
      value: row.value,
      effectiveFrom: row.effective_from,
      recordedAt: row.recorded_at,
    }));
    return selectCostRule(candidates, onDay);
  }
}
