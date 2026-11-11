import { Suspense } from 'react';
import { CustomerDetailSkeleton } from '@/customers/customer-detail-skeleton';
import { MergePage } from '@/customers/merge-page';

/** The merge screen. Its query string (the two ids) is only known at request time, so its reader sits inside Suspense. */
export default function MergeCustomers() {
  return (
    <Suspense fallback={<CustomerDetailSkeleton />}>
      <MergePage />
    </Suspense>
  );
}
