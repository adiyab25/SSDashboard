'use client';

import type { CustomerAbsorbedMerge } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/** The records merged into this customer: who they were and when. Nothing when none (merge and undo come with milestone 2). */
export function CustomerMergesSection({ merges }: { merges: readonly CustomerAbsorbedMerge[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  if (merges.length === 0) return null;
  return (
    <section aria-labelledby="customer-merges-title" className="flex flex-col gap-2">
      <h2 id="customer-merges-title" className="text-base font-semibold">
        {t('customers.profile.merges.title')}
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {merges.map((merge) => (
          <li key={merge.mergeId} className="flex flex-wrap items-center gap-x-3">
            <span className="font-medium">
              <bdi dir="auto">{merge.other.name ?? t('customers.unnamed')}</bdi>
            </span>
            {merge.other.primaryPhone && <LtrText>{merge.other.primaryPhone}</LtrText>}
            <span className="text-muted-foreground">
              {t('customers.profile.merges.item', { date: format.dateTime(merge.at) })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
