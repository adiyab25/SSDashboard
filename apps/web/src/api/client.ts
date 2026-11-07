import { apiFetch } from '@/auth/api-fetch';

/** The api's error body: a stable `code`, plus whatever detail that code carries. */
export interface ApiErrorBody {
  code: string;
  lineErrors?: { index: number; code: string }[];
  /** `INSUFFICIENT_STOCK` on a void: the SKUs that would go below zero. */
  skuIds?: string[];
  /** `UNDO_NOT_POSSIBLE` on an audit undo: the owning module's own code, such as `MERGE_NOT_LATEST`. */
  undoCode?: string;
  /** `SETTING_INVALID`: where inside the value each fault is (a document type, an array index, or empty). */
  issues?: { path: string; message: string }[];
}

/** A failed call. `status` 0 means the request never got an answer. */
export class ApiError extends Error {
  /** Carries the HTTP status, the error body, and a parsed `Retry-After`. */
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
    /** Seconds from a `Retry-After` header, when the api sent one. */
    readonly retryAfter: number | null = null,
  ) {
    super(`api answered ${status} ${body.code}`);
    this.name = 'ApiError';
  }

  /** The stable error code from the body. */
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
  const skuIds =
    'skuIds' in json && Array.isArray(json.skuIds)
      ? json.skuIds.filter((id): id is string => typeof id === 'string')
      : undefined;
  const undoCode =
    'undoCode' in json && typeof json.undoCode === 'string' ? json.undoCode : undefined;
  const issues =
    'issues' in json && Array.isArray(json.issues)
      ? json.issues.flatMap((item: unknown) => {
          if (typeof item !== 'object' || item === null) return [];
          const { path, message } = item as { path?: unknown; message?: unknown };
          return typeof message === 'string'
            ? [{ path: typeof path === 'string' ? path : '', message }]
            : [];
        })
      : undefined;
  return {
    code,
    ...(lineErrors && { lineErrors }),
    ...(skuIds && { skuIds }),
    ...(undoCode && { undoCode }),
    ...(issues && { issues }),
  };
}

/**
 * One call to a relative `/api` path, parsed with the contract schema. Resolves to the data, or
 * throws `ApiError` with the api's stable code, which is what TanStack Query hands to `error`.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

/** Seconds to wait before the one automatic retry when the api sends no `Retry-After`. */
const DEFAULT_BUSY_SECONDS = 2;

/**
 * Runs a stock write, and when the api answers 503 `BUSY` waits for its `Retry-After` and sends
 * the very same request once more (spec 0006, AC-14). A second `BUSY` is thrown for the screen
 * to show its busy message and a Retry button. The caller passes the same idempotency key both
 * times, so a retry can never post twice.
 */
export async function withBusyRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'BUSY') throw error;
    const seconds = error.retryAfter ?? DEFAULT_BUSY_SECONDS;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return run();
  }
}
