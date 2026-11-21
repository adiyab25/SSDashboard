'use client';

import type { OrderListItem } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * The stock out lines under an order number in the list (spec 0013, AC-27 g): "Left stock:
 * Shopify fulfillment, 14 Nov 2026, 14:05" once a source asked for it, and "Awaiting restock: 2,
 * since ..." while pieces are expected back. Draws nothing for an order that has neither.
 */
export function OrderStockOutNote({ order }: { order: OrderListItem }) {
  const { t } = useTranslation();
  const format = useFormat();
  const awaiting = order.awaitingRestockQuantity ?? 0;
  const left = order.stockOutSource && order.stockOutRequestedAt;
  if (!left && awaiting === 0) return null;
  return (
    <span className="flex flex-col text-xs text-muted-foreground">
      {left && order.stockOutSource && order.stockOutRequestedAt && (
        <span>
          {t('orders.stockOut.left', {
            source: t(`orders.stockOut.sources.${order.stockOutSource}`),
            time: format.dateTime(order.stockOutRequestedAt),
          })}
        </span>
      )}
      {awaiting > 0 && (
        <span>
          {t('orders.stockOut.listAwaiting', {
            quantity: format.quantity(awaiting),
            since: order.awaitingRestockSince ? format.dateTime(order.awaitingRestockSince) : '',
          })}
        </span>
      )}
    </span>
  );
}
