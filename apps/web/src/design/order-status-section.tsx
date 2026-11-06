'use client';

import { ConfirmationQueueSample } from './confirmation-queue-sample';
import { OrderRowsSample } from './order-rows-sample';

/** Order rows in both reading directions and the confirmation queue card, built from the status components. */
export function OrderStatusSection() {
  return (
    <div className="flex flex-col gap-6">
      <OrderRowsSample dir="ltr" />
      <OrderRowsSample dir="rtl" />
      <ConfirmationQueueSample />
    </div>
  );
}
