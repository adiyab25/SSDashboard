import { apiFetch } from '@/auth/api-fetch';

/** The api's error body: a stable `code`, plus whatever detail that code carries. */
export interface ApiErrorBody {
  code: string;
  lineErrors?: { index: number; code: string }[];
}

/** A failed call. `status` 0 means the request never got an answer. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
    /** Seconds from a `Retry-After` header, when the api sent one. */
    readonly retryAfter: number | null = null,
  ) {
    super(`api answered ${status} ${body.code}`);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.body.code;
  }
}

function errorBody(json: unknown): ApiErrorBody {
  if (typeof json !== 'object' || json === null) return { code: 'generic' };
  const code = 'code' in json && typeof json.code === 'string' ? json.code : 'generic';
  const lineErrors =
    'lineErrors' in json && Array.isArray(json.lineErrors)
      ? json.lineErrors.filter(
          (item): item is { index: number; code: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { index?: unknown }).index === 'number' &&
            typeof (item as { code?: unknown }).code === 'string',
        )
      : undefined;
  return { code, ...(lineErrors && { lineErrors }) };
}

/**
 * One call to a relative `/api` path, parsed with the contract schema. Resolves to the data, or
 * throws `ApiError` with the api's stable code, which is what TanStack Query hands to `error`.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  schema: { parse: (value: unknown) => T },
  options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      method,
      cache: 'no-store',
      signal: options.signal,
      headers: {
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, { code: 'generic' });
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiError(
      response.status,
      errorBody(json),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return schema.parse(json);
}
