import {
  type CreatePartnerUserRequest,
  type UpdatePartnerUserRequest,
  CreatePartnerUserResponse,
  PartnerAccountsResponse,
  type PartnerAccessRequest,
  PartnerUserDetail,
  PartnerUserListResponse,
  type StaffStatus,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import { Ok, request } from './api-request';

/** The partner login list filters: text search, status and partner account (empty means any). */
export interface PartnerUserFilter {
  q: string;
  status: StaffStatus | '';
  partnerAccountId: string;
}

/** One page of partner logins, 50 a page, narrowed by the filter (`GET /api/partner-users`). */
export function listPartnerUsers(filter: PartnerUserFilter, cursor?: string) {
  const params = new URLSearchParams({ limit: '50' });
  if (filter.q) params.set('q', filter.q);
  if (filter.status) params.set('status', filter.status);
  if (filter.partnerAccountId) params.set('partnerAccountId', filter.partnerAccountId);
  if (cursor) params.set('cursor', cursor);
  return request('GET', `/api/partner-users?${params}`, PartnerUserListResponse);
}

/** The consignment partners a login can belong to, by code (`GET /api/partner-users/partner-accounts`). */
export const listPartnerAccounts = () =>
  request('GET', '/api/partner-users/partner-accounts', PartnerAccountsResponse);

/** One partner login's detail, with the `updatedAt` a move sends back. */
export const getPartnerUser = (id: string) =>
  request('GET', `/api/partner-users/${id}`, PartnerUserDetail);

/** Adds a partner login bound to a partner account; the api gives the `partner` hat and nothing else. */
export const createPartnerUser = (body: CreatePartnerUserRequest) =>
  request('POST', '/api/partner-users', CreatePartnerUserResponse, body);

/**
 * Changes a partner login's details: name, email, phone or language. Never the partner account:
 * the api refuses any other field (use {@link movePartnerUser}).
 */
export const updatePartnerUser = (id: string, body: z.input<typeof UpdatePartnerUserRequest>) =>
  request('PATCH', `/api/partner-users/${id}`, PartnerUserDetail, body);

/**
 * Binds a partner login to another partner account (spec 0008, AC-12) with the `updatedAt` read
 * before; the api ends every session of theirs in the same change.
 */
export const movePartnerUser = (id: string, body: PartnerAccessRequest) =>
  request('PUT', `/api/partner-users/${id}/access`, PartnerUserDetail, body);

/** Disables a partner login and ends its sessions, with an optional reason. */
export const disablePartnerUser = (id: string, reason: string) =>
  request('POST', `/api/partner-users/${id}/disable`, PartnerUserDetail, reason ? { reason } : {});

/** Enables a disabled partner login again. */
export const enablePartnerUser = (id: string) =>
  request('POST', `/api/partner-users/${id}/enable`, PartnerUserDetail);

/** Resets a partner login's password; the reply carries a temporary one or says mail went out. */
export const resetPartnerUserPassword = (id: string) =>
  request('POST', `/api/partner-users/${id}/reset-password`, ResetStaffPasswordResponse);

/** Sends the invite email again to a partner login that has not signed in yet. */
export const resendPartnerInvite = (id: string) =>
  request('POST', `/api/partner-users/${id}/resend-invite`, Ok);

/** Turns off a partner login's two factor sign in, for a lost device. */
export const resetPartnerUserTwoFactor = (id: string) =>
  request('POST', `/api/partner-users/${id}/reset-two-factor`, PartnerUserDetail);

/** Signs a partner login out everywhere. */
export const revokePartnerUserSessions = (id: string) =>
  request('POST', `/api/partner-users/${id}/revoke-sessions`, RevokeSessionsResponse);
