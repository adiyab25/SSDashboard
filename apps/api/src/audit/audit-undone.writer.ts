import { Injectable } from '@nestjs/common';
import { sql } from '@ssdashboard/db';
import type { Transaction } from '../database/sql.js';
import { ENTRY_COLUMNS, type EntryRow } from './audit-query.service.js';
import { entryValues, INSERT_ENTRIES, type AuditEntryInput } from './audit.service.js';

/**
 * The undone entry an undo writes (spec 0010, AC-14, task 16): an entry of the undone code
 * `<action>_undone` on the undone entry's own record, with the reason the undo needs and no undo
 * of its own.
 */
export interface AuditUndoneEntryInput extends Omit<AuditEntryInput, 'action' | 'undo'> {
  /** The undone code, `auditUndoneCodeOf(<the undone entry's action>)`. */
  action: string;
  reason: string;
}

/**
 * The writer of undone entries (spec 0010, AC-14; review M4R4, security review AS33). It is a
 * provider of `AuditUndoModule` that no module exports, and only `AuditUndoService` uses it
 * (`module-boundary.spec.ts` fails a file elsewhere that names it), so no owning module can claim
 * an undo target without its reversal running: `AuditService`, which every owner imports, writes
 * only entries of listed codes. It never opens a transaction and never runs a handler.
 */
@Injectable()
export class AuditUndoneWriter {
  /**
   * Writes the undone entry of one undo through `tx`, inside the undo's transaction after the
   * owner's handler has reversed its change, and returns the row as written (the readers'
   * columns), so the undo can answer from it. Runs every check of `AuditService.record` (the
   * undone code's reason policy is `required`); the table's `audit_entries_undo_matches` trigger
   * refuses a target that is not an undoable entry of the same record, and its unique index on
   * `undoes_entry_id` a second undo of one entry.
   */
  async write(
    tx: Transaction,
    undoesEntryId: string,
    entry: AuditUndoneEntryInput,
  ): Promise<EntryRow> {
    const { rows } = await tx.execute<EntryRow>(
      sql`${INSERT_ENTRIES} VALUES ${entryValues(entry, undoesEntryId)} RETURNING ${ENTRY_COLUMNS}`,
    );
    const row = rows[0];
    if (!row) throw new Error('The undone entry was not written');
    return row;
  }
}
