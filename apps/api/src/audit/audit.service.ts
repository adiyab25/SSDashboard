import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { maskEmails, maskPhones } from '@ssdashboard/config/redaction';
import {
  AuditActor,
  auditActionOf,
  auditRecordTypeOf,
  ReasonCode,
  type AuditActionCode,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { pgArray, type Transaction } from '../database/sql.js';
import {
  AuditCorrelationMismatch,
  AuditPersonalDataRefused,
  AuditReasonInvalid,
  AuditReasonRequired,
  AuditReasonTooLong,
  AuditRecordTypeMismatch,
  UnknownAuditAction,
} from './audit.errors.js';
import {
  hasPhoneShapedKey,
  holdsNoPersonalData,
  isUndoArgsShape,
  maskPersonalData,
} from './personal-data.js';

/** The longest reason an entry keeps, after trimming (spec 0010, AC-5). */
export const AUDIT_REASON_MAX = 500;

/**
 * A value JSON can carry unchanged (review AR5). `bigint`, `Date`, `undefined`, and functions are
 * not JSON values, so a `Money` or `UnitCost` must reach a diff as its decimal string: a bigint
 * fails typecheck here instead of throwing inside the caller's transaction.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** An object of JSON values: the shape of `before`, `after`, and the undo arguments. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * One audit entry as a module writes it (spec 0010, "Who acts, and how a module writes").
 * `before` and `after` hold only the changed fields (a creation has no `before`, a removal no
 * `after`); `record.label` is a short non personal label such as a receipt number;
 * `correlationId` comes from `AuditService.newCorrelationId()` once per business action.
 * `reasonRequired` only tightens: it makes a reason required for this one call when the
 * registry says `optional` (a sensitive setting, the manager hat's revoke). It can never loosen a
 * `required` code, which is why its only value is `true`.
 */
export interface AuditEntryInput {
  actor: AuditActor;
  action: AuditActionCode;
  record: { type: string; id: string; label?: string };
  before?: JsonObject;
  after?: JsonObject;
  reason?: string;
  reasonRequired?: true;
  correlationId: string;
  undo?: { action: string; args: JsonObject };
}

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

const json = (value: Readonly<Record<string, unknown>> | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

/**
 * Checks one entry in the spec's order and returns its VALUES tuple. Throws before anything is
 * written: an unknown code (`UnknownAuditAction`), a record type the registry does not give the
 * code or one the audit trail does not know (`AuditRecordTypeMismatch`), a malformed actor (a
 * `ZodError`, security review AS19), a missing required reason (`AuditReasonRequired`), a reason
 * over 500 characters (`AuditReasonTooLong`), a typed note where the record type takes a reason
 * code (`AuditReasonInvalid`, AS13), or personal data in the label or undo arguments or a phone
 * shaped key anywhere (`AuditPersonalDataRefused`). Masks personal values in `before` and `after`,
 * with the record type's own personal keys, and phones and emails in a free text reason. Never
 * touches the database.
 */
function entryValues(entry: AuditEntryInput): SQL {
  const definition = auditActionOf(entry.action);
  if (!definition) throw new UnknownAuditAction(entry.action);
  const recordType = auditRecordTypeOf(entry.record.type);
  if (entry.record.type !== definition.recordType || !recordType) {
    throw new AuditRecordTypeMismatch(entry.action, entry.record.type);
  }
  const actor = actorColumns(AuditActor.parse(entry.actor));

  const trimmed = entry.reason?.trim() ?? '';
  const required = definition.reason === 'required' || entry.reasonRequired === true;
  if (!trimmed && required) throw new AuditReasonRequired(entry.action);
  if ([...trimmed].length > AUDIT_REASON_MAX) throw new AuditReasonTooLong();
  let reason: string | null = null;
  if (trimmed && recordType.reason === 'code') {
    // A customer facing record keeps a reason code, never a typed note (spec 0010, AC-5).
    // Only a code this action lists, and never one that holds a phone (security review AS23).
    if (
      !ReasonCode.safeParse(trimmed).success ||
      maskPhones(trimmed) !== trimmed ||
      !definition.reasonCodes?.includes(trimmed)
    ) {
      throw new AuditReasonInvalid(entry.action);
    }
    reason = trimmed;
  } else if (trimmed) {
    reason = maskEmails(maskPhones(trimmed));
  }

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
              ${json(entry.undo?.args)}::jsonb)`;
}

/**
 * The only writer of `audit_entries` (spec 0010, AC-2, AC-9). Every other module records through
 * `record` or `recordMany`, inside its own transaction, so an entry exists if and only if its
 * change commits. It never opens a transaction, never swallows an error, never reads another
 * module's table, and never stores a customer's personal data. `id`, `recorded_at`, `tenant_id`,
 * and `operating_day` are the database's (defaults and triggers), never passed.
 */
@Injectable()
export class AuditService {
  /**
   * Writes one entry through the caller's transaction `tx` (AC-2). In order: the code must be in
   * the registry (`UnknownAuditAction`) and name its registered record type
   * (`AuditRecordTypeMismatch`); a reason the registry or `reasonRequired` requires must be
   * present (`AuditReasonRequired`) and at most 500 characters (`AuditReasonTooLong`); personal
   * values in `before` and `after` are masked and their paths listed in `personal_fields` (AC-4);
   * personal data in the record label or the undo arguments is refused
   * (`AuditPersonalDataRefused`); phone shaped text in the reason is masked. A throw here, or any
   * later throw in the caller's transaction, rolls back both the change and the entry.
   */
  async record(tx: Transaction, entry: AuditEntryInput): Promise<void> {
    await this.recordMany(tx, [entry]);
  }

  /**
   * Writes several entries of one business action (a merge writes one per customer record) in
   * one multi row insert through `tx` (AC-6). Each entry passes every check of `record` before
   * anything is written, so one bad entry writes none. All entries must carry the same
   * `correlationId` (`AuditCorrelationMismatch`): two actions are two calls. An empty list writes
   * nothing.
   */
  async recordMany(tx: Transaction, entries: readonly AuditEntryInput[]): Promise<void> {
    if (!entries.length) return;
    // One call is one business action, so its entries share one correlation id (AC-6).
    const [first] = entries;
    if (first && entries.some((entry) => entry.correlationId !== first.correlationId)) {
      throw new AuditCorrelationMismatch();
    }
    const rows = entries.map(entryValues);
    await tx.execute(sql`
      INSERT INTO audit_entries (correlation_id, actor_kind, actor_user_id, actor_ref, job_id,
                                 actor_hat, action, record_type, record_id, record_label,
                                 before, after, personal_fields, reason, undo_action, undo_args)
      VALUES ${sql.join(rows, sql`, `)}`);
  }

  /**
   * The correlation id of one business action (AC-6, the shared rule). A system job's actions
   * use its pg-boss job id, so every entry one job run writes, across transactions, shares it;
   * any other actor gets a new id. Call it once, before the transaction (a deadlock retry must
   * reuse it), and pass it to every entry the action writes.
   */
  newCorrelationId(actor?: AuditActor): string {
    return actor?.kind === 'system_job' ? actor.jobId : randomUUID();
  }
}
