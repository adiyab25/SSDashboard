import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  auditActionOf,
  type AuditActionDefinition,
  type AuditActor,
} from '@ssdashboard/contracts';
import type { Transaction } from '../database/sql.js';
import type { JsonObject } from './audit.service.js';
import {
  AuditUndoHandlerDuplicate,
  AuditUndoHandlerForeign,
  AuditUndoHandlerMissing,
} from './audit.errors.js';

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

/**
 * What a handler is told: the entry, the person undoing it, and their reason, already checked
 * against the undone code's policy and masked (review M4R2, security review AS32): one of the
 * action's `undoReasonCodes` on a record type that keeps codes, else the trimmed text with phones
 * and emails masked. A handler may log or pass it on; it never sees the raw text.
 */
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
 * Its refusal codes are the `undoRefusalCodes` its action declares; any other reaches the manager
 * as a plain `UNDO_NOT_POSSIBLE` (security review AS31).
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
 * calls `register(code, handler, '<its module>')` from its own `onModuleInit`, so the audit module
 * imports no owning module. A code is bound to the module the registry's actions name: a module
 * can register only a handler code its own undoable actions name (security review AS33). It holds
 * handlers only, never entries or data, and it never stops a process: the start check that every
 * undoable code has a handler is `AuditUndoStartCheck`, which runs only where the undo route is
 * served (the api, never the worker; review M4R1).
 */
@Injectable()
export class AuditUndoRegistry {
  private readonly handlers = new Map<string, AuditUndoHandler>();

  /**
   * Registers the handler for one handler code on behalf of `owner`, the registering module's
   * name as the registry spells it (`customers`). Throws `AuditUndoHandlerForeign` unless an
   * undoable action of `owner` names the code (read live from `registry`, so a test can plant a
   * row), and `AuditUndoHandlerDuplicate` when the code is taken, so two owners can never answer
   * for one undo.
   */
  register(
    code: string,
    handler: AuditUndoHandler,
    owner: string,
    registry: Readonly<Record<string, AuditActionDefinition>> = AUDIT_ACTIONS,
  ): void {
    const naming = Object.values(registry).filter(
      (action) => action.undoable && action.undoHandler === code,
    );
    if (!naming.length || naming.some((action) => action.module !== owner)) {
      throw new AuditUndoHandlerForeign(code, owner);
    }
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
}
