import { Suspense } from 'react';
import { SkuDetailPage, SkuDetailSkeleton } from '@/catalog/sku-detail';

// The SKU id is only known at request time, so its reader sits inside Suspense.
export default function Sku() {
  return (
    <Suspense fallback={<SkuDetailSkeleton />}>
      <SkuDetailPage />
    </Suspense>
  );
}
