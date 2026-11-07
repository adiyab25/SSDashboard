import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  auditActionOf,
  type AuditActionDefinition,
  type AuditActor,
} from '@ssdashboard/contracts';
import type { Transaction } from '../database/sql.js';
import type { JsonObject } from './audit.service.js';
import { AuditUndoHandlerDuplicate, AuditUndoHandlerMissing } from './audit.errors.js';

/**
 * The entry an undo handler reverses (spec 0010, Undo): what the entry already holds, its
 * "snapshot". `undo` is the handler code and the arguments the owner wrote with the entry (ids,
 * codes, and numbers only); `before` and `after` are as stored, personal values masked.
 */
export interface AuditUndoTarget {
  id: string;
  action: string;
  correlationId: string;
  record: { type: string; id: string; label: string | null };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  undo: { action: string; args: Record<string, unknown> };
}

/** What a handler is told: the entry, the person undoing it, and their trimmed reason. */
export interface AuditUndoContext {
  entry: AuditUndoTarget;
  actor: AuditActor;
  reason: string;
}

/**
 * What a handler answers once it has reversed its change: the record it changed, which must be
 * the entry's own record, and the changed fields before and after the reversal. The audit module
 * writes the undone entry from it, masking personal values like any other entry.
 */
export interface AuditUndoResult {
  record: { type: string; id: string; label?: string };
  before?: JsonObject;
  after?: JsonObject;
}

/**
 * One owner's undo of one of its actions (spec 0010, AC-14). `undo` reverses the change through
 * `tx`, the undo's own transaction, touching only the owner's tables; it throws `UndoNotPossible`
 * with the owner's code when a later change got in the way, and never writes an audit entry
 * itself. It should be the owner's existing service method, so "undo a merge" has one code path.
 */
export interface AuditUndoHandler {
  undo(tx: Transaction, context: AuditUndoContext): Promise<AuditUndoResult>;
}

/**
 * Whether an entry of `action` that carries `undoAction` can be undone (spec 0010, AC-14): the
 * registry marks the action undoable, and the entry names that action's own handler. An undone
 * entry never can (its derived code is final, and the table refuses an undo action on it). Pure.
 */
export function isUndoableEntry(action: string, undoAction: string | null): boolean {
  const definition = auditActionOf(action);
  return (
    definition?.undoable === true && undoAction !== null && definition.undoHandler === undoAction
  );
}

/**
 * The undo handlers owning modules register (spec 0010, Undo, AC-9): an owner injects it and
 * calls `register(code, handler)` from its own `onModuleInit`, so the audit module imports no
 * owning module. Once every module has started (`onApplicationBootstrap`), it checks that each
 * `undoHandler` the registry names has a handler and stops the process otherwise
 * (`AuditUndoHandlerMissing`). Every process that loads the audit module therefore loads every
 * module that owns an undoable code. It holds handlers only, never entries or data.
 */
@Injectable()
export class AuditUndoRegistry implements OnApplicationBootstrap {
  private readonly handlers = new Map<string, AuditUndoHandler>();

  /**
   * Registers the handler for one handler code. Throws `AuditUndoHandlerDuplicate` when the code
   * is taken, so two owners can never answer for one undo.
   */
  register(code: string, handler: AuditUndoHandler): void {
    if (this.handlers.has(code)) throw new AuditUndoHandlerDuplicate(code);
    this.handlers.set(code, handler);
  }

  /** The handler registered for a code, or undefined. */
  handlerOf(code: string): AuditUndoHandler | undefined {
    return this.handlers.get(code);
  }

  /**
   * The handler codes the registry's undoable actions name that no module registered, sorted,
   * each once. Empty when every undoable code can be undone. Reads `registry` live, so a test can
   * plant a row.
   */
  missingHandlers(
    registry: Readonly<Record<string, AuditActionDefinition>> = AUDIT_ACTIONS,
  ): string[] {
    const named = Object.values(registry).flatMap((action) =>
      action.undoable && action.undoHandler ? [action.undoHandler] : [],
    );
    return [...new Set(named)].filter((code) => !this.handlers.has(code)).sort();
  }

  /** Throws `AuditUndoHandlerMissing` naming every handler code no module registered. */
  assertComplete(registry: Readonly<Record<string, AuditActionDefinition>> = AUDIT_ACTIONS): void {
    const missing = this.missingHandlers(registry);
    if (missing.length) throw new AuditUndoHandlerMissing(missing);
  }

  /** Runs after every module's `onModuleInit`, where owners register: stops a start with a gap. */
  onApplicationBootstrap(): void {
    this.assertComplete();
  }
}
