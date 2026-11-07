import { apiFetch } from '@/auth/api-fetch';

/** An answer from `/api/staff` or `/api/partner-users`: the parsed data, or the stable error code. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

/**
 * Calls an api route with the session (`apiFetch`) and parses a good answer with the contract
 * schema; a refusal comes back as its stable error code. It never throws and never reads a
 * business rule: the screens only show what the api decided.
 */
export async function request<T>(
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
export const Ok = {
  /** Accepts any body: only the status of the call matters. */
  parse(): { ok: true } {
    return { ok: true };
  },
};
