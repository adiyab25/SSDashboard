import {
  AuditActor,
  auditActionOf,
  auditRecordTypeOf,
  auditUndoneParentOf,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { pgArray } from '../database/sql.js';
import { checkedAuditReason } from './audit-reason.js';
import {
  AuditPersonalDataRefused,
  AuditRecordTypeMismatch,
  UnknownAuditAction,
} from './audit.errors.js';
import type { AuditEntryInput } from './audit.service.js';
import {
  hasPhoneShapedKey,
  holdsNoPersonalData,
  isUndoArgsShape,
  maskPersonalData,
} from './personal-data.js';

// The SQL of an entry insert (spec 0010, AC-2, AC-4; security review AS36). It sits in its own
// file so it can be walled: only `AuditService` (entries of listed codes) and the undo module's
// writer of undone entries may import it. Any other module that could build these rows could
// write an undone entry around the undo and block the real one for good.

/** What `entryValues` checks: an entry of a listed code, or an undone entry. */
export type WritableEntry = Omit<AuditEntryInput, 'action'> & { action: string };

/** The actor columns of `audit_entries`, one shape per actor kind (AC-3). */
interface ActorColumns {
  kind: AuditActor['kind'];
  userId: string | null;
  ref: string | null;
  jobId: string | null;
  hat: string | null;
}

function actorColumns(actor: AuditActor): ActorColumns {
  const none = { userId: null, ref: null, jobId: null, hat: null };
  switch (actor.kind) {
    case 'person':
      return { ...none, kind: actor.kind, userId: actor.userId, hat: actor.hat };
    case 'partner_user':
      return { ...none, kind: actor.kind, userId: actor.userId, ref: actor.partnerAccountId };
    case 'system_job':
      return { ...none, kind: actor.kind, ref: actor.name, jobId: actor.jobId };
    case 'carrier':
      return { ...none, kind: actor.kind, ref: actor.connectionCode };
    case 'import':
      return { ...none, kind: actor.kind, ref: actor.runId };
    case 'portal_customer':
      return { ...none, kind: actor.kind, ref: actor.customerId };
  }
}

/**
 * The column list every entry insert names, in `entryValues` order. Used by `AuditService` and
 * the undone entry writer, the only two inserts into `audit_entries`.
 */
export const INSERT_ENTRIES = sql`
  INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, actor_ref, job_id,
                             actor_hat, action, record_type, record_id, record_label,
                             before, after, personal_fields, reason, undo_action, undo_args,
                             undoes_entry_id)`;

const json = (value: Readonly<Record<string, unknown>> | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

/**
 * Checks one entry in the spec's order and returns its VALUES tuple. Throws before anything is
 * written: an unknown code, or an undone code outside an undo (or a listed code inside one)
 * (`UnknownAuditAction`), a record type the registry does not give the
 * code or one the audit trail does not know (`AuditRecordTypeMismatch`), a malformed actor (a
 * `ZodError`, security review AS19), a missing required reason (`AuditReasonRequired`), a reason
 * over 500 characters (`AuditReasonTooLong`), a typed note where the record type takes a reason
 * code (`AuditReasonInvalid`, AS13), or personal data in the label or undo arguments or a phone
 * shaped key anywhere (`AuditPersonalDataRefused`). Masks personal values in `before` and `after`,
 * with the record type's own personal keys, and phones and emails in a free text reason. Never
 * touches the database. Used only by `AuditService` and the undo module's writer of undone
 * entries; `module-boundary.spec.ts` fails any other file that names it.
 */
export function entryValues(entry: WritableEntry, undoesEntryId: string | null): SQL {
  const definition = auditActionOf(entry.action);
  if (!definition) throw new UnknownAuditAction(entry.action);
  // An undone code (`<action>_undone`) is written only by an undo, and an undo writes only one.
  const undone = auditUndoneParentOf(entry.action) !== undefined;
  if (undone !== (undoesEntryId !== null)) throw new UnknownAuditAction(entry.action);
  const recordType = auditRecordTypeOf(entry.record.type);
  if (entry.record.type !== definition.recordType || !recordType) {
    throw new AuditRecordTypeMismatch(entry.action, entry.record.type);
  }
  const actor = actorColumns(AuditActor.parse(entry.actor));

  const reason = checkedAuditReason(
    entry.action,
    definition,
    recordType.reason,
    entry.reason,
    entry.reasonRequired === true,
  );

  for (const [field, value] of [
    ['before', entry.before],
    ['after', entry.after],
    ['undo.args', entry.undo?.args],
  ] as const) {
    if (value !== undefined && hasPhoneShapedKey(value)) throw new AuditPersonalDataRefused(field);
  }
  const { personalKeys, labelPattern, labelIsOwnCode } = recordType;
  const ownCode = labelIsOwnCode && labelPattern ? labelPattern : undefined;
  const before = entry.before ? maskPersonalData(entry.before, personalKeys, ownCode) : undefined;
  const after = entry.after ? maskPersonalData(entry.after, personalKeys, ownCode) : undefined;
  const personalFields = [
    ...new Set([...(before?.personalPaths ?? []), ...(after?.personalPaths ?? [])]),
  ].sort();

  // A label must fit its record type's shape. A label that is the record's own code (a SKU, a
  // location, a document number) is trusted as it is; any other is refused when it looks like a
  // phone. A customer takes no label (security reviews AS16, AS17).
  const label = entry.record.label ?? null;
  if (
    label !== null &&
    (labelPattern === null ||
      !labelPattern.test(label) ||
      (!labelIsOwnCode && !holdsNoPersonalData(label, personalKeys)))
  ) {
    throw new AuditPersonalDataRefused('record.label');
  }
  if (
    entry.undo &&
    (!isUndoArgsShape(entry.undo.args) || !holdsNoPersonalData(entry.undo.args, personalKeys))
  ) {
    throw new AuditPersonalDataRefused('undo.args');
  }

  return sql`(${entry.correlationId}, ${actor.kind}, ${actor.userId}, ${actor.ref},
              ${actor.jobId}, ${actor.hat}, ${entry.action}, ${entry.record.type},
              ${entry.record.id}, ${label}, ${json(before?.masked)}::jsonb,
              ${json(after?.masked)}::jsonb,
              ${pgArray(personalFields)}::text[], ${reason}, ${entry.undo?.action ?? null},
              ${json(entry.undo?.args)}::jsonb, ${undoesEntryId}::uuid)`;
}
