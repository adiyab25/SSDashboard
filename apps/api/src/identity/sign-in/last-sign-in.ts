import { sql, type Database } from '@ssdashboard/db';

/**
 * Records the facts of a person's own sign in: when they last signed in, and that the forced first
 * password change is done. It is a port so the hooks stay testable and so neither write can go
 * through Better Auth's `updateUser`, which also moves `users.updated_at`.
 */
export interface LastSignIn {
  /** Writes `users.last_sign_in_at` for one person and nothing else. */
  stamp(userId: string, at: Date): Promise<void>;
  /** Writes `users.must_change_password = false` for one person and nothing else. */
  clearForcedPasswordChange(userId: string): Promise<void>;
}

/**
 * Builds the {@link LastSignIn} that writes straight to `users`. It must never touch
 * `updated_at`: that column is the stale record token of the access change, read from the detail (spec
 * 0008 AC-12), so a sign in, or the forced password change that is part of one, that moved it
 * would turn a manager's open dialog into a false 409 `STALE_RECORD`. It never names `tenant_id`; the row is found by its id.
 */
export function createLastSignIn(db: Database): LastSignIn {
  return {
    async stamp(userId, at) {
      await db.execute(
        sql`UPDATE users SET last_sign_in_at = ${at.toISOString()}::timestamptz WHERE id = ${userId}::uuid`,
      );
    },
    async clearForcedPasswordChange(userId) {
      await db.execute(
        sql`UPDATE users SET must_change_password = false WHERE id = ${userId}::uuid`,
      );
    },
  };
}
