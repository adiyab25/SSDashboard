import {
  AuditEntryListResponse,
  AUDIT_PAGE_DEFAULT,
  type AuditEntryListQuery,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/**
 * The audit list filters. Milestone 1 sends none; milestone 3 fills them from the filter bar and
 * they join the query key, so a changed filter starts a fresh list.
 */
export type AuditFilter = Partial<Omit<AuditEntryListQuery, 'cursor' | 'limit'>>;

/** Query keys of the audit screens. */
export const auditKeys = {
  /** Every audit query, for one invalidation. */
  all: ['audit'] as const,
  /** The entry list for one filter. */
  list: (filter: AuditFilter) => ['audit', 'list', filter] as const,
};

/** One page of audit entries, newest first, narrowed by the filter (needs `audit.read`: 403 otherwise). */
export function listAuditEntries(
  filter: AuditFilter,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_DEFAULT) });
  for (const [name, value] of Object.entries(filter)) {
    if (value !== undefined) params.set(name, String(value));
  }
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/audit/entries?${params}`, AuditEntryListResponse, { signal });
}
