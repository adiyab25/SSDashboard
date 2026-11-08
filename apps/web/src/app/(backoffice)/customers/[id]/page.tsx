import { Suspense } from 'react';
import { CustomerDetailPage } from '@/customers/customer-detail-page';
import { CustomerDetailSkeleton } from '@/customers/customer-detail-skeleton';

/** One customer. The id is only known at request time, so its reader sits inside Suspense. */
export default function Customer() {
  return (
    <Suspense fallback={<CustomerDetailSkeleton />}>
      <CustomerDetailPage />
    </Suspense>
  );
}
