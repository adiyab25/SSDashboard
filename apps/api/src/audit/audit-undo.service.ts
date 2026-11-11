import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  auditActionOf,
  auditRecordTypeOf,
  auditUndoneCodeOf,
  personActor,
  type AuditEntryView,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgConstraint, pgErrorCode } from '../database/sql.js';
import { isEntryVisible, serializeAuditEntry } from './audit-cost-fields.js';
import {
  AuditQueryService,
  entryViewOf,
  type AuditViewer,
  type EntryRow,
} from './audit-query.service.js';
import { checkedAuditReason } from './audit-reason.js';
import {
  AuditUndoRegistry,
  isUndoableEntry,
  type AuditUndoResult,
  type AuditUndoTarget,
} from './audit-undo.registry.js';
import { AuditUndoneWriter } from './audit-undone.writer.js';
import { AuditService } from './audit.service.js';
import {
  AlreadyUndone,
  AuditEntryNotFound,
  AuditReadForbidden,
  AuditRecordTypeMismatch,
  AuditUndoHandlerMissing,
  AuditUndoRecordMismatch,
  NotUndoable,
  UndoNotPossible,
  UnknownAuditAction,
} from './audit.errors.js';

/** The unique index that holds one undone entry per entry (`undoes_entry_id`). */
const UNDONE_ONCE = 'audit_entries_undoes_entry_unique';

/**
 * The transaction lock key of one entry's undo: a stable 64 bit number from the entry id, in its
 * own namespace so it never meets the ledger's SKU and location keys. The id is lower cased first
 * (review M4R3), so one entry has one key however its id was spelled. Exported for tests.
 */
export function undoLockKey(entryId: string): bigint {
  return createHash('sha256')
    .update(`audit_undo:${entryId.toLowerCase()}`)
    .digest()
    .readBigInt64BE(0);
}

/**
 * Whether a database error is the unique index on `undoes_entry_id` refusing a second undone
 * entry (23505, review M4R3): another undo of the same entry committed first. Pure.
 */
export function isUndoneTwice(error: unknown): boolean {
  return pgErrorCode(error) === '23505' && pgConstraint(error) === UNDONE_ONCE;
}

/** The target row as the undo reads it inside its transaction. */
type TargetRow = {
  id: string;
  action: string;
  correlation_id: string;
  record_type: string;
  record_id: string;
  record_label: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  undo_action: string | null;
  undo_args: Record<string, unknown> | null;
};

/**
 * Undoes one audited action in one step (spec 0010, AC-14, Undo). The audit module never changes
 * another module's data: it finds the owner's handler in `AuditUndoRegistry` by the entry's
 * `undo_action` and asks it to reverse its own change, inside one transaction that also writes
 * the undone entry (`AuditUndoneWriter`, which only this service uses), so the reversal and its
 * entry commit together or not at all. It never passes an owner's own text to the caller.
 */
@Injectable()
export class AuditUndoService {
  private readonly logger = new Logger('AuditUndo');

