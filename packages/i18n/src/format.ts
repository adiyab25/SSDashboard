// The only place that builds `Intl` formatters (lint bans them everywhere else, in the web, the
// api and the worker), so every figure and date looks the same on every screen, in every
// export and in every process. Digits are always Western (0 to 9): every formatter sets
// `numberingSystem: 'latn'`.
import { CORE_LANGUAGES, isCoreLanguage } from './languages.js';

/** What `createFormatter` needs: the language and the install's currency and time zone. */
export interface FormatterOptions {
  /** A language code (`en`, `ar`) or, for a client language, any code with `intl` set. */
  language: string;
  /** ISO 4217 code from the `currency` setting. Missing until settings are known. */
  currency?: string;
  /** IANA name from the `timezone` setting. Missing until settings are known. */
  timezone?: string;
  /** The Intl locale tag. Left out, a core language's tag is used, else `language` itself. */
  intl?: string;
  /** 12 hour clock. Left out, a core language's clock is used, else the Intl tag decides. */
  hour12?: boolean;
}

type Decimal = number | string;
type Instant = Date | string | number;

/** The number, money, date and time formatters for one language and one set of install settings. */
export interface Formatter {
  /** True once an `Intl` call failed and the raw value was returned instead. Reads live. */
  readonly failed: boolean;
  number: (value: Decimal) => string;
  quantity: (value: number) => string;
  percent: (value: Decimal) => string;
  money: (value: string, digits: 2 | 4) => string;
  date: (instant: Instant) => string;
  dateNumeric: (instant: Instant) => string;
  dateOnly: (value: string) => string;
  time: (instant: Instant) => string;
  dateTime: (instant: Instant) => string;
  /**
   * The calendar date of an instant in the install's time zone, as `YYYY-MM-DD` (for date
   * inputs and api fields, not for display). Null until the time zone is known.
   */
  calendarDate: (instant: Instant) => string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A decimal string goes to `Intl` as a string, so `"12.3456"` never loses precision. */
function numeric(value: Decimal): number | `${number}` {
  return typeof value === 'string' ? (value as `${number}`) : value;
}

function toDate(instant: Instant): Date | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formatters for one language and one set of install settings. A setting the call needs but
 * does not have, or an `Intl` failure, returns the raw value instead of a guess; an `Intl`
 * failure also sets `failed`, so a screen can show its own error state. Never builds an
 * `Intl` object per call: they are cached per formatter.
 */
export function createFormatter(options: FormatterOptions): Formatter {
  const { language, currency, timezone } = options;
  const core = isCoreLanguage(language) ? CORE_LANGUAGES[language] : undefined;
  const intl = options.intl ?? core?.intl ?? language;
  const hour12 = options.hour12 ?? core?.hour12;
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
  function instant(key: string, options: Intl.DateTimeFormatOptions, value: Instant): string {
    const date = toDate(value);
    const raw = date && value instanceof Date ? date.toISOString() : String(value);
    if (!timezone || !date) return raw;
    return guard(raw, () => dates(key, options, timezone).format(date));
  }

  const format: Formatter = {
    get failed(): boolean {
      return failed;
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

/**
 * True when `name` is an IANA time zone this runtime knows (`Africa/Cairo`). Used to check the
 * `timezone` setting. Never throws; an empty or unknown name is false.
 */
export function isValidTimeZone(name: string): boolean {
  if (!name) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
