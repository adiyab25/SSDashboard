import { Inject, Injectable } from '@nestjs/common';
import { HAT_AUDIENCE, type Hat, type Home } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import type { AudienceName } from '../../platform/audience/audience.decorator.js';

/** The audiences a session can serve: the two kinds of person who sign in (spec 0007, section 2). */
export type SessionAudience = Extract<AudienceName, 'staff' | 'partner'>;

/**
 * The port behind "which audiences may this person use" (spec 0005, AC-29). The session guard
 * asks it on every request, so a hat change acts on the person's next request with the same
 * cookie (AC-33 a). {@link HatSessionAudiences} answers it from the person's hats (spec 0008)
 * and is bound to {@link SESSION_AUDIENCES}.
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

/** The Nest token `SessionAudiences` is bound to: `HatSessionAudiences` in `identity.module.ts`. */
export const SESSION_AUDIENCES = Symbol('SessionAudiences');

const NONE: ReadonlySet<SessionAudience> = new Set();
const PARTNER: ReadonlySet<SessionAudience> = new Set(['partner']);
const STAFF: ReadonlySet<SessionAudience> = new Set(['staff']);

/**
 * The audiences a set of hats signs in to (spec 0008, AC-10): `partner` for the partner hat,
 * `staff` for any other, none for no hat. The partner hat wins over any other a row might hold
 * (the hat rules keep it alone), so a person is never both, exactly as `staffCondition()` says.
 * The one rule the port and a hat change judge by (identity AGENTS item 10): never decide an
 * audience from hats anywhere else.
 */
export function audiencesOfHats(hats: readonly Hat[]): ReadonlySet<SessionAudience> {
  if (hats.length === 0) return NONE;
  return hats.some((hat) => HAT_AUDIENCE[hat] === 'partner') ? PARTNER : STAFF;
}

/**
 * A SQL condition on a row of `users`, named `users` in the query, that holds when the person
 * wears this hat (identity's own `hat_assignments`).
 */
export function holdsHat(hat: Hat): SQL {
  return sql`EXISTS (SELECT 1 FROM hat_assignments h WHERE h.user_id = users.id AND h.hat = ${hat})`;
}

/**
 * The real `SessionAudiences` (spec 0005 AC-29, spec 0008 AC-10), bound to `SESSION_AUDIENCES` in
 * `identity.module.ts` and built by `src/create-admin.ts`, which has no Nest container. It reads
 * the person's hats from `hat_assignments` on every call and caches nothing; `staffCondition()` is
 * the same answer as SQL: at least one hat, and not the partner hat.
 */
@Injectable()
export class HatSessionAudiences implements SessionAudiences {
  private readonly db: Database;

  /** Takes the database connection the person's hats are read from. */
  constructor(@Inject(DATABASE) connection: DatabaseConnection) {
    this.db = connection.db;
  }

  /** The audiences of the person's hats, read now; empty when they hold none. */
  async audiencesFor(userId: string): Promise<ReadonlySet<SessionAudience>> {
    const result = await this.db.execute<{ hat: Hat }>(
      sql`SELECT hat FROM hat_assignments WHERE user_id = ${userId}::uuid`,
    );
    return audiencesOfHats(result.rows.map((row) => row.hat));
  }

  /** True for a person who wears at least one hat and not the partner hat. */
  staffCondition(): SQL {
    return sql`(EXISTS (SELECT 1 FROM hat_assignments h WHERE h.user_id = users.id)
      AND NOT ${holdsHat('partner')})`;
  }
}

/**
 * Where the person lands after sign in (AC-28): `partner` when they may use the partner audience,
 * `backoffice` otherwise (spec 0008, AC-10). It never looks at the requested page.
 */
export function homeOf(audiences: ReadonlySet<SessionAudience>): Home {
  return audiences.has('partner') ? 'partner' : 'backoffice';
}
