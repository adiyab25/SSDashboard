import {
  type AccessRequest,
  type CreateStaffRequest,
  CreateStaffResponse,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
  StaffDetail,
  StaffListResponse,
  type StaffHat,
  type StaffStatus,
} from '@ssdashboard/contracts';
import { apiFetch } from '@/auth/api-fetch';

/** An answer from `/api/staff`: the parsed data, or the api's stable error code. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

async function request<T>(
  method: string,
  path: string,
  schema: { parse: (value: unknown) => T },
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await apiFetch(path, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      cache: 'no-store',
    });
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, data: schema.parse(json) };
    const code =
      typeof json === 'object' && json !== null && 'code' in json && typeof json.code === 'string'
        ? json.code
        : 'generic';
    return { ok: false, status: response.status, code };
  } catch {
    return { ok: false, status: 0, code: 'generic' };
  }
}

/** The api answers `{ ok: true }` to a re-invite; nothing else is read from it. */
const Ok = { parse: () => ({ ok: true as const }) };

/** The staff list filters: text search, status and hat (empty means any). */
export interface StaffFilter {
  q: string;
  status: StaffStatus | '';
  hat: StaffHat | '';
}

/** One page of staff, 50 a page, narrowed by the filter. */
export function listStaff(filter: StaffFilter, cursor?: string) {
  const params = new URLSearchParams({ limit: '50' });
  if (filter.q) params.set('q', filter.q);
  if (filter.status) params.set('status', filter.status);
  if (filter.hat) params.set('hat', filter.hat);
  if (cursor) params.set('cursor', cursor);
  return request('GET', `/api/staff?${params}`, StaffListResponse);
}

/** One staff member's detail. */
export const getStaff = (id: string) => request('GET', `/api/staff/${id}`, StaffDetail);

/**
 * Invites a new staff member with their hats and cost switch (spec 0008, AC-14). The body is the
 * contract's input shape; the api validates and normalises it.
 */
export const createStaff = (body: CreateStaffRequest) =>
  request('POST', '/api/staff', CreateStaffResponse, body);

/**
 * Changes a staff member's details: name, email, phone, staff code or language. Never hats or
 * cost: the api refuses any other field, `role` included (use {@link replaceStaffAccess}).
 */
export const updateStaff = (id: string, body: Record<string, unknown>) =>
  request('PATCH', `/api/staff/${id}`, StaffDetail, body);

/**
 * Replaces a person's whole access set, hats and cost switch (spec 0008, AC-12), with the
 * `updatedAt` read before so a change made meanwhile answers 409 `STALE_RECORD`. Answers the
 * person's detail with the new `updatedAt`.
 */
export const replaceStaffAccess = (id: string, body: AccessRequest) =>
  request('PUT', `/api/staff/${id}/access`, StaffDetail, body);

/** Disables a staff member and ends their sessions, with an optional reason (admin). */
export const disableStaff = (id: string, reason: string) =>
  request('POST', `/api/staff/${id}/disable`, StaffDetail, reason ? { reason } : {});

/** Enables a disabled staff member again (admin). */
export const enableStaff = (id: string) => request('POST', `/api/staff/${id}/enable`, StaffDetail);

/**
 * Resets a staff member's password; the reply carries a temporary one or says mail went out
 * (admin).
 */
export const resetStaffPassword = (id: string) =>
  request('POST', `/api/staff/${id}/reset-password`, ResetStaffPasswordResponse);

/** Sends the invite email again to a staff member who has not signed in yet (admin). */
export const resendInvite = (id: string) => request('POST', `/api/staff/${id}/resend-invite`, Ok);

/** Turns off a staff member's two factor sign in, for a lost device (admin). */
export const resetStaffTwoFactor = (id: string) =>
  request('POST', `/api/staff/${id}/reset-two-factor`, StaffDetail);

/** Signs a staff member out everywhere (admin). */
export const revokeStaffSessions = (id: string) =>
  request('POST', `/api/staff/${id}/revoke-sessions`, RevokeSessionsResponse);
