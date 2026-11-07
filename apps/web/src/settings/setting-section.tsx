'use client';

import type { SettingEntryView } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from './setting-row';

/** Props of `SettingSection`. */
interface SettingSectionProps {
  titleKey: MessageKey;
  entries: readonly SettingEntryView[];
  onChange: (entry: SettingEntryView) => void;
}

/** One settings section (spec 0009, AC-25): an `h2` and the bordered list of its entries. */
export function SettingSection({ titleKey, entries, onChange }: SettingSectionProps) {
  const { t } = useTranslation();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t(titleKey)}
      </h2>
      <ul className="divide-y rounded-lg border">
        {entries.map((entry) => (
          <SettingRow key={entry.key} entry={entry} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}
