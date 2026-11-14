'use client';

import type { SkuDetail } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { FromChannelBadge } from './from-channel-badge';

/**
 * The SKU page's read only block about what the SKU is (spec 0012, AC-4): its style (code and
 * name, linked to its `/styles/[id]` page, AC-8), season ("No season" when none), product
 * group, option values, and barcodes. While the style is linked to a sales channel the name, the
 * option values, and the channel barcode carry "From Shopify" (AC-15). It must never edit
 * anything.
 */
export function SkuStyleBlock({ sku }: { sku: SkuDetail }) {
  const { t } = useTranslation();
  const text = useLocalizedText();

  return (
    <section
      aria-labelledby="sku-style-title"
      className="flex flex-col gap-3 rounded-lg border p-4 text-sm"
    >
      <h2 id="sku-style-title" className="font-medium">
        {t('inventory.skuDetail.aboutTitle')}
      </h2>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.styleTitle')}</dt>
          <dd className="flex flex-wrap items-center gap-2 font-medium">
            <Link
              href={`/styles/${sku.style.id}`}
              className="rounded-sm underline-offset-4 hover:underline focus-ring"
            >
              <LtrText>{sku.style.code}</LtrText> {text(sku.style.name, sku.style.code)}
            </Link>
            {sku.channelNameLanguage && <FromChannelBadge />}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.season')}</dt>
          <dd className="font-medium">
            {sku.season ? text(sku.season.name, sku.season.code) : t('inventory.skus.noSeason')}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.group')}</dt>
          <dd className="font-medium">{text(sku.productGroup.name, sku.productGroup.code)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.options')}</dt>
          <dd className="flex flex-wrap items-center gap-2 font-medium">
            <span>
              {sku.options.length === 0
                ? t('inventory.skuDetail.noOptions')
                : sku.options
                    .map((option) =>
                      t('inventory.skuDetail.optionPair', {
                        name: text(option.name, ''),
                        value: text(option.value, ''),
                      }),
                    )
                    .join(t('shell.modules.listSeparator'))}
            </span>
            {sku.channelLinked && sku.options.length > 0 && <FromChannelBadge />}
          </dd>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.barcodes')}</dt>
          <dd>
            {sku.barcodes.length === 0 ? (
              <span className="font-medium">{t('inventory.skuDetail.noBarcodes')}</span>
            ) : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {sku.barcodes.map((barcode) => (
                  <li key={barcode.id} className="flex items-center gap-2">
                    <LtrText>{barcode.code}</LtrText>
                    {barcode.fromChannel && <FromChannelBadge />}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
