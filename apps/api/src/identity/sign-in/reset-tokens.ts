import { randomInt } from 'node:crypto';
import { sql, type Database } from '@ssdashboard/db';
import { TOKEN_IDENTIFIER_PREFIX } from '../../mail/mail-links.js';
import type { MailKind } from '../../mail/mail-templates.js';

/** How long a link works: a reset 1 hour, an invite 7 days (spec 0005, AC-9, AC-12). */
export const TOKEN_LIFE_SECONDS: Record<MailKind, number> = {
  reset: 60 * 60,
  invite: 7 * 24 * 60 * 60,
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Same shape as Better Auth's own token (24 letters and digits), so its `/reset-password` accepts it. */
export function generateToken(length = 24): string {
  let token = '';
  for (let i = 0; i < length; i += 1) token += ALPHABET.charAt(randomInt(ALPHABET.length));
  return token;
}

/** Anything that can run a query: the database, or a transaction on it. */
export type Executor = Pick<Database, 'execute'>;

/** Removes a person's unused reset and invite tokens. Returns how many it removed. */
export async function deleteTokens(executor: Executor, userId: string): Promise<number> {
  const result = await executor.execute(
    sql`DELETE FROM verifications WHERE value = ${userId} AND identifier LIKE ${`${TOKEN_IDENTIFIER_PREFIX}%`}`,
  );
  return result.rowCount ?? 0;
}

/**
 * Writes a new token straight into `verifications`, in Better Auth's own format, and deletes the
 * person's older ones so only the newest link works (spec 0005, decisions: invites). Better Auth's
 * `/reset-password` redeems it, so there is one redeem path for resets and invites.
 */
export async function issueToken(
  executor: Executor,
  userId: string,
  kind: MailKind,
): Promise<{ token: string; tokenId: string }> {
  await deleteTokens(executor, userId);
  const token = generateToken();
  const result = await executor.execute<{ id: string }>(
    sql`INSERT INTO verifications (identifier, value, expires_at)
        VALUES (${`${TOKEN_IDENTIFIER_PREFIX}${token}`}, ${userId},
                now() + make_interval(secs => ${TOKEN_LIFE_SECONDS[kind]}::int))
        RETURNING id`,
  );
  const tokenId = result.rows[0]?.id;
  if (tokenId === undefined) throw new Error('Could not store the token');
  return { token, tokenId };
}

/**
 * Removes a person's pending two factor challenges (Better Auth: identifier `2fa-<random>`, value =
 * user id, plus a `2fa-attempts-<that identifier>` counter row), so a half finished sign in cannot
 * resume after a reset. The counters go first, while the challenge rows that name them still exist.
 */
export async function deleteTwoFactorChallenges(executor: Executor, userId: string): Promise<void> {
  await executor.execute(
    sql`DELETE FROM verifications
        WHERE identifier IN (SELECT '2fa-attempts-' || identifier FROM verifications
                              WHERE value = ${userId} AND identifier LIKE '2fa-%'
                                AND identifier NOT LIKE '2fa-attempts-%')`,
  );
  await executor.execute(
    sql`DELETE FROM verifications
        WHERE value = ${userId} AND identifier LIKE '2fa-%' AND identifier NOT LIKE '2fa-attempts-%'`,
  );
}
