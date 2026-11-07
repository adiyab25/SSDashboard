'use client';

import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useTranslation } from 'react-i18next';

/**
 * Placeholder with the page title while the new receipt page learns whether the person may
 * receive stock. The form itself is not mounted yet, so nothing is asked of the api.
 */
export function ReceiptFormSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('inventory.receipt.newTitle')}</h1>
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
