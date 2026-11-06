import { describe, expect, it } from 'vitest';
import {
  decodeStaffCursor,
  encodeStaffCursor,
  escapeLike,
  InvalidStaffCursorError,
  statusOf,
} from './staff.service.js';

describe('statusOf (AC-15)', () => {
  const signedIn = new Date();

  it('is derived, never stored', () => {
    expect(statusOf({ banned: true, last_sign_in_at: signedIn })).toBe('disabled');
    expect(statusOf({ banned: true, last_sign_in_at: null })).toBe('disabled');
    expect(statusOf({ banned: false, last_sign_in_at: null })).toBe('invited');
    expect(statusOf({ banned: false, last_sign_in_at: signedIn })).toBe('active');
  });
});

describe('the staff cursor', () => {
  it('round trips a name and id, including Arabic and punctuation', () => {
    const cursor = { name: 'سامي \u200f"x", o/', id: '0190c0de-0000-7000-8000-000000000001' };

    expect(decodeStaffCursor(encodeStaffCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['empty text', ''],
    ['characters outside base64url', 'abc def'],
    ['JSON that is not a pair', Buffer.from('{"a":1}').toString('base64url')],
    ['a pair of numbers', Buffer.from('[1,2]').toString('base64url')],
    ['a loosely padded value we did not issue', `${encodeStaffCursor({ name: 'a', id: 'b' })}AA`],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeStaffCursor(value)).toThrow(InvalidStaffCursorError);
  });
});

describe('escapeLike (AC-15)', () => {
  it('escapes the characters LIKE treats as patterns, so a search is an exact contains match', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
    expect(escapeLike('plain')).toBe('plain');
  });
});
