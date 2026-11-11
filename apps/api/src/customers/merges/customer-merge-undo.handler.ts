import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditUndoContext,
  AuditUndoHandler,
  AuditUndoResult,
} from '../../audit/audit-undo.registry.js';
import { UndoNotPossible } from '../../audit/audit.errors.js';
import type { Transaction } from '../../database/sql.js';
import { CustomersError } from '../customers.errors.js';
import { CustomerMerges } from './customer-merges.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The audit screen's undo of a `customer.merged` entry (spec 0014 AC-8, spec 0010 AC-14), the
 * handler `customers.merge_undo`: it runs the same `CustomerMerges.undoIn` as the customer route,
 * inside the audit module's undo transaction, and lets the audit module write
 * `customer.merged_undone` on the merged record. A refusal becomes `UndoNotPossible` with
 * `MERGE_NOT_LATEST` or `MERGE_ALREADY_UNDONE`; any other customers refusal a plain one. It never
 * writes an audit entry itself and never touches another module's table.
 */
@Injectable()
export class CustomerMergeUndoHandler implements AuditUndoHandler {
  /** Takes the merge service whose undo it runs. */
  constructor(@Inject(CustomerMerges) private readonly merges: CustomerMerges) {}

  /** Undoes the merge the entry's undo arguments name (`{ mergeId }`), as the person undoing it. */
  async undo(tx: Transaction, context: AuditUndoContext): Promise<AuditUndoResult> {
    const mergeId = context.entry.undo.args['mergeId'];
    if (typeof mergeId !== 'string' || !UUID.test(mergeId) || context.actor.kind !== 'person') {
      throw new UndoNotPossible();
    }
    const { userId, hat } = context.actor;
    try {
      const outcome = await this.merges.undoIn(tx, mergeId, context.reason, { userId, hat });
      return {
        record: { type: 'customer', id: outcome.restoredId },
        before: { mergedIntoId: outcome.survivorId },
        after: { mergedIntoId: null, mergeId },
      };
    } catch (error) {
      if (error instanceof CustomersError) {
        const declared = error.code === 'MERGE_NOT_LATEST' || error.code === 'MERGE_ALREADY_UNDONE';
        throw declared ? new UndoNotPossible(error.code) : new UndoNotPossible();
      }
      throw error;
    }
  }
}
