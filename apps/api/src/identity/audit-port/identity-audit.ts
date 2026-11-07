import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../database/sql.js';

/**
 * The audit actions identity writes (spec 0010, actions table): the access changes of spec 0008
 * (feature 8) and the staff account actions of spec 0010 task 10. When spec 0010's registry
 * (`AUDIT_ACTIONS` in `packages/contracts/src/audit/`) reaches this branch, each code here must be
 * one of its entries.
 */
export type IdentityAuditAction =
  | 'hat.granted'
  | 'hat.revoked'
  | 'staff_user.created'
  | 'staff_user.disabled'
  | 'staff_user.enabled'
  | 'staff_user.password_reset';

/**
 * Who acted, in spec 0010's `AuditActor` shape for a person: the user id and the hat they acted
 * with (the hat that holds the permission the route needs).
 */
export interface IdentityAuditActor {
  kind: 'person';
  userId: string;
  hat: string;
}

/**
 * One audit entry, shaped exactly like spec 0010's `AuditEntryInput` so the adapter can pass it
 * on unchanged: the actor, the action, the record (`{ type: 'user', id }` for everything identity
 * writes), the changed fields before and after, the optional reason, and the correlation id of the
 * business action. `before` and `after` hold ids, flags and hat names only: never an email, a
 * name or a phone.
 */
export interface IdentityAuditEntry {
  actor: IdentityAuditActor;
  action: IdentityAuditAction;
  record: { type: 'user'; id: string; label?: string };
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  correlationId: string;
}

/**
 * Identity's port for the audit trail, shaped like spec 0010's `AuditService` (`record(tx, entry)`
 * and `newCorrelationId()`). Identity calls `record` inside the transaction of the change it
 * records, so the change and the entry commit or roll back together (spec 0010 AC-2, spec 0008
 * AC-13). An implementation must write through `tx` only: never open its own transaction, never
 * swallow an error, and never run after the commit.
 *
 * Bound to {@link IDENTITY_AUDIT}: today the no op {@link PendingIdentityAudit}; when spec 0010's
 * module lands on this branch, an adapter over its `AuditService` takes its place in
 * `identity.module.ts`, and nothing else in identity changes.
 */
export interface IdentityAudit {
  /** Writes one entry through the caller's transaction. */
  record(tx: Transaction, entry: IdentityAuditEntry): Promise<void>;
  /** A fresh correlation id for one business action. */
  newCorrelationId(): string;
}

/** The Nest token {@link IdentityAudit} is bound to in `identity.module.ts`. */
export const IDENTITY_AUDIT = Symbol('IdentityAudit');

/**
 * The adapter bound until spec 0010's audit module reaches this branch: it writes nothing, and the
 * log lines and events of spec 0005 AC-23 and spec 0008 AC-13 stay the record ("until feature 10
 * lands, the log line and the event are the record"). It must never be kept once `AuditService`
 * exists: switch the binding then.
 */
@Injectable()
export class PendingIdentityAudit implements IdentityAudit {
  /** Writes nothing: the audit trail does not exist on this branch yet. */
  record(_tx: Transaction, _entry: IdentityAuditEntry): Promise<void> {
    return Promise.resolve();
  }

  /** A random UUID, as spec 0010's `newCorrelationId` returns. */
  newCorrelationId(): string {
    return randomUUID();
  }
}
