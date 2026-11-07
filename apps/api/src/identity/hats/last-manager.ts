import { ConflictException } from '@nestjs/common';
import { sql, type SQL } from '@ssdashboard/db';
import type { Transaction } from '../../database/sql.js';
import { holdsHat } from '../sessions/session-audiences.js';
import { ADMIN_RULE_LOCK } from '../sign-in/locks.js';

/**
 * Takes `ADMIN_RULE_LOCK` for the rest of the transaction (spec 0005 AC-17, spec 0008 AC-12). Every
 * change that could leave no active manager takes it first, before it locks the person's `users`
 * row, so every writer takes the two in the same order and none waits on another in a circle.
 */
export async function lockAdminRule(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_RULE_LOCK})`);
}

/**
 * Throws 409 `LAST_ADMIN` unless another active manager exists: a staff person wearing `manager`
 * who is not disabled (one who has not signed in yet still counts), other than `exceptId`
 * (spec 0008 AC-14). A partner user never counts, whatever their rows say (spec 0005 AC-28), so
 * the caller passes `staffCondition()`. Runs under {@link lockAdminRule}, taken by the caller in
 * the same transaction; each statement reads what committed before it, so of two managers taking
 * each other's hat at once, the second to get the lock sees the first one's change.
 */
export async function assertAnotherManager(
  tx: Transaction,
  exceptId: string,
  staffOnly: SQL,
): Promise<void> {
  const others = await tx.execute(
    sql`SELECT 1 FROM users
        WHERE ${holdsHat('manager')} AND NOT banned AND id <> ${exceptId}::uuid AND (${staffOnly})
        LIMIT 1`,
  );
  if (others.rows.length === 0) {
    throw new ConflictException({
      code: 'LAST_ADMIN',
      message: 'There must always be at least one active manager',
    });
  }
}
