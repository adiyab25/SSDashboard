import { schema, sql, type Database } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { holdsHat, type SessionAudiences } from '../sessions/session-audiences.js';
import { ADMIN_RULE_LOCK } from './locks.js';
import { generateTemporaryPassword } from './temporary-password.js';

const FirstAdminInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().min(1).max(100),
});

/**
 * The outcome of creating the first admin: the new id and a one time temporary password, or the
 * reason nothing was created.
 */
export type FirstAdminResult =
  | { created: true; userId: string; temporaryPassword: string }
  | { created: false; reason: 'invalid_input' | 'admin_exists' | 'email_taken'; message: string };

/**
 * Creates the very first admin (spec 0005, AC-21): a person wearing the `manager` hat with the
 * `cost.view` grant (spec 0008, AC-14; `granted_by` null, no person gave them), and a temporary
 * password they must change at first sign in. It refuses when an active manager already exists
 * or the email already belongs to any account, under the same lock the staff service takes. It
 * creates staff only, and a partner user never counts as an existing manager (AC-28): `audiences`
 * says who is staff. It is required on purpose: the caller (`src/create-admin.ts`) must pass the
 * class `identity.module.ts` binds to `SESSION_AUDIENCES`, which a spec checks.
 */
export async function createFirstAdmin(
  db: Database,
  input: { email: string; name: string },
  audiences: Pick<SessionAudiences, 'staffCondition'>,
): Promise<FirstAdminResult> {
  const parsed = FirstAdminInput.safeParse(input);
  if (!parsed.success) {
    return { created: false, reason: 'invalid_input', message: z.prettifyError(parsed.error) };
  }
  const { email, name } = parsed.data;

  // Hashed before the transaction opens: hashing is slow and must not hold the lock.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return db.transaction(async (tx): Promise<FirstAdminResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_RULE_LOCK})`);

    const managers = await tx.execute(
      sql`SELECT 1 FROM users
          WHERE ${holdsHat('manager')} AND NOT banned AND (${audiences.staffCondition()}) LIMIT 1`,
    );
    if (managers.rows.length > 0) {
      return {
        created: false,
        reason: 'admin_exists',
        message: 'An active admin already exists. Sign in as that admin to add staff.',
      };
    }
    const existing = await tx.execute(sql`SELECT 1 FROM users WHERE lower(email) = ${email}`);
    if (existing.rows.length > 0) {
      return {
        created: false,
        reason: 'email_taken',
        message: `${email} already belongs to an account.`,
      };
    }

    const [user] = await tx
      .insert(schema.users)
      .values({ name, email, mustChangePassword: true })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('Could not create the admin account');
    // Better Auth's own layout: one `credential` account whose id is the user id.
    await tx.insert(schema.accounts).values({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: passwordHash,
    });
    await tx.insert(schema.hatAssignments).values({ userId: user.id, hat: 'manager' });
    await tx.insert(schema.permissionGrants).values({ userId: user.id, permission: 'cost.view' });
    return { created: true, userId: user.id, temporaryPassword };
  });
}
