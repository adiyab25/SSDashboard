import type { JsonObject } from '../../audit/audit.service.js';
import type { Transaction } from '../../database/sql.js';

/**
 * The audit actions identity writes (spec 0010, actions table): the access changes of spec 0008
 * (feature 8) and the staff account actions of spec 0010 task 10. Each is an entry of the registry
 * `AUDIT_ACTIONS` in `packages/contracts/src/audit/` (the adapter's types fail otherwise).
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
 * One audit entry, shaped exactly like spec 0010's `AuditEntryInput` so the adapter passes it on
 * unchanged: the actor, the action, the record (`{ type: 'user', id }` for everything identity
 * writes), the changed fields before and after, the optional reason, `reasonRequired` (set by
 * `HatService` when the manager hat is taken away, which the registry's per action `optional`
 * cannot say), and the correlation id of the business action. `before` and `after` hold ids, flags
 * and hat names only: never an email, a name or a phone.
 */
export interface IdentityAuditEntry {
  actor: IdentityAuditActor;
  action: IdentityAuditAction;
  record: { type: 'user'; id: string; label?: string };
  before?: JsonObject;
  after?: JsonObject;
  reason?: string;
  reasonRequired?: true;
  correlationId: string;
}

/**
 * Identity's port for the audit trail, shaped like spec 0010's `AuditService` (`record(tx, entry)`
 * and `newCorrelationId()`). Identity calls `record` inside the transaction of the change it
 * records, so the change and the entry commit or roll back together (spec 0010 AC-2, spec 0008
 * AC-13). An implementation must write through `tx` only: never open its own transaction, never
 * swallow an error, and never run after the commit.
 *
 * Bound to {@link IDENTITY_AUDIT} in `identity.module.ts`: the adapter over spec 0010's
 * `AuditService` (`audit-trail-identity-audit.ts`). A test may override the token with a probe.
 */
export interface IdentityAudit {
  /** Writes one entry through the caller's transaction. */
  record(tx: Transaction, entry: IdentityAuditEntry): Promise<void>;
  /** A fresh correlation id for one business action. */
  newCorrelationId(): string;
}

/** The Nest token {@link IdentityAudit} is bound to in `identity.module.ts`. */
export const IDENTITY_AUDIT = Symbol('IdentityAudit');
