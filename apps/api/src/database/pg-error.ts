/** A pg SQLSTATE: five digits or capital letters. Anything else is not printed. */
const PG_CODE = /^[0-9A-Z]{5}$/;

/**
 * The pg error code behind a failed Drizzle query, read from `cause` only. The error's message
 * and the pg message can hold the query's params (emails, password hashes), so neither is used.
 */
export function pgErrorCode(error: unknown): string | undefined {
  const code = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  return typeof code === 'string' && PG_CODE.test(code) ? code : undefined;
}

/**
 * Drizzle's failed query error. Its message and stack carry the query's params (emails, password
 * hashes), so it is told apart by shape, without importing `drizzle-orm` here.
 */
export function isQueryError(error: unknown): error is Error & { query: string; params: unknown } {
  return (
    error instanceof Error &&
    typeof (error as { query?: unknown }).query === 'string' &&
    'params' in error
  );
}

/** What gets logged in place of a failed query: no SQL, no params, no pg message or detail. */
export class FailedQueryError extends Error {
  constructor(code: string | undefined) {
    super(code ? `Failed query (pg ${code})` : 'Failed query');
    this.name = 'FailedQueryError';
  }
}

/** The error to hand a logger: a failed query becomes `FailedQueryError`, anything else as is. */
export function loggableError(error: unknown): unknown {
  return isQueryError(error) ? new FailedQueryError(pgErrorCode(error)) : error;
}

/** Drizzle's message layout (`Failed query: <sql>\nparams: <values>`), when it arrives as text. */
const QUERY_TEXT = /^Failed query:/;

/**
 * One line of text for a log, safe to print: a failed query (as an error, or as Drizzle's message
 * text) reads `FailedQueryError: Failed query (pg <code>)` only. Any other error keeps its usual
 * text, with its stack when `withStack` is set.
 */
export function describeError(error: unknown, withStack = false): string {
  const safe = loggableError(error);
  if (safe instanceof FailedQueryError) return String(safe);
  if (safe instanceof Error) return (withStack && safe.stack) || String(safe);
  if (typeof safe === 'string') return QUERY_TEXT.test(safe) ? 'Failed query' : safe;
  return String(safe);
}
