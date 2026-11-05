import { Suspense } from 'react';
import { ReceiptDetailPage, ReceiptDetailSkeleton } from '@/inventory/receipt-detail';

// The receipt id is only known at request time, so its reader sits inside Suspense.
export default function StockReceipt() {
  return (
    <Suspense fallback={<ReceiptDetailSkeleton />}>
      <ReceiptDetailPage />
    </Suspense>
  );
}
