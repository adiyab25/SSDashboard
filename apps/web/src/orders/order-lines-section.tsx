'use client';

import type { OrderLineView } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/i18n/language-provider';
import type { TextByLanguage } from '@/i18n/localized-text';
import { useFormat } from '@/i18n/use-format';
import { OrderReasonText } from './order-reason-text';

const features = tableFeatures({});

const NUMERIC: ReadonlySet<string> = new Set([
  'quantity',
  'unitPrice',
  'discount',
  'gross',
  'prepaid',
  'credit',
  'unitCost',
]);

/**
 * The line's name in the reader's language from the catalog today, else the stored title (the
 * snapshot at the time of sale) when the line has no variant or the catalog lacks that language.
 */
function lineNameOf(line: OrderLineView, language: string): string {
  const name: TextByLanguage | null = line.name;
  return name?.[language]?.trim() || line.title;
}

/**
 * The lines of an order (spec 0013, AC-5): SKU code and name, quantity, unit price, discount,
 * gross, line state with the cancel reason, the prepaid and credit shares, and a "short" mark
 * with the missing quantity. The unit cost column exists only when the answer carries cost, which
 * the api sends to `cost.view` holders alone; this component never decides who sees cost.
 */
export function OrderLinesSection({ lines }: { lines: readonly OrderLineView[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { language } = useLanguage();
  const showCost = lines.some((line) => line.unitCost !== undefined && line.unitCost !== null);

  const columns = useMemo<ColumnDef<typeof features, OrderLineView>[]>(() => {
    const base: ColumnDef<typeof features, OrderLineView>[] = [
      {
        id: 'sku',
        header: () => t('orders.lines.sku'),
        cell: ({ row }) =>
          row.original.skuCode === null ? (
            <span className="text-muted-foreground">{t('orders.lines.unmapped')}</span>
          ) : (
            <LtrText>{row.original.skuCode}</LtrText>
          ),
      },
      {
        id: 'title',
        header: () => t('orders.lines.name'),
        cell: ({ row }) => (
          <span className="flex flex-col gap-1">
            <bdi dir="auto">{lineNameOf(row.original, language)}</bdi>
            {row.original.shortQuantity > 0 && (
              <Badge variant="outline" className="w-fit">
                {t('orders.lines.short', { count: row.original.shortQuantity })}
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: 'quantity',
        header: () => t('orders.lines.quantity'),
        cell: ({ row }) => format.quantity(row.original.quantity),
      },
      {
        id: 'unitPrice',
        header: () => t('orders.lines.unitPrice'),
        cell: ({ row }) => format.money(row.original.unitPrice, 2),
      },
      {
        id: 'discount',
        header: () => t('orders.lines.discount'),
        cell: ({ row }) => format.money(row.original.discountAmount, 2),
      },
      {
        id: 'gross',
        header: () => t('orders.lines.gross'),
        cell: ({ row }) => format.money(row.original.grossAmount, 2),
      },
      {
        id: 'state',
        header: () => t('orders.lines.state'),
        cell: ({ row }) => (
          <span className="flex flex-col gap-0.5">
            {t(`orders.lineState.${row.original.lineState}`)}
            {row.original.cancelReasonCode && (
              <span className="text-xs text-muted-foreground">
                <OrderReasonText code={row.original.cancelReasonCode} />
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'prepaid',
        header: () => t('orders.lines.prepaid'),
        cell: ({ row }) => format.money(row.original.prepaidAmount, 2),
      },
      {
        id: 'credit',
        header: () => t('orders.lines.credit'),
        cell: ({ row }) => format.money(row.original.creditAppliedAmount, 2),
      },
    ];
    if (showCost) {
      base.push({
        id: 'unitCost',
        header: () => t('orders.lines.unitCost'),
        cell: ({ row }) =>
          row.original.unitCost == null ? null : format.money(row.original.unitCost, 4),
      });
    }
    return base;
  }, [t, format, language, showCost]);

  const table = useTable({ features, columns, data: lines, getRowId: (row) => row.id });

  return (
    <section aria-labelledby="order-lines-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="order-lines-title" className="text-base font-semibold">
        {t('orders.lines.title')}
      </h2>
      <div className="relative overflow-x-auto rounded-lg border">
        <Table aria-labelledby="order-lines-title">
          <TableHeader className="bg-muted">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="h-row-header hover:bg-muted">
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    scope="col"
                    className={`px-3 font-medium ${NUMERIC.has(header.column.id) ? 'text-end' : 'text-start'}`}
                  >
                    <table.FlexRender header={header} />
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className="h-row hover:bg-muted">
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={`px-3 ${NUMERIC.has(cell.column.id) ? 'text-end tabular-nums' : 'text-start'}`}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
