import type { Request } from 'express';
import type { MeResponse } from '@ssdashboard/contracts';

/** The signed in person and their session, read fresh from the database by the guard. */
export interface CurrentStaff extends MeResponse {
  sessionId: string;
}

/**
 * An Express request after the session guard ran, with the signed in person on `staff`. Use it
 * in handlers that sit behind the guard, never on public routes.
 */
export type AuthenticatedRequest = Request & { staff: CurrentStaff };
