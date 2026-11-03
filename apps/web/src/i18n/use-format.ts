'use client';

import { useMemo } from 'react';
import { createFormat, type Format } from './format';
import { useLanguage } from './language-provider';

/**
 * The formatters for the active language and the install's currency and time zone.
 * `status` is `'loading'` until `/api/config` answers and `'error'` if it cannot;
 * `number`, `quantity`, and `percent` work before that, the rest return the raw value.
 */
export function useFormat(): Format {
  const { info, config, configStatus } = useLanguage();
  const { intl, hour12 } = info;
  const currency = config?.currency;
  const timezone = config?.timezone;

  return useMemo(
    () => createFormat({ intl, hour12, currency, timezone }, configStatus),
    [intl, hour12, currency, timezone, configStatus],
  );
}
