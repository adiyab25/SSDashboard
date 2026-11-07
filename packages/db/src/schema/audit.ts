import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, tenantId } from './columns.js';

// The audit trail (spec 0010): one append only log of who did what, when, and why. Written only
// by the api's audit module, inside the caller's transaction. The rules file revokes UPDATE,
// DELETE, and TRUNCATE from the app role and adds the `ssd_reject_change` and
// `ssd_stamp_operating_day('recorded_at')` triggers. It never holds customer personal data.

/**
 * One row per changed record (spec 0010, AC-1). The actor is exactly one of six kinds, checked by
 * `audit_actor_shape` (AC-3). `operating_day` is stamped by trigger from `recorded_at`; writers use
 * SQL that leaves it out, never a Drizzle insert. Never updated or deleted: a correction is a new
 * entry that points back through `undoes_entry_id`.
 */
export const auditEntries = pgTable(
  'audit_entries',
  {
    id: id(),
    tenantId: tenantId(),
    /** The wall clock instant, so the rows of one transaction keep their order. */
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** The brand's Cairo day of `recordedAt`, stamped by trigger `ssd_stamp_operating_day`; never passed by a writer. */
    operatingDay: date('operating_day').notNull(),
    /** Shared by every entry of one business action. */
    correlationId: uuid('correlation_id').notNull(),
    /** `person`, `partner_user`, `system_job`, `carrier`, `import`, or `portal_customer`. */
    actorKind: text('actor_kind').notNull(),
    /** Set exactly for `person` and `partner_user`. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Partner account id, job name, connection code, import run id, or customer id. */
    actorRef: text('actor_ref'),
    /** The pg-boss job id, `system_job` only. */
    jobId: uuid('job_id'),
    /** The hat the person acted under, `person` only. */
    actorHat: text('actor_hat'),
    /** A registry code, `module_noun.verb_past` (`stock_receipt.voided`). */
    action: text('action').notNull(),
    recordType: text('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    /** A short non personal label from the caller, such as an order number or SKU code. */
    recordLabel: text('record_label'),
    /** The changed fields before the change; null for a creation. */
    before: jsonb('before').$type<Record<string, unknown>>(),
    /** The changed fields after the change; null for a removal. */
    after: jsonb('after').$type<Record<string, unknown>>(),
    /** The paths whose values were masked as personal data. */
    personalFields: text('personal_fields')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reason: text('reason'),
    /** The owning module's undo handler code, for an undoable action. */
    undoAction: text('undo_action'),
    undoArgs: jsonb('undo_args').$type<Record<string, unknown>>(),
    /** The entry this one undoes; an entry is undone at most once. */
    undoesEntryId: uuid('undoes_entry_id').references((): AnyPgColumn => auditEntries.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    // The unfiltered list, keyset paging, and the export.
    index('audit_entries_recorded_idx').on(
      t.recordedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // "What did this person do"; also serves the actor_user_id foreign key.
    index('audit_entries_actor_recorded_idx')
      .on(t.actorUserId, t.recordedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.actorUserId} IS NOT NULL`),
    // The whole story of one record, and the history panel.
    index('audit_entries_record_recorded_idx').on(
      t.recordType,
      t.recordId,
      t.recordedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('audit_entries_action_recorded_idx').on(
      t.action,
      t.recordedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('audit_entries_correlation_idx').on(t.correlationId),
    // An entry is undone at most once; also serves the undoes_entry_id foreign key.
    uniqueIndex('audit_entries_undoes_entry_unique')
      .on(t.undoesEntryId)
      .where(sql`${t.undoesEntryId} IS NOT NULL`),
    // Day range filters: rows arrive in time order, so the BRIN index stays a few pages.
    index('audit_entries_operating_day_brin').using('brin', t.operatingDay),
    check(
      'audit_actor_kind',
      sql`${t.actorKind} IN ('person', 'partner_user', 'system_job', 'carrier', 'import', 'portal_customer')`,
    ),
    check(
      'audit_actor_shape',
      sql`CASE ${t.actorKind}
        WHEN 'person' THEN ${t.actorUserId} IS NOT NULL AND ${t.actorRef} IS NULL AND ${t.jobId} IS NULL AND ${t.actorHat} IS NOT NULL
        WHEN 'partner_user' THEN ${t.actorUserId} IS NOT NULL AND ${t.actorRef} IS NOT NULL AND ${t.jobId} IS NULL AND ${t.actorHat} IS NULL
        WHEN 'system_job' THEN ${t.actorUserId} IS NULL AND ${t.actorRef} IS NOT NULL AND ${t.actorHat} IS NULL AND ${t.jobId} IS NOT NULL
        ELSE ${t.actorUserId} IS NULL AND ${t.actorRef} IS NOT NULL AND ${t.jobId} IS NULL AND ${t.actorHat} IS NULL
      END`,
    ),
    check('audit_action_format', sql`${t.action} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`),
    check(
      'audit_reason_length',
      sql`${t.reason} IS NULL OR length(btrim(${t.reason})) BETWEEN 1 AND 500`,
    ),
    // A label is a short code or number (security review AS3); the writer also checks its shape.
    check(
      'audit_record_label_length',
      sql`${t.recordLabel} IS NULL OR char_length(${t.recordLabel}) BETWEEN 1 AND 64`,
    ),
    check(
      'audit_json_objects',
      sql`(${t.before} IS NULL OR jsonb_typeof(${t.before}) = 'object') AND (${t.after} IS NULL OR jsonb_typeof(${t.after}) = 'object')`,
    ),
    check('audit_undo_pair', sql`(${t.undoAction} IS NULL) = (${t.undoArgs} IS NULL)`),
    check(
      'audit_undo_entry_not_undoable',
      sql`${t.undoesEntryId} IS NULL OR ${t.undoAction} IS NULL`,
    ),
  ],
);
