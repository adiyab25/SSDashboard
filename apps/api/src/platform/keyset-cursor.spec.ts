import { describe, expect, it } from 'vitest';
import { InvalidCursorError, decodeTimeIdKeyset, encodeKeyset } from './keyset-cursor.js';

const AT = '2026-11-04T10:15:30.123456Z';
const ID = '019a4b2c-1d2e-7f30-8a41-b52c63d74e85';

describe('decodeTimeIdKeyset', () => {
  it('returns the timestamp and id of a cursor the API issued', () => {
    expect(decodeTimeIdKeyset(encodeKeyset([AT, ID]))).toEqual({ at: AT, id: ID });
  });

  it.each([
    ['two words', ['x', 'y']],
    ['a timestamp without microseconds', ['2026-11-04T10:15:30.123Z', ID]],
    ['an offset timestamp', ['2026-11-04T10:15:30.123456+02:00', ID]],
    ['an impossible date', ['2026-13-45T10:15:30.123456Z', ID]],
    ['February 30', ['2026-02-30T00:00:00.000000Z', ID]],
    ['February 29 in a non leap year', ['2026-02-29T00:00:00.000000Z', ID]],
    ['hour 24', ['2026-02-28T24:00:00.000000Z', ID]],
    ['year 0000', ['0000-01-01T00:00:00.000000Z', ID]],
    ['an id that is not a UUID', [AT, 'not-a-uuid']],
    ['the parts swapped', [ID, AT]],
  ])('rejects a well formed cursor of %s', (_label, parts) => {
    expect(() => decodeTimeIdKeyset(encodeKeyset(parts))).toThrow(InvalidCursorError);
  });

  it('accepts a valid leap day', () => {
    const at = '2028-02-29T23:59:59.999999Z';
    expect(decodeTimeIdKeyset(encodeKeyset([at, ID]))).toEqual({ at, id: ID });
  });

  it('rejects a cursor with the wrong number of parts', () => {
    expect(() => decodeTimeIdKeyset(encodeKeyset([AT]))).toThrow(InvalidCursorError);
  });
});
