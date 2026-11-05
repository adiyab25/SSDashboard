import { schema, sql, type Database } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
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
 * Creates the very first admin (spec 0005, AC-21): a temporary password the person must
 * change at first sign in. It refuses when an active admin already exists or the email
 * already belongs to any account, under the same lock the staff service takes.
 */
export async function createFirstAdmin(
  db: Database,
  input: { email: string; name: string },
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

    const admins = await tx.execute(
      sql`SELECT 1 FROM users WHERE role = 'admin' AND NOT banned LIMIT 1`,
    );
    if (admins.rows.length > 0) {
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
      .values({ name, email, role: 'admin', mustChangePassword: true })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('Could not create the admin account');
    // Better Auth's own layout: one `credential` account whose id is the user id.
    await tx.insert(schema.accounts).values({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: passwordHash,
    });
    return { created: true, userId: user.id, temporaryPassword };
  });
}
