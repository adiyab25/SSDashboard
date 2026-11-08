import { Suspense } from 'react';
import { OrdersPage } from '@/orders/orders-page';

/** The order list. It reads a customer id from the address, so its reader sits inside Suspense. */
export default function Orders() {
  return (
    <Suspense fallback={null}>
      <OrdersPage />
    </Suspense>
  );
}
