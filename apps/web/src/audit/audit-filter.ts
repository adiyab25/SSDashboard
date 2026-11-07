import { z } from 'zod';
import type { AuditFilter } from './audit-api';

/** The filter names, in the order the page URL and the filter bar use them. */
export const FILTER_NAMES = [
  'actorUserId',
  'recordType',
  'recordId',
  'action',
  'dayFrom',
  'dayTo',
  'correlationId',
] as const satisfies readonly (keyof AuditFilter)[];

/** What is wrong with a filter, as a key of `audit.filters.problems`. */
export type FilterProblem = 'recordIdNeedsType' | 'dayOrder' | 'badId' | 'badDay';

/** Each broken rule on the field it belongs to. */
export type FilterProblems = Partial<Record<keyof AuditFilter, FilterProblem>>;

/** Reads the filter out of a URL query; a blank value is no filter. Never throws. */
export function filterFromParams(params: URLSearchParams): AuditFilter {
  const filter: Record<string, string> = {};
  for (const name of FILTER_NAMES) {
    const value = params.get(name)?.trim();
    if (value) filter[name] = value;
  }
  return filter;
}

/** The URL query of a filter (no leading `?`), in a stable order. */
export function paramsFromFilter(filter: AuditFilter): string {
  const params = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = filter[name];
    if (value) params.set(name, value);
  }
  return params.toString();
}

/**
 * What stops this filter from being sent, field by field (`recordIdNeedsType` sits on the record
 * type, `dayOrder` on the first day). The same rules the api's `AuditEntryListQuery` enforces,
 * checked first so a person sees each reason beside its field instead of a 400.
 */
export function filterProblems(filter: AuditFilter): FilterProblems {
  const problems: FilterProblems = {};
  for (const name of ['actorUserId', 'recordId', 'correlationId'] as const) {
    const value = filter[name];
    if (value !== undefined && !z.uuid().safeParse(value).success) problems[name] = 'badId';
  }
  for (const name of ['dayFrom', 'dayTo'] as const) {
    const value = filter[name];
    if (value !== undefined && !z.iso.date().safeParse(value).success) problems[name] = 'badDay';
  }
  if (filter.recordId && !filter.recordType) problems.recordType = 'recordIdNeedsType';
  if (!problems.dayFrom && !problems.dayTo && filter.dayFrom && filter.dayTo) {
    if (filter.dayFrom > filter.dayTo) problems.dayFrom = 'dayOrder';
  }
  return problems;
}

/** The first problem of the filter, or null: whether the page may send it at all. */
export function filterProblem(filter: AuditFilter): FilterProblem | null {
  return Object.values(filterProblems(filter))[0] ?? null;
}
