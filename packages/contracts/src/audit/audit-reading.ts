import { z } from 'zod';
import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, AuditEntryView } from './audit-entries.js';

/**
 * One changed field of an entry, as the detail screen shows it (spec 0010, AC-12): the top level
 * field name, its value before and after (null when the side has no such field: a creation has
 * no `before`), and whether it holds personal data the trail masked. A personal field's values are
 * `"[REDACTED]"`; the screen shows "hidden, personal data" instead of them.
 */
export const AuditFieldChange = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  personal: z.boolean(),
});
/** One changed field of an entry. */
export type AuditFieldChange = z.infer<typeof AuditFieldChange>;

/**
 * `GET /api/audit/entries/:id` (spec 0010, AC-12, API surface): the entry and its field by field
 * diff, the union of the `before` and `after` fields in their stored order.
 */
export const AuditEntryDetail = AuditEntryView.extend({
  changes: z.array(AuditFieldChange),
});
/** One entry with its field diff. */
export type AuditEntryDetail = z.infer<typeof AuditEntryDetail>;

/** The shape of a record type code in a path (`stock_receipt`, `sku`). */
const RecordTypeCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * The record a history panel shows (spec 0010, task 13): the path parameters of
 * `GET /api/audit/records/:type/:id/entries`.
 */
export const AuditRecordRef = z.object({ type: RecordTypeCode, id: z.uuid() }).strict();
/** The record of a history panel. */
export type AuditRecordRef = z.infer<typeof AuditRecordRef>;

/**
 * The query of `GET /api/audit/records/:type/:id/entries`: one keyset page of the record's
 * entries, newest first, with the list's paging rules (no offset, no count). The answer is an
 * `AuditEntryListResponse`.
 */
export const AuditRecordHistoryQuery = z
  .object({
    cursor: z.string().min(1).max(400).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
  })
  .strict();
/** The validated history query. */
export type AuditRecordHistoryQuery = z.infer<typeof AuditRecordHistoryQuery>;

/** Most rows one export file holds (spec 0010, AC-15); more answers 413 `EXPORT_TOO_LARGE`. */
export const AUDIT_EXPORT_MAX_ROWS = 200_000;

/**
 * Most operating days one export covers, counted inclusively: `dayFrom` to `dayTo`, both ends
 * included (spec 0010, AC-15, review M3R8). Check a range with `auditExportDayCount`.
 */
export const AUDIT_EXPORT_MAX_DAYS = 366;

/** Rows read per keyset batch while an export streams (spec 0010, AC-15). */
export const AUDIT_EXPORT_BATCH = 1_000;

/**
 * The columns of an export file, in order (spec 0010, task 14). Stable: a later change appends a
 * column, never renames or reorders one, so a spreadsheet built on the file keeps working.
 * `recorded_at` is the install time zone's wall clock with microseconds; `actor` is the person's
 * name for a person or partner user, else the actor reference (job name, connection, run, or
 * customer id); `action_label` is the English label; `before`, `after` are JSON;
 * `personal_fields` is the masked paths joined with `;`.
 */
export const AUDIT_EXPORT_COLUMNS = [
  'recorded_at',
  'operating_day',
  'actor_kind',
  'actor',
  'actor_hat',
  'action',
  'action_label',
  'record_type',
  'record_id',
  'record_label',
  'reason',
  'before',
  'after',
  'personal_fields',
  'correlation_id',
  'entry_id',
] as const;

const OperatingDay = z.iso.date().refine((day) => day >= '0001-01-01', {
  message: 'The day must be in year 1 or later',
});

const DAY_MS = 86_400_000;

/**
 * The number of operating days from `dayFrom` to `dayTo`, both included (`2026-01-01` to
 * `2026-01-01` is 1). The one meaning of an export's length, for the api and the web alike; a
 * range is allowed when this is at most `AUDIT_EXPORT_MAX_DAYS`. Days are `YYYY-MM-DD`.
 */
export function auditExportDayCount(dayFrom: string, dayTo: string): number {
  return Math.round((Date.parse(dayTo) - Date.parse(dayFrom)) / DAY_MS) + 1;
}

/**
 * The request header that carries an export's optional reason (spec 0010, AC-15, review M3R3):
 * never the query string, which access logs keep. The value is percent encoded UTF-8
 * (`encodeURIComponent`), because a header carries no Arabic text as it is.
 */
export const AUDIT_REASON_HEADER = 'x-audit-reason';

/** An export's reason once decoded from `AUDIT_REASON_HEADER`: trimmed, 1 to 500 characters. */
export const AuditExportReason = z.string().trim().min(1).max(500);
/** A validated export reason. */
export type AuditExportReason = z.infer<typeof AuditExportReason>;

/**
 * `GET /api/audit/entries/export` (spec 0010, AC-15): the list filters without paging, with
 * `dayFrom` and `dayTo` required and covering at most 366 days, both ends included
 * (`auditExportDayCount`). The optional reason travels in `AUDIT_REASON_HEADER`, never here. A bad
 * query answers 400 `INVALID_FILTER`.
 */
export const AuditExportQuery = z
  .object({
    actorUserId: z.uuid().optional(),
    recordType: z.string().trim().min(1).max(64).optional(),
    recordId: z.uuid().optional(),
    action: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
      .optional(),
    dayFrom: OperatingDay,
    dayTo: OperatingDay,
    correlationId: z.uuid().optional(),
  })
  .strict()
  .refine((query) => !query.recordId || query.recordType, {
    message: 'recordId needs recordType',
    path: ['recordId'],
  })
  .refine((query) => query.dayFrom <= query.dayTo, {
    message: 'dayFrom must not be after dayTo',
    path: ['dayFrom'],
  })
  .refine((query) => auditExportDayCount(query.dayFrom, query.dayTo) <= AUDIT_EXPORT_MAX_DAYS, {
    message: `The day range can be at most ${AUDIT_EXPORT_MAX_DAYS} days`,
    path: ['dayTo'],
  });
/** The validated export query. */
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;
