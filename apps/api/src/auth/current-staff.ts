import type { Request } from 'express';
import type { MeResponse } from '@ssdashboard/contracts';

/** The signed in person and their session, read fresh from the database by the guard. */
export interface CurrentStaff extends MeResponse {
  sessionId: string;
}

export type AuthenticatedRequest = Request & { staff: CurrentStaff };
