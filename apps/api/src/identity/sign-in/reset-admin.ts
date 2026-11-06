import { sql, type Database } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { emailKey } from './client-info.js';
import { StaffOnlySessionAudiences, type SessionAudiences } from '../sessions/session-audiences.js';
import { ADMIN_RULE_LOCK } from './locks.js';
import { deleteTokens, deleteTwoFactorChallenges } from './reset-tokens.js';
import { generateTemporaryPassword } from './temporary-password.js';

const ResetAdminInput = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });

/**
 * Why a break glass reset did nothing: invalid input, no such person, not an admin, or a
 * disabled account, with a message safe to print.
 */
export type ResetRefusal = {
  reset: false;
  reason: 'invalid_input' | 'not_found' | 'not_admin' | 'disabled';
  message: string;
};

/** Which break glass changes to make. At least one is true. */
export type BreakGlassModes = { password: boolean; twoFactor: boolean };

/**
 * The outcome of a break glass reset: the person and the new temporary password (if the password
 * was reset), or a refusal.
 */
export type BreakGlassResult =
  | { reset: true; userId: string; email: string; temporaryPassword: string | undefined }
  | ResetRefusal;

/**
 * Break glass for `create-admin` when nobody can sign in, both modes in one transaction, all or
 * nothing. `password` (spec 0005, AC-21): a new temporary password replaces the old hash, older
 * reset links go, and the person must change it at next sign in. `twoFactor` (AC-26): the second
 * factor goes for an admin who lost the app and every backup code, keeping the password, the must
 * change flag and reset links. Either way sessions, pending challenges and the lockout end.
 * Takes the same lock as the staff service and first admin, then locks the user row. A new
 * password is hashed before the transaction opens: hashing is slow and must not hold the lock.
 * Staff admins only (AC-28): a partner user is refused as not an admin, whatever their row says;
 * `audiences` says who is staff, the staff only answer until spec 0008 passes the hat based one.
 */
export async function breakGlassReset(
  db: Database,
  input: { email: string },
  modes: BreakGlassModes,
  audiences: Pick<SessionAudiences, 'staffCondition'> = new StaffOnlySessionAudiences(),
): Promise<BreakGlassResult> {
  const parsed = ResetAdminInput.safeParse(input);
  if (!parsed.success) {
    return { reset: false, reason: 'invalid_input', message: z.prettifyError(parsed.error) };
  }
  const { email } = parsed.data;

  const temporaryPassword = modes.password ? generateTemporaryPassword() : undefined;
  const passwordHash =
    temporaryPassword === undefined ? undefined : await hashPassword(temporaryPassword);

  return db.transaction(async (tx): Promise<BreakGlassResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_RULE_LOCK})`);

    const found = await tx.execute<{ id: string; role: string; banned: boolean; staff: boolean }>(
      sql`SELECT id, role, banned, (${audiences.staffCondition()}) AS staff
            FROM users WHERE lower(email) = ${email} FOR UPDATE`,
    );
    const user = found.rows[0];
    if (!user) {
      return { reset: false, reason: 'not_found', message: `No account has the email ${email}.` };
    }
    const refusal = refuse(user, email, modes);
    if (refusal) return refusal;

    if (passwordHash !== undefined) {
      await tx.execute(
        sql`INSERT INTO accounts (user_id, provider_id, account_id, password)
            VALUES (${user.id}::uuid, 'credential', ${user.id}, ${passwordHash})
            ON CONFLICT (tenant_id, provider_id, account_id)
            DO UPDATE SET password = excluded.password, updated_at = now()`,
      );
      await tx.execute(
        sql`UPDATE users SET must_change_password = true, updated_at = now() WHERE id = ${user.id}::uuid`,
      );
      await deleteTokens(tx, user.id);
    }
    if (modes.twoFactor) {
      // Deleted without decrypting: after a `BETTER_AUTH_SECRET` rotation the row is unreadable.
      await tx.execute(sql`DELETE FROM two_factors WHERE user_id = ${user.id}::uuid`);
      await tx.execute(
        sql`UPDATE users SET two_factor_enabled = false, updated_at = now() WHERE id = ${user.id}::uuid`,
      );
    }
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${user.id}::uuid`);
    await deleteTwoFactorChallenges(tx, user.id);
    await tx.execute(sql`DELETE FROM sign_in_attempts WHERE email_key = ${emailKey(email)}`);
    return { reset: true, userId: user.id, email, temporaryPassword };
  });
}

/** The refusals for an account that exists; `undefined` means go ahead. */
function refuse(
  user: { role: string; banned: boolean; staff: boolean },
  email: string,
  modes: BreakGlassModes,
): ResetRefusal | undefined {
  const what =
    modes.password && modes.twoFactor
      ? 'password and two factor'
      : modes.password
        ? 'password'
        : 'two factor';
  if (user.role !== 'admin' || !user.staff) {
    return {
      reset: false,
      reason: 'not_admin',
      message: `${email} is not an admin. Ask an admin to reset their ${what} from the staff page.`,
    };
  }
  if (user.banned) {
    return {
      reset: false,
      reason: 'disabled',
      message: `${email} is disabled. Enable the account before resetting its ${what}.`,
    };
  }
  return undefined;
}
