import type { Request } from 'express';
import type { Home, MeResponse } from '@ssdashboard/contracts';

/**
 * The signed in person and their session, read fresh from the database by the guard. It holds no
 * hats or permissions and nothing to authorize on (spec 0008, AC-5): what the person may do is the
 * `Access` on `request.access` (`@CurrentAccess()` from `src/platform/access/`).
 */
export interface CurrentStaff extends Omit<
  MeResponse,
  'hats' | 'permissions' | 'partnerAccountId'
> {
  sessionId: string;
}

/**
 * The signed in partner user on a `partner` route (spec 0005, AC-29), read fresh from the
 * database by the guard on every request. Its own shape, not the staff one: it carries no staff
 * code and nothing to authorize on (permissions are on `request.access`). It holds
 * the person's id and what the partner "who am I" answer (`GET /api/partner/me`, spec 0008
 * AC-11) needs about the person.
 *
 * Spec 0008 (AC-9) adds `partnerAccountId`, read from the person's own hat row by the guard: a
 * handler must never take an account id from a header, path, query or body.
 */
export interface CurrentPartner {
  /** The partner user's id (`users.id`), named as spec 0008 AC-9 names it. */
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  language: string | null;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  /** Where the person lands; `partner` for anyone the guard lets onto a partner route. */
  home: Home;
  sessionId: string;
}

/**
 * An Express request after the session guard ran, with the signed in person on `staff`. Use it
 * in handlers that sit behind the guard on `staff` routes, never on public routes.
 */
export type AuthenticatedRequest = Request & { staff: CurrentStaff };

/**
 * An Express request on a `partner` route after the session guard ran: the person is on
 * `partner`, and `staff` is never set there.
 */
export type PartnerRequest = Request & { partner: CurrentPartner };
