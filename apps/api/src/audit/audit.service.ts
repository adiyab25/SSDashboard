import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuditActor, AuditActionCode } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import type { Transaction } from '../database/sql.js';
import { entryValues, INSERT_ENTRIES } from './audit-entry-sql.js';
import { AuditCorrelationMismatch } from './audit.errors.js';

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

/**
 * The writer of every entry of a listed code in `audit_entries` (spec 0010, AC-2, AC-9; the undo
 * module's writer adds undone entries, nothing else writes). Every other module records through
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
    const rows = entries.map((entry) => entryValues(entry, null));
    await tx.execute(sql`${INSERT_ENTRIES} VALUES ${sql.join(rows, sql`, `)}`);
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
