'use client';

import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import type { SettingWords } from './setting-value';

/**
 * The words and formatters a setting's value is written with, in the active language (see
 * `displayValue`): catalog text for yes, no, and not set, and `useFormat()` for numbers and dates.
 */
export function useSettingWords(): SettingWords {
  const { t } = useTranslation();
  const format = useFormat();
  return {
    yes: t('settings.values.yes'),
    no: t('settings.values.no'),
    notSet: t('settings.values.notSet'),
    hour: (hour) => t('settings.values.hour', { hour }),
    number: format.quantity,
    date: format.dateOnly,
  };
}
