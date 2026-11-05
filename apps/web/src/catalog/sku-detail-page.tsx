'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { getSku, inventoryKeys } from '@/inventory/inventory-api';
import { SkuDetailSkeleton } from './sku-detail-skeleton';
import { SkuView } from './sku-view';

/** One SKU: its stock per location and its movement history (spec 0006, AC-10). */
export function SkuDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const query = useQuery({
    queryKey: inventoryKeys.sku(id),
    queryFn: ({ signal }) => getSku(id, signal),
  });

  if (query.isPending) return <SkuDetailSkeleton />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('inventory.skus.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {notFound ? t('inventory.skuDetail.notFound') : t('inventory.skuDetail.loadError')}
            {!notFound && (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                {t('inventory.retry')}
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/skus">{t('inventory.skuDetail.back')}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return <SkuView sku={query.data} />;
}
