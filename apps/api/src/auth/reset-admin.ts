import { sql, type Database } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { emailKey } from './client-info.js';
import { ADMIN_RULE_LOCK } from './locks.js';
import { deleteTokens } from './reset-tokens.js';
import { generateTemporaryPassword } from './temporary-password.js';

const ResetAdminInput = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });

export type ResetAdminResult =
  | { reset: true; userId: string; email: string; temporaryPassword: string }
  | {
      reset: false;
      reason: 'invalid_input' | 'not_found' | 'not_admin' | 'disabled';
      message: string;
    };

/**
 * Break glass for `create-admin --reset-password` (spec 0005, AC-21): a new temporary password
 * for an existing admin when mail is off and nobody can sign in. The old hash is replaced in the
 * same transaction, sessions and older reset links go, the lockout clears, and the person must
 * change the password at next sign in. Takes the same lock as the staff service and first admin.
 */
export async function resetAdminPassword(
  db: Database,
  input: { email: string },
): Promise<ResetAdminResult> {
  const parsed = ResetAdminInput.safeParse(input);
  if (!parsed.success) {
    return { reset: false, reason: 'invalid_input', message: z.prettifyError(parsed.error) };
  }
  const { email } = parsed.data;

  // Hashed before the transaction opens: hashing is slow and must not hold the lock.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return db.transaction(async (tx): Promise<ResetAdminResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_RULE_LOCK})`);

    const found = await tx.execute<{ id: string; role: string; banned: boolean }>(
      sql`SELECT id, role, banned FROM users WHERE lower(email) = ${email} FOR UPDATE`,
    );
    const user = found.rows[0];
    if (!user) {
      return { reset: false, reason: 'not_found', message: `No account has the email ${email}.` };
    }
    if (user.role !== 'admin') {
      return {
        reset: false,
        reason: 'not_admin',
        message: `${email} is not an admin. Ask an admin to reset their password from the staff page.`,
      };
    }
    if (user.banned) {
      return {
        reset: false,
        reason: 'disabled',
        message: `${email} is disabled. Enable the account before resetting its password.`,
      };
    }

    await tx.execute(
      sql`INSERT INTO accounts (user_id, provider_id, account_id, password)
          VALUES (${user.id}::uuid, 'credential', ${user.id}, ${passwordHash})
          ON CONFLICT (provider_id, account_id)
          DO UPDATE SET password = excluded.password, updated_at = now()`,
    );
    await tx.execute(
      sql`UPDATE users SET must_change_password = true, updated_at = now() WHERE id = ${user.id}::uuid`,
    );
    await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${user.id}::uuid`);
    await deleteTokens(tx, user.id);
    // Pending two factor challenges (Better Auth: identifier `2fa-<random>`, value = user id, plus
    // a `2fa-attempts-<that identifier>` counter row) would let a half finished sign in resume.
    await tx.execute(
      sql`DELETE FROM verifications
          WHERE identifier IN (SELECT '2fa-attempts-' || identifier FROM verifications
                                WHERE value = ${user.id} AND identifier LIKE '2fa-%'
                                  AND identifier NOT LIKE '2fa-attempts-%')`,
    );
    await tx.execute(
      sql`DELETE FROM verifications
          WHERE value = ${user.id} AND identifier LIKE '2fa-%' AND identifier NOT LIKE '2fa-attempts-%'`,
    );
    await tx.execute(sql`DELETE FROM sign_in_attempts WHERE email_key = ${emailKey(email)}`);
    return { reset: true, userId: user.id, email, temporaryPassword };
  });
}
