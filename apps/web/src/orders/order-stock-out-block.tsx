'use client';

import type { OrderDetail } from '@ssdashboard/contracts';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { OrderAwaitingLine } from './order-awaiting-line';

/** The reversal reasons the catalogs name; any other is shown as its code. */
const KNOWN_REVERSALS = ['channel_fulfillment_cancelled', 'order_cancelled_before_pickup'] as const;

/** True for a reversal reason the catalogs name. */
function isKnownReversal(value: string): value is (typeof KNOWN_REVERSALS)[number] {
  return (KNOWN_REVERSALS as readonly string[]).includes(value);
}

/**
 * The stock out block of the order page (spec 0013, AC-5, AC-27 g): which source took the order's
 * pieces out of stock and when ("Left stock: Shopify fulfillment, 14 Nov 2026, 14:05"), when the
 * posting was booked, every reversal of an earlier generation, and each line with pieces expected
 * back with its two actions. Draws nothing for an order the api sent no stock out view for and
 * that has nothing awaiting.
 */
export function OrderStockOutBlock({ order }: { order: OrderDetail }) {
  const { t } = useTranslation();
  const format = useFormat();
  const heading = useRef<HTMLHeadingElement>(null);
  const stockOut = order.stockOut;
  const awaitingLines = order.lines.filter((line) => (line.awaitingRestockQuantity ?? 0) > 0);
  if (!stockOut && awaitingLines.length === 0) return null;

  return (
    <section aria-labelledby="order-stock-out-title" className="flex min-w-0 flex-col gap-3">
      <h2
        id="order-stock-out-title"
        ref={heading}
        tabIndex={-1}
        className="rounded-chip text-base font-semibold outline-none focus-ring"
      >
        {t('orders.stockOut.title')}
      </h2>
      <div className="flex flex-col gap-3 rounded-card gradient-card-edge p-4">
        {stockOut && (
          <div className="flex flex-col gap-1 text-sm">
            <p>
              {stockOut.source && stockOut.requestedAt
                ? t('orders.stockOut.left', {
                    source: t(`orders.stockOut.sources.${stockOut.source}`),
                    time: format.dateTime(stockOut.requestedAt),
                  })
                : t('orders.stockOut.notLeft')}
            </p>
            {stockOut.requestedAt && (
              <p className="text-muted-foreground">
                {stockOut.postedAt
                  ? t('orders.stockOut.posted', { time: format.dateTime(stockOut.postedAt) })
                  : t('orders.stockOut.notPosted')}
              </p>
            )}
            {stockOut.reversals.length > 0 && (
              <ul
                aria-label={t('orders.stockOut.reversalsLabel')}
                className="flex flex-col gap-0.5"
              >
                {stockOut.reversals.map((reversal) => (
                  <li key={reversal.generation}>
                    {t('orders.stockOut.reversal', {
                      reason: isKnownReversal(reversal.reasonCode)
                        ? t(`orders.stockOut.reversalReasons.${reversal.reasonCode}`)
                        : reversal.reasonCode,
                      time: format.dateTime(reversal.reversedAt),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t('orders.stockOut.awaitingTitle')}</h3>
          {awaitingLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('orders.stockOut.awaitingNone')}</p>
          ) : (
            <ul
              aria-label={t('orders.stockOut.linesLabel')}
              className="flex flex-col divide-y divide-border"
            >
              {awaitingLines.map((line) => (
                <OrderAwaitingLine
                  key={line.id}
                  order={order}
                  line={line}
                  onSettled={() => heading.current?.focus()}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
