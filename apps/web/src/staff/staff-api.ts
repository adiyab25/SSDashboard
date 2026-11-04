import {
  CreateStaffResponse,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
  StaffDetail,
  StaffListResponse,
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

export interface StaffFilter {
  q: string;
  status: StaffStatus | '';
}

export function listStaff(filter: StaffFilter, cursor?: string) {
  const params = new URLSearchParams({ limit: '50' });
  if (filter.q) params.set('q', filter.q);
  if (filter.status) params.set('status', filter.status);
  if (cursor) params.set('cursor', cursor);
  return request('GET', `/api/staff?${params}`, StaffListResponse);
}

export const getStaff = (id: string) => request('GET', `/api/staff/${id}`, StaffDetail);

export const createStaff = (body: Record<string, unknown>) =>
  request('POST', '/api/staff', CreateStaffResponse, body);

export const updateStaff = (id: string, body: Record<string, unknown>) =>
  request('PATCH', `/api/staff/${id}`, StaffDetail, body);

export const disableStaff = (id: string, reason: string) =>
  request('POST', `/api/staff/${id}/disable`, StaffDetail, reason ? { reason } : {});

export const enableStaff = (id: string) => request('POST', `/api/staff/${id}/enable`, StaffDetail);

export const resetStaffPassword = (id: string) =>
  request('POST', `/api/staff/${id}/reset-password`, ResetStaffPasswordResponse);

export const resendInvite = (id: string) => request('POST', `/api/staff/${id}/resend-invite`, Ok);

export const resetStaffTwoFactor = (id: string) =>
  request('POST', `/api/staff/${id}/reset-two-factor`, StaffDetail);

export const revokeStaffSessions = (id: string) =>
  request('POST', `/api/staff/${id}/revoke-sessions`, RevokeSessionsResponse);
