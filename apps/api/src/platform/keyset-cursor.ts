/** The cursor does not decode to a key this endpoint issued. */
export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not one this endpoint issued');
  }
}

/** A page cursor: the last row's sort key as JSON, base64url encoded. */
export function encodeKeyset(key: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decodes a cursor into exactly `length` string parts, or throws `InvalidCursorError`. */
export function decodeKeyset(cursor: string, length: number): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== length ||
    !parsed.every((part): part is string => typeof part === 'string' && part.length > 0)
  ) {
    throw new InvalidCursorError();
  }
  if (encodeKeyset(parsed) !== cursor) throw new InvalidCursorError();
  return parsed;
}

/** The microsecond UTC timestamp the API issues (`to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`). */
const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decodes a (timestamp, id) keyset cursor: part 0 must be a microsecond UTC timestamp and part 1
 * a UUID, so a forged but well formed cursor answers `InvalidCursorError` (400), never a cast
 * error from Postgres (500).
 */
export function decodeTimeIdKeyset(cursor: string): { at: string; id: string } {
  const [at, id] = decodeKeyset(cursor, 2);
  if (!at || !id || !MICROSECOND_UTC.test(at) || !UUID.test(id) || !isRealInstant(at)) {
    throw new InvalidCursorError();
  }
  return { at, id };
}

/**
 * A real calendar instant: V8 `Date.parse` rolls `02-30` over to March and accepts year 0000,
 * which Postgres `::timestamptz` rejects (22008), so require a millisecond round trip and a
 * year of 1 or later.
 */
function isRealInstant(at: string): boolean {
  if (at.startsWith('0000')) return false;
  const ms = Date.parse(at);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 23) === at.slice(0, 23);
}
