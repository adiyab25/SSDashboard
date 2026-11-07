'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { getReceipt, inventoryKeys } from './inventory-api';
import { ReceiptDetailSkeleton } from './receipt-detail-skeleton';
import { ReceiptView } from './receipt-view';

/** One stock receipt: its number, status, details, and lines (spec 0006). */
export function ReceiptDetailView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const query = useQuery({
    queryKey: inventoryKeys.receipt(id),
    queryFn: ({ signal }) => getReceipt(id, signal),
    enabled,
  });

  if (query.isPending) return <ReceiptDetailSkeleton />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('inventory.receiptDetail.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {notFound
              ? t('inventory.receiptDetail.notFound')
              : t('inventory.receiptDetail.loadError')}
            {!notFound && (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                {t('inventory.retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return <ReceiptView receipt={query.data} />;
}
