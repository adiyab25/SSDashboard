import { Suspense } from 'react';
import { OrderDetailPage } from '@/orders/order-detail-page';
import { OrderDetailSkeleton } from '@/orders/order-detail-skeleton';

/** One order. The id is only known at request time, so its reader sits inside Suspense. */
export default function Order() {
  return (
    <Suspense fallback={<OrderDetailSkeleton />}>
      <OrderDetailPage />
    </Suspense>
  );
}
