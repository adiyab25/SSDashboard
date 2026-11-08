'use client';

import { NO_STOCK_OUT_SOURCE, type StepFact } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { isolateLtr } from '@/shared/isolate-ltr';

/**
 * The words of an executing step's turn on check (spec 0009, AC-21, AC-25): `precondition` names
 * why a step cannot be switched on yet (the platform's `NO_STOCK_OUT_SOURCE` in the plain words of
 * wave 1 review W9; a feature's code by its own `settings.automations.preconditions.<code>` key
 * once that feature adds one, else a general sentence naming the code), and `fact` writes one fact
 * a passing precondition handed the turn on dialog, with its whole numbers formatted. It never
 * decides whether a step may be switched on: the api answers 409 `STEP_PRECONDITION`.
 */
export function usePreconditionText(): {
  precondition: (code: string) => string;
  fact: (fact: StepFact) => string;
} {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  return {
    precondition: (code) => {
      if (code === NO_STOCK_OUT_SOURCE) {
        return t('settings.automations.preconditions.NO_STOCK_OUT_SOURCE');
      }
      const key = `settings.automations.preconditions.${code}`;
      return i18n.exists(key)
        ? t(key as MessageKey)
        : t('settings.automations.preconditions.generic', { code: isolateLtr(code) });
    },
    fact: ({ label, values }) => {
      const counts = Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name, format.quantity(value)]),
      );
      // A fact's key comes from the api, so it is checked with `exists`; the default value lets
      // i18next take a key and its numbers that the catalog type cannot see ahead of time.
      if (i18n.exists(label)) return t(label, { ...counts, defaultValue: isolateLtr(label) });
      const numbers = Object.entries(counts)
        .map(([name, value]) => `${isolateLtr(name)}: ${value}`)
        .join(t('shell.modules.listSeparator'));
      return `${isolateLtr(label)} (${numbers})`;
    },
  };
}
