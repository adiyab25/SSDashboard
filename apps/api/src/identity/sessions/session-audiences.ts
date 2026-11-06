import { Injectable } from '@nestjs/common';
import type { Home } from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import type { AudienceName } from '../../platform/audience/audience.decorator.js';

/** The audiences a session can serve: the two kinds of person who sign in (spec 0007, section 2). */
export type SessionAudience = Extract<AudienceName, 'staff' | 'partner'>;

/**
 * The port behind "which audiences may this person use" (spec 0005, AC-29). The session guard
 * asks it on every request, so a hat change acts on the person's next request with the same
 * cookie (AC-33 a). Spec 0008 supplies the real implementation from the person's hats and binds
 * it to {@link SESSION_AUDIENCES}; until then {@link StaffOnlySessionAudiences} answers `staff`
 * for everyone.
 *
 * An implementation must read the database on every call: it must never cache an answer, and the
 * answer must never be stored in the session or the cookie.
 */
export interface SessionAudiences {
  /**
   * The audiences the person may use, read fresh. An empty set means the person holds no hat:
   * the guard ends their sessions (spec 0008, AC-10).
   */
  audiencesFor(userId: string): Promise<ReadonlySet<SessionAudience>>;

  /**
   * A SQL condition on a row of the `users` table, named `users` in the query, that holds exactly
   * when that person may use the staff audience: the same answer as `audiencesFor`, in a form a
   * list or a count can use. `/api/staff`, the last admin rule (AC-17) and `create-admin` put it
   * in their `WHERE`, so a partner user is never listed, counted as an admin or made one (AC-28).
   */
  staffCondition(): SQL;
}

/** The Nest token `SessionAudiences` is bound to. Spec 0008 rebinds it to the hat based one. */
export const SESSION_AUDIENCES = Symbol('SessionAudiences');

const STAFF_ONLY: ReadonlySet<SessionAudience> = new Set(['staff']);

/**
 * The one implementation before spec 0008 (spec 0005, AC-28): every person is staff. It reads
 * nothing, because before hats there is nothing a person could hold that changes the answer. It
 * must never answer `partner`.
 */
@Injectable()
export class StaffOnlySessionAudiences implements SessionAudiences {
  /** Always `staff`, whoever the person is. */
  audiencesFor(_userId: string): Promise<ReadonlySet<SessionAudience>> {
    return Promise.resolve(STAFF_ONLY);
  }

  /** Always true: every row of `users` is a staff person. */
  staffCondition(): SQL {
    return sql`TRUE`;
  }
}

/**
 * Where the person lands after sign in (AC-28): `partner` when they may use the partner audience,
 * `backoffice` otherwise (spec 0008, AC-10). It never looks at the requested page.
 */
export function homeOf(audiences: ReadonlySet<SessionAudience>): Home {
  return audiences.has('partner') ? 'partner' : 'backoffice';
}
