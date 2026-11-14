'use client';

import type { StyleDetail, StyleVariant } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { CollapsingTable } from '@ssdashboard/ui/dashboard/collapsing-table';
import { BarcodeIcon, CoinsIcon, PencilIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { FromChannelBadge } from '../from-channel-badge';
import { AddVariantDialog } from './add-variant-dialog';
import { RecordCostDialog } from './record-cost-dialog';
import { StyleCostHistory } from './style-cost-history';
import { VariantCostCell } from './variant-cost-cell';
import { StyleCodeDialog } from './style-code-dialog';
import { StyleEditDialog } from './style-edit-dialog';
import { VariantBarcodesDialog } from './variant-barcodes-dialog';

/** The dialog open on the page, if any. */
type Open =
  | { kind: 'edit' }
  | { kind: 'code' }
  | { kind: 'add' }
  | { kind: 'cost' }
  | { kind: 'barcodes'; id: string };

/**
 * One loaded style (spec 0012, AC-8 to AC-10): code, name, season, group, tags, and description,
 * its options with their roles and values, and its SKUs with options, price, barcodes, and
 * status. `catalog.edit` adds Edit, Add SKU, and the barcode buttons; `catalog.manage` adds
 * Change code. `cost.view` adds each SKU's cost in force and the cost history (AC-12, AC-13),
 * and with `catalog.edit` Record cost; without `cost.view` no cost is drawn or asked for.
 * Without them the page is read only (the api enforces it too).
 */
export function StyleView({
  style,
  reload,
}: {
  style: StyleDetail;
  /** Reads the style again; undefined when that failed. */
  reload: () => Promise<StyleDetail | undefined>;
}) {
  const { t } = useTranslation();
  const access = useAccess();
  const canEdit = access.can('catalog.edit');
  const canManage = access.can('catalog.manage');
  const canSeeCost = access.can('cost.view');
  const format = useFormat();
  const text = useLocalizedText();
  const [open, setOpen] = useState<Open | null>(null);
  const close = () => setOpen(null);
  const barcodesOf =
    open?.kind === 'barcodes' ? style.variants.find((variant) => variant.id === open.id) : null;

  const optionsText = (variant: StyleVariant) =>
    variant.options.length === 0
      ? t('catalog.style.noVariantOptions')
      : variant.options
          .map((option) => text(option.value, ''))
          .join(t('shell.modules.listSeparator'));

  const columns = [
    {
      id: 'sku',
      header: t('catalog.style.columns.sku'),
      title: true,
      cell: (variant: StyleVariant) => (
        <Link
          href={`/skus/${variant.id}`}
          className="rounded-sm font-medium underline-offset-4 hover:underline focus-ring"
        >
          <LtrText>{variant.code}</LtrText>
        </Link>
      ),
    },
    {
      id: 'options',
      header: t('catalog.style.columns.options'),
      cell: optionsText,
    },
    {
      id: 'price',
      header: t('catalog.style.columns.price'),
      align: 'end' as const,
      cell: (variant: StyleVariant) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-2">
          {variant.price === null ? (
            <span className="text-muted-foreground">{t('catalog.style.noPrice')}</span>
          ) : (
            format.money(variant.price, 2)
          )}
          {variant.channelLinked && <FromChannelBadge />}
        </span>
      ),
    },
    ...(canSeeCost
      ? [
          {
            id: 'cost',
            header: t('catalog.style.columns.cost'),
            align: 'end' as const,
            cell: (variant: StyleVariant) => <VariantCostCell cost={variant.cost} />,
          },
        ]
      : []),
    {
      id: 'barcodes',
      header: t('catalog.style.columns.barcodes'),
      cell: (variant: StyleVariant) =>
        variant.barcodes.length === 0 ? (
          <span className="text-muted-foreground">{t('catalog.style.noBarcodes')}</span>
        ) : (
          <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1 sm:justify-start">
            {variant.barcodes.map((barcode) => (
              <li key={barcode.id} className="flex items-center gap-2">
                <LtrText>{barcode.code}</LtrText>
                {barcode.fromChannel && <FromChannelBadge />}
              </li>
            ))}
          </ul>
        ),
    },
    {
      id: 'status',
      header: t('catalog.style.columns.status'),
      cell: (variant: StyleVariant) => (
        <Badge variant={variant.archived ? 'outline' : 'secondary'}>
          {variant.archived ? t('catalog.common.archivedBadge') : t('catalog.common.activeBadge')}
        </Badge>
      ),
    },
    ...(canEdit
      ? [
          {
            id: 'actions',
            header: t('catalog.style.columns.actions'),
            cell: (variant: StyleVariant) => (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t('catalog.style.barcodesLabel', { code: variant.code })}
                onClick={() => setOpen({ kind: 'barcodes', id: variant.id })}
              >
                <BarcodeIcon aria-hidden data-icon="inline-start" />
                {t('catalog.style.barcodesButton')}
              </Button>
            ),
          },
        ]
      : []),
  ];

  const description = style.description ? text(style.description, '') : '';

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">
              <LtrText>{style.code}</LtrText>
            </h1>
            {style.archived && <Badge variant="outline">{t('catalog.common.archivedBadge')}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{text(style.name, style.code)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/styles">{t('catalog.style.back')}</Link>
          </Button>
          {canManage && (
            <Button variant="outline" onClick={() => setOpen({ kind: 'code' })}>
              {t('catalog.style.changeCode')}
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" onClick={() => setOpen({ kind: 'edit' })}>
              <PencilIcon aria-hidden data-icon="inline-start" />
              {t('catalog.style.edit')}
            </Button>
          )}
          {canEdit && canSeeCost && (
            <Button variant="outline" onClick={() => setOpen({ kind: 'cost' })}>
              <CoinsIcon aria-hidden data-icon="inline-start" />
              {t('catalog.style.recordCost')}
            </Button>
          )}
          {canEdit && !style.archived && (
            <Button onClick={() => setOpen({ kind: 'add' })}>
              <PlusIcon aria-hidden data-icon="inline-start" />
              {t('catalog.style.addVariant')}
            </Button>
          )}
        </div>
      </div>

      <section
        aria-labelledby="style-facts-title"
        className="flex flex-col gap-3 rounded-lg border p-4 text-sm"
      >
        <h2 id="style-facts-title" className="font-medium">
          {t('catalog.style.factsTitle')}
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          {style.channelNameLanguage && (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="text-muted-foreground">
                {t(`catalog.channel.nameIn.${style.channelNameLanguage}`)}
              </dt>
              <dd className="flex flex-wrap items-center gap-2 font-medium">
                <span
                  lang={style.channelNameLanguage}
                  dir={style.channelNameLanguage === 'ar' ? 'rtl' : 'ltr'}
                >
                  {style.name[style.channelNameLanguage] ?? ''}
                </span>
                <FromChannelBadge />
              </dd>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('catalog.style.season')}</dt>
            <dd className="font-medium">
              {style.season
                ? text(style.season.name, style.season.code)
                : t('catalog.common.noSeason')}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('catalog.style.group')}</dt>
            <dd className="font-medium">
              {text(style.productGroup.name, style.productGroup.code)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('catalog.style.productType')}</dt>
            <dd className="flex flex-wrap items-center gap-2 font-medium">
              {style.productType ?? t('catalog.style.notSet')}
              {style.channelLinked && <FromChannelBadge />}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('catalog.style.brand')}</dt>
            <dd className="flex flex-wrap items-center gap-2 font-medium">
              {style.brand ?? t('catalog.style.notSet')}
              {style.channelLinked && <FromChannelBadge />}
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <dt className="text-muted-foreground">{t('catalog.style.tags')}</dt>
            <dd>
              {style.tags.length === 0 ? (
                <span className="font-medium">{t('catalog.style.noTags')}</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <ul className="flex flex-wrap gap-1.5">
                    {style.tags.map((tag) => (
                      <li key={tag}>
                        <Badge variant="secondary">{tag}</Badge>
                      </li>
                    ))}
                  </ul>
                  {style.channelLinked && <FromChannelBadge />}
                </div>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <dt className="text-muted-foreground">{t('catalog.style.description')}</dt>
            <dd className="whitespace-pre-line">
              {description || (
                <span className="font-medium">{t('catalog.style.noDescription')}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="style-options-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="style-options-title" className="text-base font-semibold">
            {t('catalog.style.optionsTitle')}
          </h2>
          {style.channelLinked && style.options.length > 0 && <FromChannelBadge />}
        </div>
        {style.options.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('catalog.style.noOptions')}</p>
        ) : (
          <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-3">
            {style.options.map((option) => (
              <div key={option.id} className="flex flex-col gap-1">
                <dt className="text-muted-foreground">
                  {t('catalog.style.optionLine', {
                    name: text(option.name, ''),
                    role: t(`catalog.style.optionRole.${option.role}`),
                  })}
                </dt>
                <dd className="font-medium">
                  {option.values
                    .map((value) => text(value, ''))
                    .join(t('shell.modules.listSeparator'))}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="style-variants-title" className="flex flex-col gap-3">
        <h2 id="style-variants-title" className="text-base font-semibold">
          {t('catalog.style.variantsTitle')}
        </h2>
        {style.variants.length === 0 ? (
          <p className="rounded-lg border px-3 py-10 text-center text-sm text-muted-foreground">
            {t('catalog.style.noVariants')}
          </p>
        ) : (
          <CollapsingTable
            caption={t('catalog.style.variantsTableLabel')}
            columns={columns}
            rows={style.variants}
            getRowKey={(variant) => variant.id}
            className="sm:overflow-hidden sm:rounded-lg sm:border"
          />
        )}
      </section>

      {canSeeCost && <StyleCostHistory styleId={style.id} />}

      {open?.kind === 'edit' && <StyleEditDialog style={style} reload={reload} onClose={close} />}
      {open?.kind === 'code' && <StyleCodeDialog style={style} reload={reload} onClose={close} />}
      {open?.kind === 'cost' && canEdit && canSeeCost && (
        <RecordCostDialog style={style} onClose={close} />
      )}
      {open?.kind === 'add' && <AddVariantDialog style={style} onClose={close} />}
      {barcodesOf && (
        <VariantBarcodesDialog styleId={style.id} variant={barcodesOf} onClose={close} />
      )}
    </div>
  );
}
