import { describe, expect, it } from 'vitest';
import {
  decodeTimeIdKeyset,
  encodeKeyset,
  InvalidCursorError,
} from '../../platform/keyset-cursor.js';
import {
  compareTimeline,
  decodeTimelineCursor,
  encodeTimelineCursor,
  nextMicrosecond,
  orderCursorAfter,
  type TimelinePosition,
} from './timeline-cursor.js';

const at = '2026-11-01T10:00:00.123999Z';
const id = '0a5e7c3e-1111-4222-8333-944445555666';

describe('the timeline cursor (spec 0014 AC-14)', () => {
  it('round trips a position and lower cases the id', () => {
    const position: TimelinePosition = { at, source: 'merge', id };

    expect(decodeTimelineCursor(encodeTimelineCursor(position))).toEqual(position);
    expect(decodeTimelineCursor(encodeKeyset([at, 'phone', id.toUpperCase()]))).toEqual({
      at,
      source: 'phone',
      id,
    });
  });

  it('refuses a forged cursor', () => {
    for (const forged of [
      'not base64!',
      encodeKeyset([at, id]),
      encodeKeyset([at, 'credit', id]),
      encodeKeyset(['2026-02-30T10:00:00.000000Z', 'order', id]),
      encodeKeyset([at, 'order', 'nope']),
      encodeKeyset(['2026-11-01T10:00:00Z', 'order', id]),
      // Years outside 1970 to 9998: one microsecond past the end is year 10000 (review m1).
      encodeKeyset(['9999-12-31T23:59:59.999999Z', 'flag', id]),
      encodeKeyset(['9999-01-01T00:00:00.000000Z', 'order', id]),
      encodeKeyset(['0001-01-01T00:00:00.000000Z', 'merge', id]),
      encodeKeyset(['1969-12-31T23:59:59.999999Z', 'flag', id]),
    ]) {
      expect(() => decodeTimelineCursor(forged)).toThrow(InvalidCursorError);
    }
  });

  it('orders by time descending, then source, then id descending', () => {
    const items: TimelinePosition[] = [
      { at, source: 'phone', id },
      { at: '2026-11-02T00:00:00.000000Z', source: 'phone', id },
      { at, source: 'order', id: 'ffffffff-1111-4222-8333-944445555666' },
      { at, source: 'order', id },
      { at, source: 'flag', id },
    ];
    const sorted = [...items].sort(compareTimeline);

    expect(sorted.map((p) => `${p.at.slice(8, 10)} ${p.source} ${p.id.slice(0, 2)}`)).toEqual([
      '02 phone 0a',
      '01 flag 0a',
      '01 order ff',
      '01 order 0a',
      '01 phone 0a',
    ]);
  });

  it('adds one microsecond across a second and a day', () => {
    expect(nextMicrosecond(at)).toBe('2026-11-01T10:00:00.124000Z');
    expect(nextMicrosecond('2026-12-31T23:59:59.999999Z')).toBe('2027-01-01T00:00:00.000000Z');
    expect(nextMicrosecond('2026-11-01T10:00:00.000000Z')).toBe('2026-11-01T10:00:00.000001Z');
  });

  it('accepts the first and last years and steps there without losing the microsecond', () => {
    for (const edge of ['1970-01-01T00:00:00.000000Z', '9998-12-31T23:59:59.999998Z']) {
      expect(decodeTimelineCursor(encodeKeyset([edge, 'merge', id])).at).toBe(edge);
    }
    // Far from 1970 a float count of microseconds is past 2^53 and drops the + 1.
    expect(nextMicrosecond('9998-12-31T23:59:59.999998Z')).toBe('9998-12-31T23:59:59.999999Z');
    expect(nextMicrosecond('9998-12-31T23:59:59.999999Z')).toBe('9999-01-01T00:00:00.000000Z');
    expect(nextMicrosecond('2300-06-01T12:00:00.123456Z')).toBe('2300-06-01T12:00:00.123457Z');
    expect(nextMicrosecond('1970-01-01T00:00:00.000000Z')).toBe('1970-01-01T00:00:00.000001Z');
    expect(nextMicrosecond('1969-12-31T23:59:59.999999Z')).toBe('1970-01-01T00:00:00.000000Z');
    expect(nextMicrosecond('1969-12-31T23:59:59.998999Z')).toBe('1969-12-31T23:59:59.999000Z');
  });

  it('resumes the order source in the last year with a cursor the order source accepts', () => {
    const last = '9998-12-31T23:59:59.999999Z';
    expect(
      decodeTimeIdKeyset(orderCursorAfter({ at: last, source: 'merge', id }) as string),
    ).toEqual({
      at: '9999-01-01T00:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000000',
    });
  });

  it('resumes the order source exactly after any position', () => {
    expect(orderCursorAfter(null)).toBeNull();
    const decode = (cursor: string | null) => decodeTimeIdKeyset(cursor as string);
    expect(decode(orderCursorAfter({ at, source: 'order', id }))).toEqual({ at, id });
    // A source before `order` at the same instant: every order at that instant is still to come.
    expect(decode(orderCursorAfter({ at, source: 'merge', id }))).toEqual({
      at: '2026-11-01T10:00:00.124000Z',
      id: '00000000-0000-0000-0000-000000000000',
    });
    // A source after `order`: the orders at that instant were shown already.
    expect(decode(orderCursorAfter({ at, source: 'phone', id }))).toEqual({
      at,
      id: '00000000-0000-0000-0000-000000000000',
    });
  });
});
