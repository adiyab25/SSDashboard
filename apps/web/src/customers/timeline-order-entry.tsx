'use client';

import type { CustomerTimelineOrderEntry } from '@ssdashboard/contracts';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { CashChip } from '@/orders/cash-chip';
import { FulfillmentChip } from '@/orders/fulfillment-chip';
import { OrderNumber } from '@/orders/order-number';
import { OrderReasonText } from '@/orders/order-reason-text';

/**
 * The body of an order entry on the customer timeline (spec 0014, AC-14): the number with its
 * store as a link to the order page, the parcel and cash states, the total, the payment method,
 * and the refusal reason when the order was refused. Never shows cost: the entry carries none.
 */
export function TimelineOrderEntry({ entry }: { entry: CustomerTimelineOrderEntry }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/orders/${entry.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          <OrderNumber order={entry} />
        </Link>
        <FulfillmentChip state={entry.fulfillmentState} outcome={entry.outcome} />
        <CashChip state={entry.cashState} />
      </p>
      <p className="text-muted-foreground">
        {format.money(entry.totalAmount, 2)}
        {' · '}
        {t(`orders.paymentMethod.${entry.paymentMethod}`)}
      </p>
      {entry.refusedReasonCode && (
        <p className="text-muted-foreground">
          {t('customers.profile.timeline.refusalReasonLabel')}{' '}
          <OrderReasonText code={entry.refusedReasonCode} />
        </p>
      )}
    </>
  );
}
