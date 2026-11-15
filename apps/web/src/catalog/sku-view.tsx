'use client';

import type { SkuDetail } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { FromChannelBadge } from './from-channel-badge';
import { SkuEditDialog } from './sku-edit-dialog';
import { SkuHistorySection } from './sku-history-section';
import { SkuStockSection } from './sku-stock-section';
import { SkuStyleBlock } from './sku-style-block';

/** The loaded SKU: header, price, stock per location, movement history, and the edit dialog. */
export function SkuView({ sku }: { sku: SkuDetail }) {
  const { t } = useTranslation();
  const canEdit = useAccess().can('catalog.edit');
  const format = useFormat();
  const text = useLocalizedText();
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">
              <LtrText>{sku.code}</LtrText>
            </h1>
            {sku.archived && <Badge variant="outline">{t('inventory.skus.archivedBadge')}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{text(sku.name, sku.code)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/skus">{t('inventory.skuDetail.back')}</Link>
          </Button>
          {canEdit && (
            <Button onClick={() => setEditing(true)}>
              <PencilIcon aria-hidden data-icon="inline-start" />
              {t('inventory.skuDetail.edit')}
            </Button>
          )}
        </div>
      </div>

      <dl className="grid gap-4 rounded-card gradient-card-edge p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.price')}</dt>
          <dd className="flex flex-wrap items-center gap-2 font-medium">
            <span className="tabular-nums">
              {sku.price === null ? t('inventory.skuDetail.noPrice') : format.money(sku.price, 2)}
            </span>
            {sku.channelLinked && <FromChannelBadge />}
          </dd>
        </div>
      </dl>

      <SkuStyleBlock sku={sku} />

      <SkuStockSection skuId={sku.id} />
      <SkuHistorySection skuId={sku.id} />

      {editing && (
        <SkuEditDialog
          skuId={sku.id}
          onClose={() => setEditing(false)}
          onDeleted={() => router.replace('/skus')}
        />
      )}
    </div>
  );
}
