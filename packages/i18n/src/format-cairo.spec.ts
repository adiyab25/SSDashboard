import { describe, expect, it } from 'vitest';
import { createFormatter } from './format.js';

/** Drops the invisible direction marks and turns no break spaces into spaces, for comparing. */
const plain = (text: string) =>
  text.replace(/[\u200e\u200f\u061c]/g, '').replace(/\u00a0/g, String.fromCharCode(32));

const cairo = { currency: 'EGP', timezone: 'Africa/Cairo' };
const english = createFormatter({ language: 'en', ...cairo });
const arabic = createFormatter({ language: 'ar', ...cairo });

// Spec 0004 AC-20: Egypt's 2026 daylight saving transitions, shown in Cairo time.
describe('Cairo daylight saving display (AC-20)', () => {
  it('spring forward: the last second before 24 Apr is 23:59 on 23 Apr', () => {
    const instant = '2026-04-23T21:59:59Z';
    expect(english.time(instant)).toBe('23:59');
    expect(english.date(instant)).toBe('23 Apr 2026');
    expect(english.dateTime(instant)).toBe('23 Apr 2026, 23:59');
    expect(plain(arabic.time(instant))).toBe('11:59 م');
    expect(plain(arabic.dateTime(instant))).toBe('23 أبريل 2026، 11:59 م');
  });

  it('spring forward: the next second is 01:00 on 24 Apr, 00:00 never appears', () => {
    const instant = '2026-04-23T22:00:00Z';
    expect(english.time(instant)).toBe('01:00');
    expect(english.date(instant)).toBe('24 Apr 2026');
    expect(english.dateTime(instant)).toBe('24 Apr 2026, 01:00');
    expect(plain(arabic.time(instant))).toBe('01:00 ص');
    expect(plain(arabic.date(instant))).toBe('24 أبريل 2026');
    expect(plain(arabic.dateTime(instant))).toBe('24 أبريل 2026، 01:00 ص');

    // No instant of 24 April (23 hours) shows midnight.
    const start = Date.parse(instant);
    for (let minute = 0; minute < 23 * 60; minute += 1) {
      const shown = english.time(new Date(start + minute * 60_000));
      expect(shown.startsWith('00:')).toBe(false);
    }
  });

  it('fall back: both passes of the repeated hour show 23:30 on 29 Oct', () => {
    for (const instant of ['2026-10-29T20:30:00Z', '2026-10-29T21:30:00Z']) {
      expect(english.time(instant)).toBe('23:30');
      expect(english.date(instant)).toBe('29 Oct 2026');
      expect(english.dateTime(instant)).toBe('29 Oct 2026, 23:30');
      expect(plain(arabic.time(instant))).toBe('11:30 م');
      expect(plain(arabic.dateTime(instant))).toBe('29 أكتوبر 2026، 11:30 م');
    }
  });

  it('a date only operating day never shifts across the transitions', () => {
    expect(english.dateOnly('2026-04-24')).toBe('24 Apr 2026');
    expect(plain(arabic.dateOnly('2026-04-24'))).toBe('24 أبريل 2026');
    expect(english.dateOnly('2026-10-29')).toBe('29 Oct 2026');
    expect(plain(arabic.dateOnly('2026-10-29'))).toBe('29 أكتوبر 2026');
  });
});
