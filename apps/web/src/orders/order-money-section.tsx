'use client';

import type { OrderMoneyView } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * The money block (spec 0013, AC-5): lines gross, shipping, total, the payment and what was
 * prepaid, credit applied, cash on delivery expected and still due, collected, and remitted.
 * Amounts are end aligned with tabular digits and go through `useFormat()`.
 */
export function OrderMoneySection({ money }: { money: OrderMoneyView }) {
  const { t } = useTranslation();
  const format = useFormat();
  const rows: { id: string; label: string; value: string; strong?: boolean }[] = [
    { id: 'lines', label: t('orders.money.lines'), value: format.money(money.linesGrossAmount, 2) },
    {
      id: 'shipping',
      label: t('orders.money.shipping'),
      value: format.money(money.shippingChargedAmount, 2),
    },
    {
      id: 'shippingTax',
      label: t('orders.money.shippingTax'),
      value: format.money(money.shippingTaxAmount, 2),
    },
    {
      id: 'total',
      label: t('orders.money.total'),
      value: format.money(money.totalAmount, 2),
      strong: true,
    },
    {
      id: 'prepaid',
      label: money.prepaidMethod
        ? t('orders.money.prepaidBy', { method: t(`orders.paymentMethod.${money.prepaidMethod}`) })
        : t('orders.money.prepaid'),
      value: format.money(money.prepaidAmount, 2),
    },
    {
      id: 'credit',
      label: t('orders.money.credit'),
      value: format.money(money.creditAppliedAmount, 2),
    },
    {
      id: 'codExpected',
      label: t('orders.money.codExpected'),
      value: format.money(money.codExpectedAmount, 2),
    },
    {
      id: 'codDue',
      label: t('orders.money.codDue'),
      value: format.money(money.codDueAmount, 2),
      strong: true,
    },
    {
      id: 'collected',
      label: t('orders.money.collected'),
      value: format.money(money.codCollectedAmount, 2),
    },
    {
      id: 'remitted',
      label: t('orders.money.remitted'),
      value: format.money(money.remittedAmount, 2),
    },
  ];
  return (
    <section aria-labelledby="order-money-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="order-money-title" className="text-base font-semibold">
        {t('orders.money.title')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('orders.money.paymentMethod', {
          method: t(`orders.paymentMethod.${money.paymentMethod}`),
        })}
      </p>
      <dl className="grid gap-x-8 gap-y-1 rounded-card gradient-card-edge p-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className={`text-sm tabular-nums ${row.strong ? 'font-semibold' : ''}`}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
