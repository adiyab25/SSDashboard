import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import type { Transaction } from '../../database/sql.js';
import type { IdentityAudit, IdentityAuditEntry } from './identity-audit.js';

/**
 * The identity audit port over spec 0010's audit trail (spec 0008 AC-13, spec 0010 task 10): each
 * entry goes to `AuditService.record` through the caller's transaction, unchanged, so the change
 * and its `audit_entries` row commit or roll back together. Identity reaches the audit module only
 * through this adapter and the exported `AuditService`, never its table. It must never open a
 * transaction, catch an error, or write after the commit.
 */
@Injectable()
export class AuditTrailIdentityAudit implements IdentityAudit {
  /** Takes the audit trail's only writer. */
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** Writes the entry through `tx`; every refusal of `AuditService.record` rolls `tx` back. */
  record(tx: Transaction, entry: IdentityAuditEntry): Promise<void> {
    return this.audit.record(tx, entry);
  }

  /** A fresh correlation id from the audit trail. */
  newCorrelationId(): string {
    return this.audit.newCorrelationId();
  }
}
