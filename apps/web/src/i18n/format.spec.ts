import { describe, expect, it, vi } from 'vitest';
import { createFormat, type FormatContext } from './format';

/** Drops the invisible direction marks and turns no break spaces into spaces, for comparing. */
const plain = (text: string) =>
  text.replace(/[\u200e\u200f\u061c]/g, '').replace(/\u00a0/g, String.fromCharCode(32));

const settings = { currency: 'EGP', timezone: 'Africa/Cairo' };
const english: FormatContext = { intl: 'en-GB', hour12: false, ...settings };
const arabic: FormatContext = { intl: 'ar-EG', hour12: true, ...settings };

describe('numbers (AC-8)', () => {
  it('groups digits and keeps up to three decimals, in Western digits', () => {
    expect(createFormat(english).number('1234.5')).toBe('1,234.5');
    expect(plain(createFormat(arabic).number('1234.5'))).toBe('1,234.5');
  });

  it('formats quantities as whole numbers', () => {
    expect(createFormat(english).quantity(12000)).toBe('12,000');
    expect(plain(createFormat(arabic).quantity(12000))).toBe('12,000');
  });

  it('formats a percent from a decimal string', () => {
    expect(createFormat(english).percent('14.00')).toBe('14%');
    expect(plain(createFormat(arabic).percent('14.00'))).toBe('14%');
  });

  it('works before settings load', () => {
    const format = createFormat({ intl: 'en-GB' }, 'loading');

    expect(format.number(1234.5)).toBe('1,234.5');
    expect(format.quantity(3)).toBe('3');
    expect(format.percent('7')).toBe('7%');
    expect(format.status).toBe('loading');
  });
});

describe('money', () => {
  it('uses the currency setting with the language style', () => {
    expect(plain(createFormat(english).money('1234.5', 2))).toBe('EGP 1,234.50');
    expect(plain(createFormat(arabic).money('1234.5', 2))).toBe('1,234.50 ج.م.');
  });

  it('keeps all four decimals of a unit cost, never rounding through a float', () => {
    expect(plain(createFormat(english).money('12.3456', 4))).toBe('EGP 12.3456');
    expect(plain(createFormat(english).money('0.1000', 4))).toBe('EGP 0.1000');
    // More digits than a double holds exactly.
    expect(plain(createFormat(english).money('9007199254740993.01', 2))).toBe(
      'EGP 9,007,199,254,740,993.01',
    );
  });

  it('rounds half away from zero', () => {
    expect(plain(createFormat(english).money('0.125', 2))).toBe('EGP 0.13');
  });

  it('returns the raw value and a loading status until the currency is known', () => {
    const format = createFormat({ intl: 'en-GB', timezone: 'Africa/Cairo' }, 'loading');

    expect(format.money('1234.50', 2)).toBe('1234.50');
    expect(format.status).toBe('loading');
  });
});

describe('dates and times (AC-8)', () => {
  // 22:30 UTC on 3 November is 00:30 on 4 November in Cairo (UTC+2).
  const instant = '2026-11-03T22:30:00Z';

  it('shows an instant in the install time zone, day first', () => {
    const format = createFormat(english);

    expect(format.date(instant)).toBe('4 Nov 2026');
    expect(format.dateNumeric(instant)).toBe('04/11/2026');
    expect(format.time(instant)).toBe('00:30');
    expect(format.dateTime(instant)).toBe('4 Nov 2026, 00:30');
  });

  it('shows the same instant in the install time zone for every user, whatever the language', () => {
    const format = createFormat(arabic);

    expect(plain(format.date(instant))).toBe('4 نوفمبر 2026');
    expect(plain(format.dateNumeric(instant))).toBe('04/11/2026');
    expect(plain(format.time(instant))).toBe('12:30 ص');
    expect(plain(format.dateTime(instant))).toBe('4 نوفمبر 2026، 12:30 ص');
  });

  it('follows another time zone setting', () => {
    const format = createFormat({ ...english, timezone: 'UTC' });

    expect(format.dateTime(instant)).toBe('3 Nov 2026, 22:30');
  });

  it('never shifts a date only value a day, in any time zone', () => {
    for (const timezone of ['Africa/Cairo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const format = createFormat({ ...english, timezone });
      expect(format.dateOnly('2026-11-03')).toBe('3 Nov 2026');
    }
    expect(plain(createFormat(arabic).dateOnly('2026-11-03'))).toBe('3 نوفمبر 2026');
  });

  it('returns the raw value for input that is not a date, without marking an error', () => {
    const format = createFormat(english);

    expect(format.date('not a date')).toBe('not a date');
    expect(format.dateOnly('2026-13-45')).toBe('2026-13-45');
    expect(format.dateOnly('yesterday')).toBe('yesterday');
    expect(format.status).toBe('ready');
  });

  it('returns the raw instant and a loading status until the time zone is known', () => {
    const format = createFormat({ intl: 'en-GB' }, 'loading');

    expect(format.dateTime(instant)).toBe(instant);
    expect(format.status).toBe('loading');
  });

  it('leaves the clock to the language when it names none (a client language)', () => {
    const format = createFormat({ intl: 'fr-FR', ...settings });

    expect(format.time(instant)).toBe('00:30');
  });
});

describe('status (AC-8)', () => {
  it('is ready when config answered with both settings', () => {
    expect(createFormat(english, 'ready').status).toBe('ready');
  });

  it('is error when config failed', () => {
    expect(createFormat({ intl: 'en-GB' }, 'error').status).toBe('error');
  });

  it('is error when config answered without a currency or time zone', () => {
    expect(createFormat({ intl: 'en-GB', timezone: 'Africa/Cairo' }, 'ready').status).toBe('error');
  });

  it('turns an Intl failure into an error status instead of crashing', () => {
    const format = createFormat({ ...english, currency: 'not-a-currency' });

    expect(format.money('10', 2)).toBe('10');
    expect(format.status).toBe('error');
  });

  it('turns a forced Intl error in any formatter into the raw value', () => {
    const format = createFormat(english);
    const broken = vi.spyOn(Intl, 'NumberFormat').mockImplementation(() => {
      throw new RangeError('forced');
    });

    expect(format.number(5)).toBe('5');
    expect(format.status).toBe('error');
    broken.mockRestore();
  });
});
