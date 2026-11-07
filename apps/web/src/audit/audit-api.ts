import {
  AuditEntryDetail,
  AuditEntryListResponse,
  AUDIT_PAGE_DEFAULT,
  type AuditEntryListQuery,
  type AuditExportQuery,
  type StaffRow,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';
import { listStaff } from '@/staff/staff-api';

/**
 * The audit list filters: the list query without its paging. They live in the page's URL query
 * (same names), so a link reproduces the view.
 */
export type AuditFilter = Partial<Omit<AuditEntryListQuery, 'cursor' | 'limit'>>;

/** Query keys of the audit screens. */
export const auditKeys = {
  /** Every audit query, for one invalidation. */
  all: ['audit'] as const,
  /** The entry list for one filter. */
  list: (filter: AuditFilter) => ['audit', 'list', filter] as const,
  /** One entry with its field diff. */
  entry: (id: string) => ['audit', 'entry', id] as const,
  /** The history of one record. */
  record: (type: string, id: string) => ['audit', 'record', type, id] as const,
  /** The people the person filter offers. */
  people: ['audit', 'people'] as const,
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

/** One entry with its field by field diff (`GET /api/audit/entries/:id`). */
export function getAuditEntry(id: string, signal?: AbortSignal) {
  return apiRequest('GET', `/api/audit/entries/${encodeURIComponent(id)}`, AuditEntryDetail, {
    signal,
  });
}

/** One page of the entries of one record, newest first (`GET /api/audit/records/:type/:id/entries`). */
export function listRecordHistory(
  recordType: string,
  recordId: string,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_DEFAULT) });
  if (cursor) params.set('cursor', cursor);
  return apiRequest(
    'GET',
    `/api/audit/records/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}/entries?${params}`,
    AuditEntryListResponse,
    { signal },
  );
}

/** Pages of the staff list the person filter reads, at most (50 a page: 500 people). */
const PEOPLE_PAGES_MAX = 10;

/**
 * The people the person filter offers: the staff list the Staff page reads (`listStaff`), page by
 * page. Throws when a page cannot be read, so the query shows its error.
 */
export async function listPeople(): Promise<StaffRow[]> {
  const people: StaffRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PEOPLE_PAGES_MAX; page += 1) {
    const result = await listStaff({ q: '', status: '', hat: '' }, cursor);
    if (!result.ok) throw new Error(`The staff list answered ${result.status} ${result.code}`);
    people.push(...result.data.rows);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return people;
}

/**
 * The export request as a relative url: the filter plus the required day range. The reason never
 * goes in the url (an access log would keep it, Law 151): it travels in the `x-audit-reason` header.
 */
export function exportUrl(query: Omit<AuditExportQuery, 'reason'>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  return `/api/audit/entries/export?${params}`;
}
