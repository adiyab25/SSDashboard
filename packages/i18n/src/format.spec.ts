import { describe, expect, it, vi } from 'vitest';
import { createFormatter, isValidTimeZone, type FormatterOptions } from './format.js';

/** Drops the invisible direction marks and turns no break spaces into spaces, for comparing. */
const plain = (text: string) =>
  text.replace(/[\u200e\u200f\u061c]/g, '').replace(/\u00a0/g, String.fromCharCode(32));

const settings = { currency: 'EGP', timezone: 'Africa/Cairo' };
const english: FormatterOptions = { language: 'en', ...settings };
const arabic: FormatterOptions = { language: 'ar', ...settings };

describe('numbers (AC-8)', () => {
  it('groups digits and keeps up to three decimals, in Western digits', () => {
    expect(createFormatter(english).number('1234.5')).toBe('1,234.5');
    expect(plain(createFormatter(arabic).number('1234.5'))).toBe('1,234.5');
  });

  it('formats quantities as whole numbers', () => {
    expect(createFormatter(english).quantity(12000)).toBe('12,000');
    expect(plain(createFormatter(arabic).quantity(12000))).toBe('12,000');
  });

  it('formats a percent from a decimal string', () => {
    expect(createFormatter(english).percent('14.00')).toBe('14%');
    expect(plain(createFormatter(arabic).percent('14.00'))).toBe('14%');
  });

  it('keeps up to 4 decimals of a percent when asked, and rounds to 2 by default', () => {
    expect(createFormatter(english).percent('2.7525')).toBe('2.75%');
    expect(createFormatter(english).percent('2.7525', { digits: 4 })).toBe('2.7525%');
    expect(plain(createFormatter(arabic).percent('2.7525', { digits: 4 }))).toBe('2.7525%');
    expect(createFormatter(english).percent('2.5000', { digits: 4 })).toBe('2.5%');
  });

  it('works before settings load', () => {
    const format = createFormatter({ language: 'en' });

    expect(format.number(1234.5)).toBe('1,234.5');
    expect(format.quantity(3)).toBe('3');
    expect(format.percent('7')).toBe('7%');
  });
});

describe('money', () => {
  it('uses the currency setting with the language style', () => {
    expect(plain(createFormatter(english).money('1234.5', 2))).toBe('EGP 1,234.50');
    expect(plain(createFormatter(arabic).money('1234.5', 2))).toBe('1,234.50 ج.م.');
  });

  it('keeps all four decimals of a unit cost, never rounding through a float', () => {
    expect(plain(createFormatter(english).money('12.3456', 4))).toBe('EGP 12.3456');
    expect(plain(createFormatter(english).money('0.1000', 4))).toBe('EGP 0.1000');
    // More digits than a double holds exactly.
    expect(plain(createFormatter(english).money('9007199254740993.01', 2))).toBe(
      'EGP 9,007,199,254,740,993.01',
    );
  });

  it('rounds half away from zero', () => {
    expect(plain(createFormatter(english).money('0.125', 2))).toBe('EGP 0.13');
  });

  it('returns the raw value and a loading status until the currency is known', () => {
    const format = createFormatter({ language: 'en', timezone: 'Africa/Cairo' });

    expect(format.money('1234.50', 2)).toBe('1234.50');
  });
});

