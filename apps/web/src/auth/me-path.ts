import type { Home } from '@ssdashboard/contracts';

/**
 * The api route of the signed in person for each audience (spec 0005, AC-28): staff read and edit
 * themselves on `/api/me`, partner users on `/api/partner/me`, because a controller has exactly
 * one audience. Both answer with the same `MeResponse` shape.
 */
export const ME_PATH: Record<Home, string> = {
  backoffice: '/api/me',
  partner: '/api/partner/me',
};
