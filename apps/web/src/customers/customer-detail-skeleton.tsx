'use client';

import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useTranslation } from 'react-i18next';

/** Placeholder with the page title while one customer loads. */
export function CustomerDetailSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('customers.profile.title')}</h1>
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
