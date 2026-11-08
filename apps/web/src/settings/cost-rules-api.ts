import { CostRuleRow, CostRulesResponse, type RecordCostRuleBody } from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the Cost rules page. */
export const costRuleKeys = {
  /** Every page of the rules answer, for one invalidation. */
  all: ['platform', 'cost-rules'] as const,
};

/** How many history rows one page asks for. */
const PAGE_SIZE = 50;

/**
 * The rules in force today, one page of the history (newest first), and the lock date (spec
 * 0009, AC-23; needs `cost.view`). `cursor` is the `nextCursor` of the page before.
 */
export function listCostRules(cursor: string | undefined, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return apiRequest('GET', `/api/platform/cost-rules?${query.toString()}`, CostRulesResponse, {
    signal,
  });
}

/**
 * Records a new rule from its start day (spec 0009, AC-23; needs `settings.manage` and
 * `cost.view`). A start day on or before the lock date answers 409 `COST_RULE_IN_LOCKED_PERIOD`
 * with the months it would change, unless `inLockedPeriod` is true.
 */
export function recordCostRule(body: RecordCostRuleBody) {
  return apiRequest('POST', '/api/platform/cost-rules', CostRuleRow, { body });
}
