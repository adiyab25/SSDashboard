'use client';

import type { CustomerTimelineFlagEntry } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { CustomerFlagBadge } from './customer-flag-badge';

/** The body of a flag entry on the customer timeline (spec 0014, AC-14): the kind, its source, who set it, and the note. */
export function TimelineFlagEntry({ entry }: { entry: CustomerTimelineFlagEntry }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2">
        <CustomerFlagBadge kind={entry.flagKind} />
        <span className="text-muted-foreground">{t(`customers.flagSource.${entry.source}`)}</span>
        {entry.setByName && (
          <span className="text-muted-foreground">
            {t('customers.profile.timeline.by')} <bdi dir="auto">{entry.setByName}</bdi>
          </span>
        )}
      </p>
      {entry.note && (
        <p className="min-w-0 break-words">
          <bdi dir="auto">{entry.note}</bdi>
        </p>
      )}
    </>
  );
}
