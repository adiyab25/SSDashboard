import {
  COST_FIELD_KEYS,
  type AuditEntryDetail,
  type AuditEntryListResponse,
  type AuditEntryView,
} from '@ssdashboard/contracts';
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

/**
 * A diff (`before` or `after`) as a reader may see it (spec 0008 AC-6): unchanged with
 * `showCost`, else a copy without any key in `COST_FIELD_KEYS`, at any depth; null stays null.
 * Pure: it never mutates the diff. The export streams its `before` and `after` cells through it,
 * so a file never carries what the screen would hide.
 */
export function auditDiffFor(
  diff: Record<string, unknown> | null,
  showCost: boolean,
): Record<string, unknown> | null {
  if (showCost || diff === null) return diff;
  return withoutCostFields(diff) as Record<string, unknown>;
}

/** One entry with its `before` and `after` stripped of cost fields. */
function entryWithoutCost<T extends AuditEntryView>(entry: T): T {
  return {
    ...entry,
    before: auditDiffFor(entry.before, false),
    after: auditDiffFor(entry.after, false),
  };
}

/**
 * The cost serializer of the audit list and the record history (spec 0008 AC-6, spec 0010
 * security model: "a diff can carry costs and prices that staff must not see"). For a reader
 * without `cost.view` it removes every key named in `COST_FIELD_KEYS`, at any depth, from each
 * entry's `before` and `after`; a reader with it gets the page unchanged. Pure: it never mutates
 * the page and never reads the database. It must never be skipped on a route that answers an
 * entry's diff.
 */
export function serializeAuditPage(
  page: AuditEntryListResponse,
  access: Pick<Access, 'has'>,
): AuditEntryListResponse {
  if (access.has('cost.view')) return page;
  return { ...page, items: page.items.map(entryWithoutCost) };
}

/**
 * The cost serializer of one entry as the list shows it (spec 0008 AC-6): the answer of an undo
 * (spec 0010 AC-14). For a reader without `cost.view` it strips `before` and `after` like
 * `serializeAuditPage`; a reader with it gets the entry unchanged. Pure; never reads the database.
 */
export function serializeAuditEntry(
  entry: AuditEntryView,
  access: Pick<Access, 'has'>,
): AuditEntryView {
  return access.has('cost.view') ? entry : entryWithoutCost(entry);
}

/**
 * The cost serializer of one entry's detail (spec 0008 AC-6, spec 0010 AC-12): for a reader
 * without `cost.view` it strips `before` and `after` like `serializeAuditPage`, drops every
 * field by field change whose field is a cost key, and strips cost keys inside the values of the
 * changes it keeps. A reader with it gets the detail unchanged. Pure; never reads the database.
 */
export function serializeAuditDetail(
  detail: AuditEntryDetail,
  access: Pick<Access, 'has'>,
): AuditEntryDetail {
  if (access.has('cost.view')) return detail;
  return {
    ...entryWithoutCost(detail),
    changes: detail.changes
      .filter((change) => !COST_KEYS.has(change.field))
      .map((change) => ({
        ...change,
        before: withoutCostFields(change.before),
        after: withoutCostFields(change.after),
      })),
  };
}
