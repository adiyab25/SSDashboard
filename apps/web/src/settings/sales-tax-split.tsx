'use client';

import { Money, TaxRateString } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/** The net amount the worked example starts from, so every rate gives round, readable figures. */
const EXAMPLE_NET = '1000.00';

/**
 * The worked split in the `sales_tax_rate` change dialog (spec 0013, Configuration required): what
 * the typed rate does to a price, following `prices_include_vat`. Prices that include VAT: a price
 * of 1,140 becomes 1,000 net and 140 VAT at 14%. Prices that do not: a price of 1,000 becomes
 * 1,140 with 140 VAT. The figures are computed for the typed rate with the contract's `Money`
 * (exact, half away from zero) and drawn through `useFormat()`; a rate that is not a valid 0 to 100
 * percent says so instead of guessing. It only explains: the api's schema still decides the value.
 */
export function SalesTaxSplit({ rate, includesVat }: { rate: string; includesVat: boolean }) {
  const { t } = useTranslation();
  const format = useFormat();
  const typed = rate.trim();
  const valid = TaxRateString.safeParse(typed).success && Number(typed) <= 100;

  let body: string;
  if (!valid) {
    body = t('settings.dialog.taxSplit.invalid');
  } else {
    // The rate in hundredths of a percent, so the share is exact: net x rate / 10,000.
    const hundredths = Money.of(typed).cents;
    const net = Money.of(EXAMPLE_NET);
    const vat = net.share(hundredths, 10_000n);
    const withVat = net.plus(vat);
    body = includesVat
      ? t('settings.dialog.taxSplit.included', {
          price: format.money(withVat.toString(), 2),
          net: format.money(net.toString(), 2),
          vat: format.money(vat.toString(), 2),
        })
      : t('settings.dialog.taxSplit.excluded', {
          price: format.money(net.toString(), 2),
          total: format.money(withVat.toString(), 2),
          vat: format.money(vat.toString(), 2),
        });
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
      <p className="font-medium">{t('settings.dialog.taxSplit.title')}</p>
      <p aria-live="polite" className="text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
