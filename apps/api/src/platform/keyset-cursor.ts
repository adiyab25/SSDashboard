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
