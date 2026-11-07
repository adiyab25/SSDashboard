import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { auditUndoneCodeOf, personActor, type AuditEntryView } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { AuditQueryService, type AuditViewer } from './audit-query.service.js';
import { AuditUndoRegistry, isUndoableEntry, type AuditUndoTarget } from './audit-undo.registry.js';
import { AuditService } from './audit.service.js';
import {
  AlreadyUndone,
  AuditEntryNotFound,
  AuditUndoHandlerMissing,
  AuditUndoRecordMismatch,
  NotUndoable,
} from './audit.errors.js';

/**
 * The transaction lock key of one entry's undo: a stable 64 bit number from the entry id, in its
 * own namespace so it never meets the ledger's SKU and location keys. Exported for tests.
 */
export function undoLockKey(entryId: string): bigint {
  return createHash('sha256').update(`audit_undo:${entryId}`).digest().readBigInt64BE(0);
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
 * the undone entry, so the reversal and its entry commit together or not at all.
 */
@Injectable()
export class AuditUndoService {
  /** Takes the app database connection, the writer, the reader, and the handler registry. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditQueryService) private readonly reader: AuditQueryService,
    @Inject(AuditUndoRegistry) private readonly registry: AuditUndoRegistry,
  ) {}

  /**
   * Undoes entry `entryId` for `viewer` (who holds `audit.undo`; the route checks it) with their
   * typed `reason`, and returns the new undone entry as the viewer sees it. In one transaction:
   * takes a transaction advisory lock on the entry (so two undos of one entry queue, and the
   * second sees the first's entry), loads it (`AuditEntryNotFound`), refuses one that cannot be
   * undone (`NotUndoable`: no `undo_action`, an action the registry does not mark undoable, or
   * another handler than the registry's) or that is undone already (`AlreadyUndone`), calls the
   * owner's handler (which may throw `UndoNotPossible`; everything it wrote rolls back), and
   * writes `<action>_undone` on the same record (`AuditUndoRecordMismatch` otherwise) with the
   * reason, `undoes_entry_id`, never undoable, and a fresh correlation id (one business action).
   * The person actor names the viewer's hat that holds `audit.undo`.
   */
  async undo(entryId: string, viewer: AuditViewer, reason: string): Promise<AuditEntryView> {
    const actor = personActor(viewer.userId, viewer.actingHat('audit.undo'));
    const correlationId = this.audit.newCorrelationId(actor);
    const undoneId = await this.connection.db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${undoLockKey(entryId)}::bigint)`);
        const { rows } = await tx.execute<TargetRow>(sql`
          SELECT id, action, correlation_id, record_type, record_id, record_label, before, after,
                 undo_action, undo_args
          FROM audit_entries WHERE id = ${entryId}`);
        const target = rows[0];
        if (!target) throw new AuditEntryNotFound();
        if (!target.undo_action || !isUndoableEntry(target.action, target.undo_action)) {
          throw new NotUndoable();
        }
        const done = await tx.execute<{ id: string }>(sql`
          SELECT id FROM audit_entries WHERE undoes_entry_id = ${entryId} LIMIT 1`);
        if (done.rows.length) throw new AlreadyUndone();

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
        const result = await handler.undo(tx, { entry, actor, reason });
        if (result.record.type !== target.record_type || result.record.id !== target.record_id) {
          throw new AuditUndoRecordMismatch(target.undo_action);
        }
        return this.audit.recordUndone(tx, entryId, {
          actor,
          action: auditUndoneCodeOf(target.action),
          record: result.record,
          ...(result.before ? { before: result.before } : {}),
          ...(result.after ? { after: result.after } : {}),
          reason,
          correlationId,
        });
      },
      { isolationLevel: 'read committed' },
    );
    return this.reader.view(undoneId, viewer);
  }
}
