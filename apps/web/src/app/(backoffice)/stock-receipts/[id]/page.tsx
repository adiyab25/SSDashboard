import { Suspense } from 'react';
import { ReceiptDetailPage } from '@/inventory/receipt-detail-page';
import { ReceiptDetailSkeleton } from '@/inventory/receipt-detail-skeleton';

/** One stock receipt. The id is only known at request time, so its reader sits inside Suspense. */
export default function StockReceipt() {
  return (
    <Suspense fallback={<ReceiptDetailSkeleton />}>
      <ReceiptDetailPage />
    </Suspense>
  );
}
