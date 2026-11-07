import { COST_FIELD_KEYS, type AuditEntryListResponse } from '@ssdashboard/contracts';
import type { Access } from '../platform/access/access.js';

const COST_KEYS: ReadonlySet<string> = new Set(COST_FIELD_KEYS);

/** A copy of `value` without any object key in `COST_FIELD_KEYS`, at any depth. */
function withoutCostFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCostFields);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !COST_KEYS.has(key))
      .map(([key, item]) => [key, withoutCostFields(item)]),
  );
}

const diffWithoutCost = (diff: Record<string, unknown> | null): Record<string, unknown> | null =>
  diff === null ? null : (withoutCostFields(diff) as Record<string, unknown>);

/**
 * The cost serializer of the audit list (spec 0008 AC-6, spec 0010 security model: "a diff can
 * carry costs and prices that staff must not see"). For a reader without `cost.view` it removes
 * every key named in `COST_FIELD_KEYS`, at any depth, from each entry's `before` and `after`; a
 * reader with it gets the page unchanged. Pure: it never mutates the page and never reads the
 * database. It must never be skipped on a route that answers an entry's diff.
 */
export function serializeAuditPage(
  page: AuditEntryListResponse,
  access: Pick<Access, 'has'>,
): AuditEntryListResponse {
  if (access.has('cost.view')) return page;
  return {
    ...page,
    items: page.items.map((entry) => ({
      ...entry,
      before: diffWithoutCost(entry.before),
      after: diffWithoutCost(entry.after),
    })),
  };
}
