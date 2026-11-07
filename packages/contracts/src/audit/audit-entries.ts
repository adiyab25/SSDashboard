import { z } from 'zod';
import { AuditActorKind } from './audit-actor.js';

/** Most entries one page may hold (spec 0010, AC-12). */
export const AUDIT_PAGE_MAX = 200;

/** Entries a page holds when the caller does not ask (spec 0010, AC-12). */
export const AUDIT_PAGE_DEFAULT = 50;

/** The shape of an action code, `module_noun.verb_past`; the same rule as `audit_action_format`. */
const ActionCode = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);

/**
 * An operating day PostgreSQL can hold: `z.iso.date()` accepts year 0000, which `::date` refuses
 * (security review AS7), so the filter answers 400 instead of a database error.
 */
const OperatingDay = z.iso.date().refine((day) => day >= '0001-01-01', {
  message: 'The day must be in year 1 or later',
});

/**
 * The filter fields every reader of the trail shares (spec 0010, AC-12, AC-15, review M3R11):
 * person, record type and id, action, operating day range (inclusive), and correlation id, each
 * optional. The list adds paging; the export makes the day range required. One schema, so the two
 * can never drift. Not strict and not refined on its own: use `AuditEntryListQuery` or
 * `AuditExportQuery`, which add `auditFilterRules`.
 */
export const AuditEntryFilter = z.object({
  actorUserId: z.uuid().optional(),
  recordType: z.string().trim().min(1).max(64).optional(),
  recordId: z.uuid().optional(),
  action: ActionCode.optional(),
  dayFrom: OperatingDay.optional(),
  dayTo: OperatingDay.optional(),
  correlationId: z.uuid().optional(),
});
/** The shared filter fields of the list and the export. */
export type AuditEntryFilter = z.infer<typeof AuditEntryFilter>;

/**
 * The rules a filter keeps beyond its fields: `recordId` needs `recordType`, and `dayFrom` may not
 * pass `dayTo`. Pure; the list and the export apply it with `superRefine`, so both refuse alike.
 */
export function auditFilterRules(filter: AuditEntryFilter, context: z.RefinementCtx): void {
  if (filter.recordId && !filter.recordType) {
    context.addIssue({ code: 'custom', message: 'recordId needs recordType', path: ['recordId'] });
  }
  if (filter.dayFrom && filter.dayTo && filter.dayFrom > filter.dayTo) {
    context.addIssue({
      code: 'custom',
      message: 'dayFrom must not be after dayTo',
      path: ['dayFrom'],
    });
  }
}

/**
 * `GET /api/audit/entries` (spec 0010, AC-12): the shared filter (`AuditEntryFilter`), every field
 * optional, combined with AND, newest first, plus `cursor` (the opaque `nextCursor` of the
 * previous page) and `limit`. There is no offset and no total count.
 */
export const AuditEntryListQuery = AuditEntryFilter.extend({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
})
  .strict()
  .superRefine(auditFilterRules);
/** The validated list query, as the api and web see it after parsing. */
export type AuditEntryListQuery = z.infer<typeof AuditEntryListQuery>;

/**
 * Who acted, as stored: the kind and the columns it fills (spec 0010, AC-3). `userId` is set for
 * `person` and `partner_user`; `ref` holds the partner account id, job name, connection code,
 * import run id, or customer id; `hat` is the hat a person acted under.
 */
export const AuditEntryActor = z.object({
  kind: AuditActorKind,
  userId: z.uuid().nullable(),
  ref: z.string().nullable(),
  hat: z.string().nullable(),
  jobId: z.uuid().nullable(),
});
/** The stored actor of one entry. */
export type AuditEntryActor = z.infer<typeof AuditEntryActor>;

/**
 * One audit entry as the screen shows it (spec 0010, API surface). `before` and `after` hold only
 * the changed fields; a personal value is `"[REDACTED]"` and its path is in `personalFields`.
 * `actorName` is the person's display name from the identity service, or null for a system actor
 * or an unknown user. `recordedAt` is a microsecond UTC instant; `operatingDay` is `YYYY-MM-DD`.
 * `action` is a registry code; the screen labels it from `AUDIT_ACTIONS`.
 */
export const AuditEntryView = z.object({
  id: z.uuid(),
  recordedAt: z.iso.datetime({ precision: 6 }),
  operatingDay: z.iso.date(),
  correlationId: z.uuid(),
  actor: AuditEntryActor,
  actorName: z.string().nullable(),
  action: z.string(),
  record: z.object({ type: z.string(), id: z.uuid(), label: z.string().nullable() }),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  personalFields: z.array(z.string()),
  reason: z.string().nullable(),
  /** True when a later entry undoes this one (an undone entry names it in `undoes_entry_id`). */
  undone: z.boolean(),
  /**
   * True when the viewer may undo it now (spec 0010, AC-14, State): the registry marks the action
   * undoable, the entry names that action's undo handler, no entry undoes it yet, and the viewer
   * holds `audit.undo`. False on every undone entry, which is never itself undoable.
   */
  canUndo: z.boolean(),
});
/** One entry of the audit list. */
export type AuditEntryView = z.infer<typeof AuditEntryView>;

/** A page of the audit list, newest first; `nextCursor` is null on the last page. */
export const AuditEntryListResponse = z.object({
  items: z.array(AuditEntryView),
  nextCursor: z.string().nullable(),
});
/** A page of the audit list. */
export type AuditEntryListResponse = z.infer<typeof AuditEntryListResponse>;
