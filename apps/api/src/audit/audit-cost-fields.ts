import {
  COST_FIELD_KEYS,
  type AuditEntryDetail,
  type AuditEntryListResponse,
  type AuditEntryView,
} from '@ssdashboard/contracts';
import type { Access } from '../platform/access/access.js';

/**
 * A key as the cost match compares it (security review AS30): lower case, without `_`, `-`, or
 * white space, the normalisation the route sweep's `normalKey` uses, so `unit_cost`, `UnitCost`,
 * and `unit-cost` all meet `unitCost`.
 */
export function normalCostKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

const COST_KEYS: ReadonlySet<string> = new Set(COST_FIELD_KEYS.map(normalCostKey));

/** Whether `key` names a cost field in any spelling (`COST_FIELD_KEYS`, normalised). Pure. */
export function isCostKey(key: string): boolean {
  return COST_KEYS.has(normalCostKey(key));
}

/** What a string holds when it is JSON object or array text, else undefined (review M4R8). */
function parsedJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A copy of `value` without any object key that names a cost field (`isCostKey`), at any depth.
 * A string that is JSON object or array text (a diff may store a payload as text, security
 * review AS9) is walked too and written back as JSON when a cost key left it (review M4R8,
 * security review AS30); any other string is kept as it is.
 */
function withoutCostFields(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parsedJsonText(value);
    if (parsed === undefined) return value;
    const stripped = withoutCostFields(parsed);
    return JSON.stringify(stripped) === JSON.stringify(parsed) ? value : JSON.stringify(stripped);
  }
  if (Array.isArray(value)) return value.map(withoutCostFields);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isCostKey(key))
      .map(([key, item]) => [key, withoutCostFields(item)]),
  );
}

/**
 * A diff (`before` or `after`) as a reader may see it (spec 0008 AC-6): unchanged with
 * `showCost`, else a copy without any cost key (`isCostKey`: `COST_FIELD_KEYS` in any spelling),
 * at any depth and inside JSON text; null stays null.
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

/**
 * The action codes whose whole entry is a cost (spec 0012 AC-17, the owner's ruling of 2026-11-11
 * "Hide whole entry"): a cost record's entry carries the amount and a reason typed next to it, so
 * a reader without `cost.view` never sees such an entry at all, in any list, history, detail,
 * undo, count, or export. None of them is undoable, so no undone code is listed.
 */
export const COST_ENTRY_ACTIONS: readonly string[] = ['cost_record.recorded'];

const COST_ENTRY_ACTION_SET: ReadonlySet<string> = new Set(COST_ENTRY_ACTIONS);

/**
 * Whether a reader may see an entry of `action` at all: always with `showCost`, else only when
 * the action is not in `COST_ENTRY_ACTIONS`. Pure. The readers filter these entries out in SQL
 * (`visibleEntries` in `audit-query.service.ts`) so paging stays whole; this is the same rule for
 * a row already read (the undo's target).
 */
export function isEntryVisible(action: string, showCost: boolean): boolean {
  return showCost || !COST_ENTRY_ACTION_SET.has(action);
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
      .filter((change) => !isCostKey(change.field))
      .map((change) => ({
        ...change,
        before: withoutCostFields(change.before),
        after: withoutCostFields(change.after),
      })),
  };
}
