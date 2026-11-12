'use client';

import { createFormatter, type Formatter } from '@ssdashboard/i18n';
import { useMemo, useSyncExternalStore } from 'react';
import { useLanguage, type ConfigStatus } from './language-provider';

/** `loading` and `error` mean a setting is missing or an `Intl` call failed. */
export type FormatStatus = 'ready' | 'loading' | 'error';

/** The shared formatters plus a `status` that says why money and date output is the raw value. */
export interface Format extends Omit<Formatter, 'failed'> {
  /** `'ready'`, or why money and date output is the raw value. Reads live. */
  readonly status: FormatStatus;
}

const noSubscribe = () => () => {};

/**
 * False while this component renders on the server or hydrates, true from then on. React answers
 * every hydration render with the server value, however late a streamed part of the page hydrates.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/**
 * The formatters for the active language and the install's currency and time zone.
 * `status` is `'loading'` until `/api/config` answers and `'error'` if it cannot;
 * `number`, `quantity`, and `percent` work before that, the rest return the raw value.
 * While a component hydrates the settings count as not loaded yet, as they were on the server:
 * a page part that streams in behind the session check can hydrate after `/api/config` answered,
 * and formatted money there would not match the server's raw value. It must never format with
 * the settings during hydration.
 */
export function useFormat(): Format {
  const { language, info, config: loadedConfig, configStatus: loadedStatus } = useLanguage();
  const hydrated = useHydrated();
  const config = hydrated ? loadedConfig : null;
  const configStatus: ConfigStatus = hydrated ? loadedStatus : 'loading';
  const { intl, hour12 } = info;
  const currency = config?.currency;
  const timezone = config?.timezone;

  return useMemo(() => {
    const formatter = createFormatter({ language, intl, hour12, currency, timezone });
    return {
      number: formatter.number,
      quantity: formatter.quantity,
      percent: formatter.percent,
      money: formatter.money,
      date: formatter.date,
      dateNumeric: formatter.dateNumeric,
      dateOnly: formatter.dateOnly,
      time: formatter.time,
      dateTime: formatter.dateTime,
      calendarDate: formatter.calendarDate,
      get status(): FormatStatus {
        if (formatter.failed) return 'error';
        if (configStatus === 'loading') return 'loading';
        return configStatus === 'ready' && currency && timezone ? 'ready' : 'error';
      },
    };
  }, [language, intl, hour12, currency, timezone, configStatus]);
}