describe('dates and times (AC-8)', () => {
  // 22:30 UTC on 3 November is 00:30 on 4 November in Cairo (UTC+2).
  const instant = '2026-11-03T22:30:00Z';

  it('shows an instant in the install time zone, day first', () => {
    const format = createFormatter(english);

    expect(format.date(instant)).toBe('4 Nov 2026');
    expect(format.dateNumeric(instant)).toBe('04/11/2026');
    expect(format.time(instant)).toBe('00:30');
    expect(format.dateTime(instant)).toBe('4 Nov 2026, 00:30');
  });

  it('shows the same instant in the install time zone for every user, whatever the language', () => {
    const format = createFormatter(arabic);

    expect(plain(format.date(instant))).toBe('4 نوفمبر 2026');
    expect(plain(format.dateNumeric(instant))).toBe('04/11/2026');
    expect(plain(format.time(instant))).toBe('12:30 ص');
    expect(plain(format.dateTime(instant))).toBe('4 نوفمبر 2026، 12:30 ص');
  });

  it('follows another time zone setting', () => {
    const format = createFormatter({ ...english, timezone: 'UTC' });

    expect(format.dateTime(instant)).toBe('3 Nov 2026, 22:30');
  });

  it('never shifts a date only value a day, in any time zone', () => {
    for (const timezone of ['Africa/Cairo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const format = createFormatter({ ...english, timezone });
      expect(format.dateOnly('2026-11-03')).toBe('3 Nov 2026');
    }
    expect(plain(createFormatter(arabic).dateOnly('2026-11-03'))).toBe('3 نوفمبر 2026');
  });

  it('gives the calendar date in the install time zone, Western digits in any language', () => {
    // 22:30 UTC on 3 November is already 4 November in Cairo (UTC+2).
    const late = '2026-11-03T22:30:00Z';
    expect(createFormatter(english).calendarDate(late)).toBe('2026-11-04');
    expect(createFormatter(arabic).calendarDate(late)).toBe('2026-11-04');
    expect(createFormatter({ ...english, timezone: undefined }).calendarDate(late)).toBeNull();
  });

  it('returns the raw value for input that is not a date, without marking an error', () => {
    const format = createFormatter(english);

    expect(format.date('not a date')).toBe('not a date');
    expect(format.dateOnly('2026-13-45')).toBe('2026-13-45');
    expect(format.dateOnly('yesterday')).toBe('yesterday');
    expect(format.failed).toBe(false);
  });

  it('returns the raw instant and a loading status until the time zone is known', () => {
    const format = createFormatter({ language: 'en' });

    expect(format.dateTime(instant)).toBe(instant);
  });

  it('leaves the clock to the language when it names none (a client language)', () => {
    const format = createFormatter({ language: 'fr', intl: 'fr-FR', ...settings });

    expect(format.time(instant)).toBe('00:30');
  });
});

describe('failures (AC-8)', () => {
  it('turns an Intl failure into the raw value and a failed flag instead of crashing', () => {
    const format = createFormatter({ ...english, currency: 'not-a-currency' });

    expect(format.failed).toBe(false);
    expect(format.money('10', 2)).toBe('10');
    expect(format.failed).toBe(true);
  });

  it('turns a forced Intl error in any formatter into the raw value', () => {
    const format = createFormatter(english);
    const broken = vi.spyOn(Intl, 'NumberFormat').mockImplementation(() => {
      throw new RangeError('forced');
    });

    expect(format.number(5)).toBe('5');
    expect(format.failed).toBe(true);
    broken.mockRestore();
  });
});

describe('money is EGP (AC-19)', () => {
  it('formats "1234.5" with two digits from the currency setting, in both languages', () => {
    expect(plain(createFormatter({ currency: 'EGP', language: 'ar' }).money('1234.5', 2))).toBe(
      '1,234.50 ج.م.',
    );
    expect(plain(createFormatter({ currency: 'EGP', language: 'en' }).money('1234.5', 2))).toBe(
      'EGP 1,234.50',
    );
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects unknown or empty ones without throwing', () => {
    expect(isValidTimeZone('Africa/Cairo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('calendarDate matches the api localDate (en-CA)', () => {
  it('gives the same YYYY-MM-DD as Intl en-CA on Cairo transition instants', () => {
    const f = createFormatter({ language: 'en', timezone: 'Africa/Cairo' });
    const ar = createFormatter({ language: 'ar', timezone: 'Africa/Cairo' });
    const cases: [string, string][] = [
      ['2026-04-23T22:00:00Z', '2026-04-24'],
      ['2026-04-23T21:59:59Z', '2026-04-23'],
      ['2026-10-29T20:30:00Z', '2026-10-29'],
      ['2026-10-29T21:59:59Z', '2026-10-29'],
      ['2026-10-29T22:00:00Z', '2026-10-30'],
    ];
    for (const [instant, day] of cases) {
      const old = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(instant));
      expect(old).toBe(day);
      expect(f.calendarDate(instant)).toBe(day);
      expect(ar.calendarDate(instant)).toBe(day);
    }
  });
});
