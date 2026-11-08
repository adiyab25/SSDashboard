'use client';

import type { OrderListItem } from '@ssdashboard/contracts';
import {
  AlertTriangleIcon,
  GiftIcon,
  PackageXIcon,
  PhoneOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The small flags under an order number in the list (spec 0013, AC-4, DESIGN.md "Chips in a row"):
 * an edit not synced (hold), a short line, a gift, an exchange replacement, a reopened order, and
 * a phone that needs fixing. Each is an icon and a word, so color is never the only carrier; the
 * row's own chips stay at fulfillment and cash.
 */
export function OrderFlags({ order }: { order: OrderListItem }) {
  const { t } = useTranslation();
  const flags: { id: string; label: string; icon: typeof GiftIcon }[] = [];
  if (order.hold)
    flags.push({ id: 'hold', label: t('orders.flags.hold'), icon: AlertTriangleIcon });
  if (order.short) flags.push({ id: 'short', label: t('orders.flags.short'), icon: PackageXIcon });
  if (order.type === 'gifted') {
    flags.push({
      id: 'gifted',
      label: order.giftReasonCode
        ? t('orders.flags.giftedFor', { reason: t(`orders.reasons.gift.${order.giftReasonCode}`) })
        : t('orders.type.gifted'),
      icon: GiftIcon,
    });
  }
  if (order.type === 'exchange_replacement') {
    flags.push({
      id: 'replacement',
      label: t('orders.type.exchange_replacement'),
      icon: RefreshCwIcon,
    });
  }
  if (order.reopened) {
    flags.push({ id: 'reopened', label: t('orders.flags.reopened'), icon: RotateCcwIcon });
  }
  if (order.phoneNeedsFix) {
    flags.push({ id: 'phone', label: t('orders.flags.phoneNeedsFix'), icon: PhoneOffIcon });
  }
  if (flags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {flags.map(({ id, label, icon: Icon }) => (
        <li key={id} className="inline-flex items-center gap-1">
          <Icon aria-hidden className="size-3" />
          {label}
        </li>
      ))}
    </ul>
  );
}
