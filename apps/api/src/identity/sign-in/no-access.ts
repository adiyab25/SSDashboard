import { Logger } from '@nestjs/common';
import { SignInErrorCode } from '@ssdashboard/contracts';
import { APIError } from 'better-auth/api';
import type { SessionAudiences } from '../sessions/session-audiences.js';

/**
 * The port the no access check asks: which audiences a person may use, read fresh from their hats
 * (`SessionAudiences.audiencesFor`).
 */
export type AccessAudiences = Pick<SessionAudiences, 'audiencesFor'>;

/** The session Better Auth has just created for a person, as the after hook sees it. */
export interface IssuedSession {
  user: { id: string };
  session?: { token: string };
}

/** Where the refused attempt came from, for its log line (ids and address only). */
export interface RefusedAttempt {
  ip: string | null;
  userAgent: string | null;
  at: Date;
}

const logger = new Logger('Auth');

/**
 * Refuses a sign in that has just succeeded for a person who holds no hat (spec 0008, AC-10): the
 * session Better Auth created is deleted at once, its cookie is dropped from the answer and the answer is 403 `NO_ACCESS`
 * (`SignInErrorCode` in `@ssdashboard/contracts`). It runs only after the password (or the second
 * factor code) was right, so a wrong password for a person with no hat answers exactly like any
 * wrong password and the refusal tells nobody that an email exists. The hats are read fresh, never
 * cached.
 *
 * Before it throws it writes one structured log line (`SignInRefused`, reason `no_access`, the
 * person's id, address, user agent and time; never an email), so a leaver who keeps trying with a
 * right password is seen (security review L4). Spec 0005's `SignInFailed` reasons stay as they are,
 * so it logs directly and emits no event. On the two factor code step a refused backup code is
 * already spent by Better Auth and stays spent.
 *
 * It is the whole "no hat means no sign in" rule on the Better Auth side, kept in this one file and
 * one call in each place a full session is issued, so a gate ruling that overturns it removes it
 * cleanly. It must never run before the password check, never look a person up by email, and never
 * read `users.role`.
 */
export async function refuseWhenNoHat(
  audiences: AccessAudiences,
  deleteSession: (token: string) => Promise<unknown>,
  issued: IssuedSession,
  responseHeaders?: Headers,
  attempt?: RefusedAttempt,
): Promise<void> {
  if ((await audiences.audiencesFor(issued.user.id)).size > 0) return;
  if (issued.session) await deleteSession(issued.session.token);
  // Better Auth keeps the headers its sign in has set (the session cookie) and merges them into the
  // answer to a hook's error: drop them, so no cookie leaves with the refusal.
  responseHeaders?.delete('set-cookie');
  logger.log(
    JSON.stringify({
      event: 'SignInRefused',
      reason: 'no_access',
      actorId: issued.user.id,
      ip: attempt?.ip ?? null,
      userAgent: attempt?.userAgent ?? null,
      at: attempt?.at.toISOString() ?? new Date().toISOString(),
    }),
  );
  throw APIError.from('FORBIDDEN', {
    code: SignInErrorCode.enum.NO_ACCESS,
    message: 'This account has no access yet. Ask a manager to give you a hat.',
  });
}
