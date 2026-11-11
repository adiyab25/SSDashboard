'use client';

import type { CustomerFlagView } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { CustomerFlagBadge } from './customer-flag-badge';

/** The flag of a customer: its kind, source, who set it and when, and the note. Nothing when there is no flag. */
export function CustomerFlagSection({ flag }: { flag: CustomerFlagView | null }) {
  const { t } = useTranslation();
  const format = useFormat();
  if (flag === null) return null;
  return (
    <section aria-labelledby="customer-flag-title" className="flex flex-col gap-2">
      <h2 id="customer-flag-title" className="text-base font-semibold">
        {t('customers.profile.flagCard.title')}
      </h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('customers.columns.flag')}</dt>
        <dd>
          <CustomerFlagBadge kind={flag.kind} />
        </dd>
        <dt className="text-muted-foreground">{t('customers.profile.flagCard.source')}</dt>
        <dd>{t(`customers.flagSource.${flag.source}`)}</dd>
        {flag.setByName && (
          <>
            <dt className="text-muted-foreground">{t('customers.profile.flagCard.setBy')}</dt>
            <dd>
              <bdi dir="auto">{flag.setByName}</bdi>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t('customers.profile.flagCard.setOn')}</dt>
        <dd>{format.dateTime(flag.setAt)}</dd>
        {flag.note && (
          <>
            <dt className="text-muted-foreground">{t('customers.profile.flagCard.note')}</dt>
            <dd className="min-w-0 break-words">
              <bdi dir="auto">{flag.note}</bdi>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
