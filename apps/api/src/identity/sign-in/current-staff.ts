import type { Request } from 'express';
import type { MeResponse } from '@ssdashboard/contracts';

/** The signed in person and their session, read fresh from the database by the guard. */
export interface CurrentStaff extends MeResponse {
  sessionId: string;
}

/**
 * The signed in partner user on a `partner` route (spec 0005, AC-29), read fresh from the
 * database by the guard in the same way. Spec 0008 adds the partner account id, read from the
 * person's own row: a handler must never take an account id from a header, path or body.
 */
export type CurrentPartner = CurrentStaff;

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
