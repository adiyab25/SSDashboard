'use client';

import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useTranslation } from 'react-i18next';

/** Placeholder with the page title while the new order form (or the person's access) loads. */
export function NewOrderSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('orders.new.title')}</h1>
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
