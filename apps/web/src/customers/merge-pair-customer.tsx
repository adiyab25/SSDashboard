'use client';

import type { CustomerBrief } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { CustomerFlagBadge } from './customer-flag-badge';

/** One customer of a suggested pair: the name linking to the profile, the flag, and the primary phone. */
export function MergePairCustomer({ customer }: { customer: CustomerBrief }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link
          href={`/customers/${customer.id}`}
          className="rounded-chip font-medium underline-offset-4 hover:underline focus-ring"
        >
          <bdi dir="auto">{customer.name ?? t('customers.unnamed')}</bdi>
        </Link>
        <CustomerFlagBadge kind={customer.flagKind} />
      </span>
      {customer.primaryPhone && <LtrText>{customer.primaryPhone}</LtrText>}
    </div>
  );
}
