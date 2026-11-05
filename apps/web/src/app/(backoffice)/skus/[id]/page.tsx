import { Suspense } from 'react';
import { SkuDetailPage } from '@/catalog/sku-detail-page';
import { SkuDetailSkeleton } from '@/catalog/sku-detail-skeleton';

/** One SKU. The id is only known at request time, so its reader sits inside Suspense. */
export default function Sku() {
  return (
    <Suspense fallback={<SkuDetailSkeleton />}>
      <SkuDetailPage />
    </Suspense>
  );
}
