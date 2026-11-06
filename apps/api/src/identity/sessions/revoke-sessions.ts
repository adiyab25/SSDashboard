import { sql } from '@ssdashboard/db';
import type { Transaction } from '../../database/sql.js';
import type { SessionAudience } from './session-audiences.js';

/**
 * Deletes every session of the person inside the caller's transaction (spec 0005, AC-33 c), so
 * the change that called it and the sign out commit or roll back together, as disabling does
 * (AC-16). The person's next request with the old cookie is 401 `SESSION_EXPIRED`. Returns how
 * many sessions it ended.
 *
 * It takes a transaction on purpose: it must never open its own, and never run after the change
 * has committed, or a request could slip in between with the old access.
 */
export async function revokeSessions(userId: string, tx: Transaction): Promise<number> {
  const result = await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}::uuid`);
  return result.rowCount ?? 0;
}

/** What a hat change is judged on: the audiences the hats allow, and the bound partner account. */
export interface HatStanding {
  /** What `SessionAudiences.audiencesFor` answers for the hats; empty when no hat is held. */
  audiences: ReadonlySet<SessionAudience>;
  /** The partner account a partner user is bound to; `null` for staff and for no binding. */
  partnerAccountId: string | null;
}

/**
 * Whether a hat change must end the person's sessions (spec 0005, AC-33 b): yes when it leaves no
 * hat at all, moves the person between the staff and partner audiences, or binds them to another
 * partner account; no when they keep a hat of the same audience and the same account. The caller
 * then calls {@link revokeSessions} in the same transaction as the change.
 *
 * Spec 0008 may end sessions in more cases, never in fewer: never loosen a rule here.
 */
export function hatChangeEndsSessions(before: HatStanding, after: HatStanding): boolean {
  if (after.audiences.size === 0) return true;
  if (before.partnerAccountId !== after.partnerAccountId) return true;
  if (before.audiences.size !== after.audiences.size) return true;
  for (const audience of after.audiences) if (!before.audiences.has(audience)) return true;
  return false;
}
