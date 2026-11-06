'use client';

import type { StockReceiptDetail } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { PackagePlusIcon, Undo2Icon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { VoidReceiptDialog } from './void-receipt-dialog';

/** The loaded receipt: header, lines with totals, and the void action for admins. */
export function ReceiptView({ receipt }: { receipt: StockReceiptDetail }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const access = useAccess();
  const seesCost = access.can('cost.view') && receipt.referenceValue !== undefined;
  const [voiding, setVoiding] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">
              <LtrText>{receipt.number}</LtrText>
            </h1>
            <Badge variant={receipt.status === 'voided' ? 'destructive' : 'secondary'}>
              {t(`inventory.receiptDetail.status.${receipt.status}`)}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/stock-receipts">{t('inventory.receiptDetail.allReceipts')}</Link>
          </Button>
          {access.can('stock.correct') && receipt.status === 'posted' && (
            <Button variant="outline" onClick={() => setVoiding(true)}>
              <Undo2Icon aria-hidden data-icon="inline-start" className="rtl:-scale-x-100" />
              {t('inventory.void.open')}
            </Button>
          )}
          {access.can('stock.receive') && (
            <Button asChild>
              <Link href="/stock-receipts/new">
                <PackagePlusIcon aria-hidden data-icon="inline-start" />
                {t('inventory.receiptDetail.receiveMore')}
              </Link>
            </Button>
          )}
        </div>
      </div>

      <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.receiptDetail.location')}</dt>
          <dd className="font-medium">{text(receipt.location.name, receipt.location.code)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.receiptDetail.date')}</dt>
          <dd className="font-medium">{format.dateTime(receipt.effectiveAt)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.receiptDetail.reference')}</dt>
          <dd className="font-medium">
            {receipt.reference ? (
              <LtrText>{receipt.reference}</LtrText>
            ) : (
              t('inventory.receiptDetail.none')
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.receiptDetail.postedBy')}</dt>
          <dd className="font-medium">{receipt.postedBy.name}</dd>
        </div>
        {receipt.void && (
          <>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">{t('inventory.receiptDetail.voidedAt')}</dt>
              <dd className="font-medium">{format.dateTime(receipt.void.voidedAt)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">{t('inventory.receiptDetail.voidedBy')}</dt>
              <dd className="font-medium">{receipt.void.voidedBy.name}</dd>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="text-muted-foreground">{t('inventory.receiptDetail.voidReason')}</dt>
              <dd className="whitespace-pre-line">{receipt.void.reason}</dd>
            </div>
          </>
        )}
        {receipt.note && (
          <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
            <dt className="text-muted-foreground">{t('inventory.receiptDetail.note')}</dt>
            <dd className="whitespace-pre-line">{receipt.note}</dd>
          </div>
        )}
      </dl>

      <section aria-labelledby="receipt-lines-title" className="flex flex-col gap-3">
        <h2 id="receipt-lines-title" className="text-base font-semibold">
          {t('inventory.receiptDetail.linesTitle')}
        </h2>
        <div className="relative overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.receiptDetail.tableLabel')}>
            <TableHeader className="bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                <TableHead scope="col" className="w-12 px-3 text-end font-medium">
                  {t('inventory.receiptDetail.position')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.stock.columns.sku')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.stock.columns.name')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-end font-medium">
                  {t('inventory.receipt.quantity')}
                </TableHead>
                {seesCost && (
                  <>
                    <TableHead scope="col" className="px-3 text-end font-medium">
                      {t('inventory.receipt.unitCost')}
                    </TableHead>
                    <TableHead scope="col" className="px-3 text-end font-medium">
                      {t('inventory.receipt.lineTotal')}
                    </TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipt.lines.map((line) => (
                <TableRow key={line.id} className="h-row hover:bg-muted">
                  <TableCell className="px-3 text-end tabular-nums text-muted-foreground">
                    {format.quantity(line.position)}
                  </TableCell>
                  <TableCell className="px-3">
                    <LtrText className="font-medium">{line.sku.code}</LtrText>
                  </TableCell>
                  <TableCell className="px-3">{text(line.sku.name, line.sku.code)}</TableCell>
                  <TableCell className="px-3 text-end tabular-nums">
                    {format.quantity(line.quantity)}
                  </TableCell>
                  {seesCost && (
                    <>
                      <TableCell className="px-3 text-end tabular-nums">
                        {line.unitCost ? format.money(line.unitCost, 4) : ''}
                      </TableCell>
                      <TableCell className="px-3 text-end tabular-nums">
                        {line.lineTotal ? format.money(line.lineTotal, 2) : ''}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="h-row hover:bg-transparent">
                <TableCell colSpan={3} className="px-3 font-medium">
                  {t('inventory.receipt.totalQuantity')}
                </TableCell>
                <TableCell className="px-3 text-end font-medium tabular-nums">
                  {format.quantity(receipt.totalQuantity)}
                </TableCell>
                {seesCost && (
                  <>
                    <TableCell className="px-3 text-end text-muted-foreground">
                      {t('inventory.receipt.referenceValue')}
                    </TableCell>
                    <TableCell className="px-3 text-end font-medium tabular-nums">
                      {receipt.referenceValue ? format.money(receipt.referenceValue, 2) : ''}
                    </TableCell>
                  </>
                )}
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </section>

      {voiding && <VoidReceiptDialog receipt={receipt} onClose={() => setVoiding(false)} />}
    </div>
  );
}
