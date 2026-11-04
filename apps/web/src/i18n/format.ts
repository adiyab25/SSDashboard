// The only place that builds `Intl` formatters (lint bans them everywhere else), so every
// figure and date looks the same on every screen and matches exports. Digits are always
// Western (0 to 9): every formatter sets `numberingSystem: 'latn'`.

/** What the formatters need: the language's Intl tag and clock, and the install settings. */
export interface FormatContext {
  /** The Intl locale tag of the active language, for example `en-GB`. */
  intl: string;
  /** 12 hour clock. Left out, the language's Intl default decides. */
  hour12?: boolean;
  /** ISO 4217 code from the `currency` setting. Missing until config loads. */
  currency?: string;
  /** IANA name from the `timezone` setting. Missing until config loads. */
  timezone?: string;
}

/** `loading` and `error` mean a setting is missing or an `Intl` call failed. */
export type FormatStatus = 'ready' | 'loading' | 'error';

type Decimal = number | string;

export interface Format {
  /** `'ready'`, or why money and date output is the raw value. Reads live. */
  readonly status: FormatStatus;
  number: (value: Decimal) => string;
  quantity: (value: number) => string;
  percent: (value: Decimal) => string;
  money: (value: string, digits: 2 | 4) => string;
  date: (instant: Date | string | number) => string;
  dateNumeric: (instant: Date | string | number) => string;
  dateOnly: (value: string) => string;
  time: (instant: Date | string | number) => string;
  dateTime: (instant: Date | string | number) => string;
  /**
   * The calendar date of an instant in the install's time zone, as `YYYY-MM-DD` (for date
   * inputs and api fields, not for display). Null until the time zone is known.
   */
  calendarDate: (instant: Date | string | number) => string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The plural forms a language needs (`one`, `few`, ...), from `Intl.PluralRules` and never
 * hand written. Kept here because this is the only module allowed to build `Intl` objects.
 */
export function pluralCategories(intl: string): readonly string[] {
  return new Intl.PluralRules(intl).resolvedOptions().pluralCategories;
}

/** A decimal string goes to `Intl` as a string, so `"12.3456"` never loses precision. */
function numeric(value: Decimal): number | `${number}` {
  return typeof value === 'string' ? (value as `${number}`) : value;
}

function toDate(instant: Date | string | number): Date | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formatters for one language and one set of install settings. Settings the call needs but
 * does not have (`loading`), or an `Intl` failure (`error`), return the raw value instead of
 * a guess, and set `status`, so a screen shows its own loading or error state.
 */
export function createFormat(context: FormatContext, settings: FormatStatus = 'ready'): Format {
  const { intl, hour12, currency, timezone } = context;
  const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
  let failed = false;

  function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(
    key: string,
    make: () => T,
  ): T {
    let found = cache.get(key) as T | undefined;
    if (!found) {
      found = make();
      cache.set(key, found);
    }
    return found;
  }

  /** Runs one formatting call; an `Intl` error becomes the raw value and an error status. */
  function guard(raw: string, run: () => string): string {
    try {
      return run();
    } catch {
      failed = true;
      return raw;
    }
  }

  const numbers = (key: string, options: Intl.NumberFormatOptions) =>
    cached(`n:${key}`, () => new Intl.NumberFormat(intl, { numberingSystem: 'latn', ...options }));

  const clock: Intl.DateTimeFormatOptions =
    hour12 === undefined ? {} : { hourCycle: hour12 ? 'h12' : 'h23' };
  const dayMonthYear: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  };
  const hourMinute: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', ...clock };

  const dates = (key: string, options: Intl.DateTimeFormatOptions, timeZone: string) =>
    cached(
      `d:${key}:${timeZone}`,
      () => new Intl.DateTimeFormat(intl, { numberingSystem: 'latn', timeZone, ...options }),
    );

  /** An instant shown in the install's time zone; the raw value until that is known. */
  function instant(
    key: string,
    options: Intl.DateTimeFormatOptions,
    value: Date | string | number,
  ): string {
    const date = toDate(value);
    const raw = date && value instanceof Date ? date.toISOString() : String(value);
    if (!timezone || !date) return raw;
    return guard(raw, () => dates(key, options, timezone).format(date));
  }

  const format: Format = {
    get status(): FormatStatus {
      if (failed) return 'error';
      if (settings === 'loading') return 'loading';
      return settings === 'ready' && currency && timezone ? 'ready' : 'error';
    },

    number: (value) =>
      guard(String(value), () =>
        numbers('number', { useGrouping: true, maximumFractionDigits: 3 }).format(numeric(value)),
      ),

    quantity: (value) =>
      guard(String(value), () =>
        numbers('quantity', { useGrouping: true, maximumFractionDigits: 0 }).format(value),
      ),

    percent: (value) =>
      guard(String(value), () =>
        numbers('percent', {
          style: 'unit',
          unit: 'percent',
          maximumFractionDigits: 2,
        }).format(numeric(value)),
      ),

    money: (value, digits) => {
      if (!currency) return value;
      return guard(value, () =>
        numbers(`money:${currency}:${digits}`, {
          style: 'currency',
          currency,
          currencyDisplay: 'symbol',
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(numeric(value)),
      );
    },

    date: (value) => instant('date', dayMonthYear, value),

    dateNumeric: (value) =>
      instant('dateNumeric', { day: '2-digit', month: '2-digit', year: 'numeric' }, value),

    // A date without a time is formatted as UTC midnight in UTC, so it never shifts a day.
    dateOnly: (value) =>
      guard(value, () => {
        if (!DATE_ONLY.test(value)) return value;
        const date = toDate(`${value}T00:00:00Z`);
        return date ? dates('dateOnly', dayMonthYear, 'UTC').format(date) : value;
      }),

    time: (value) => instant('time', hourMinute, value),

    dateTime: (value) => instant('dateTime', { ...dayMonthYear, ...hourMinute }, value),

    calendarDate: (value) => {
      const date = toDate(value);
      if (!timezone || !date) return null;
      try {
        const parts = dates(
          'calendar',
          { year: 'numeric', month: '2-digit', day: '2-digit' },
          timezone,
        ).formatToParts(date);
        const part = (type: Intl.DateTimeFormatPartTypes) =>
          parts.find((item) => item.type === type)?.value ?? '';
        return `${part('year')}-${part('month')}-${part('day')}`;
      } catch {
        failed = true;
        return null;
      }
    },
  };

  return format;
}
