'use client';

import type { ModuleStateView } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { InfoIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { REASON_KEYS } from './module-reason-text';

/**
 * The notice above a page whose module or capability is `read_only` or `limited` (spec 0009,
 * AC-9): read only names the date it stopped (when known) and says to ask a person who manages
 * settings; limited says only records from before its date can be finished. Draws nothing for
 * `on` or `off` (an off page shows `ModuleNotAvailableState` instead). The dates go through
 * `useFormat()`, never `toLocale*`.
 */
export function ModuleNotice({ view }: { view: ModuleStateView }) {
  const { t } = useTranslation();
  const format = useFormat();

  let sentence: string;
  if (view.state === 'read_only') {
    sentence =
      view.since === null
        ? t('shell.modules.readOnlyNoDate')
        : t('shell.modules.readOnly', { date: format.dateTime(view.since) });
  } else if (view.state === 'limited') {
    sentence =
      view.before === null
        ? t('shell.modules.limitedNoDate')
        : t('shell.modules.limited', { date: format.dateTime(view.before) });
  } else {
    return null;
  }

  return (
    <section aria-label={t('shell.modules.noticeLabel')} className="mb-4">
      <Alert>
        <InfoIcon aria-hidden />
        <AlertDescription>
          {sentence}
          {view.reason && ` ${t(REASON_KEYS[view.reason])}`}
        </AlertDescription>
      </Alert>
    </section>
  );
}