  /** Takes the app database connection, the writers, the reader, and the handler registry. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditUndoneWriter) private readonly writer: AuditUndoneWriter,
    @Inject(AuditQueryService) private readonly reader: AuditQueryService,
    @Inject(AuditUndoRegistry) private readonly registry: AuditUndoRegistry,
  ) {}

  /**
   * Undoes entry `entryId` for `viewer` (who holds `audit.undo`; the route checks it) with their
   * typed `reason`, and returns the new undone entry as the viewer sees it. The id is lower cased
   * first (review M4R3). In one transaction: takes a transaction advisory lock on the entry (so
   * two undos of one entry queue, and the second sees the first's entry), loads it
   * (`AuditEntryNotFound`, also for a cost entry a viewer without `cost.view` may not see,
   * `isEntryVisible`), refuses one that cannot be undone (`NotUndoable`: no `undo_action`, an
   * action the registry does not mark undoable, or another handler than the registry's) or that
   * is undone already (`AlreadyUndone`), checks the reason against the undone code's policy
   * (`AuditReasonRequired`, `AuditReasonTooLong`, `AuditReasonInvalid`) before any owner code
   * runs, calls the owner's handler with the checked, masked reason (it may throw
   * `UndoNotPossible`; everything it wrote rolls back, and only a refusal code its action
   * declares is passed on), and writes `<action>_undone` on the same record
   * (`AuditUndoRecordMismatch` otherwise) with the reason, `undoes_entry_id`, never undoable, and
   * a fresh correlation id (one business action). A second undone entry the unique index refuses
   * is `AlreadyUndone`. The person actor names the viewer's hat that holds `audit.undo`. If the
   * read after commit fails, it answers from the row it wrote (review M4R17), never an error for
   * an undo that is done; but a viewer the reader refuses (`AuditReadForbidden`, no `audit.read`)
   * gets that refusal, never the row (security review AS37).
   */
  async undo(entryId: string, viewer: AuditViewer, reason: string): Promise<AuditEntryView> {
    const id = entryId.toLowerCase();
    const actor = personActor(viewer.userId, viewer.actingHat('audit.undo'));
    const correlationId = this.audit.newCorrelationId(actor);
    let written: EntryRow;
    try {
      written = await this.connection.db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${undoLockKey(id)}::bigint)`);
          const { rows } = await tx.execute<TargetRow>(sql`
            SELECT id, action, correlation_id, record_type, record_id, record_label, before,
                   after, undo_action, undo_args
            FROM audit_entries WHERE id = ${id}`);
          const target = rows[0];
          // An entry the viewer may not see at all (a cost entry without `cost.view`) is
          // missing to them, before any other refusal could say it exists.
          if (!target || !isEntryVisible(target.action, viewer.has('cost.view'))) {
            throw new AuditEntryNotFound();
          }
          if (!target.undo_action || !isUndoableEntry(target.action, target.undo_action)) {
            throw new NotUndoable();
          }
          const done = await tx.execute<{ id: string }>(sql`
            SELECT id FROM audit_entries WHERE undoes_entry_id = ${id} LIMIT 1`);
          if (done.rows.length) throw new AlreadyUndone();

          const undoneCode = auditUndoneCodeOf(target.action);
          const checkedReason = this.checkedReason(undoneCode, target.record_type, reason);
          const handler = this.registry.handlerOf(target.undo_action);
          if (!handler) throw new AuditUndoHandlerMissing([target.undo_action]);
          const entry: AuditUndoTarget = {
            id: target.id,
            action: target.action,
            correlationId: target.correlation_id,
            record: { type: target.record_type, id: target.record_id, label: target.record_label },
            before: target.before,
            after: target.after,
            undo: { action: target.undo_action, args: target.undo_args ?? {} },
          };
          let result: AuditUndoResult;
          try {
            result = await handler.undo(tx, { entry, actor, reason: checkedReason });
          } catch (error) {
            throw this.refusalOf(error, target.action, target.undo_action);
          }
          if (result.record.type !== target.record_type || result.record.id !== target.record_id) {
            throw new AuditUndoRecordMismatch(target.undo_action);
          }
          return this.writer.write(tx, id, {
            actor,
            action: undoneCode,
            record: result.record,
            ...(result.before ? { before: result.before } : {}),
            ...(result.after ? { after: result.after } : {}),
            reason: checkedReason,
            correlationId,
          });
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (isUndoneTwice(error)) throw new AlreadyUndone();
      throw error;
    }
    try {
      return await this.reader.view(written.id, viewer);
    } catch (error) {
      // A viewer the reader refuses never gets the entry another way (security review AS37).
      if (error instanceof AuditReadForbidden) throw error;
      // The undo is committed: answer from what was written rather than an error a retry would
      // meet as "already undone". The undone entry is never itself undone or undoable.
      this.logger.warn('An undo committed but its entry could not be read back');
      return serializeAuditEntry(entryViewOf(written, null, false, false), viewer);
    }
  }

  /**
   * The undone entry's reason, checked against the undone code's policy before any owner code
   * runs (review M4R2, security review AS32): required, at most 500 characters, a listed undo
   * reason code on a record type that keeps codes, else masked free text.
   */
  private checkedReason(undoneCode: string, recordType: string, reason: string): string {
    const definition = auditActionOf(undoneCode);
    if (!definition) throw new UnknownAuditAction(undoneCode);
    const form = auditRecordTypeOf(recordType)?.reason;
    if (!form) throw new AuditRecordTypeMismatch(undoneCode, recordType);
    // The undone code's policy is `required`, so a checked reason is never null.
    return checkedAuditReason(undoneCode, definition, form, reason) ?? '';
  }

  /**
   * What a handler's throw becomes (security review AS31): an `UndoNotPossible` with a refusal
   * code the action declares (`undoRefusalCodes`) is passed on with that code; any other
   * `UndoNotPossible` becomes a plain one, logged once with the action and handler codes and no
   * value. Anything else is passed on as it is (a programming or database error, 500).
   */
  private refusalOf(error: unknown, action: string, handler: string): unknown {
    if (!(error instanceof UndoNotPossible)) return error;
    const declared = auditActionOf(action)?.undoRefusalCodes ?? [];
    if (error.undoCode !== undefined && declared.includes(error.undoCode)) {
      return new UndoNotPossible(error.undoCode);
    }
    this.logger.warn(
      `The undo handler ${handler} of ${action} refused without a declared refusal code`,
    );
    return new UndoNotPossible();
  }
}
