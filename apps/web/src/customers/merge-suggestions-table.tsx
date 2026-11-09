'use client';

import type { MergeSuggestionItem } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { MergePairCustomer } from './merge-pair-customer';
import { mergePageHref } from './merge-page-href';

const features = tableFeatures({});

interface Props {
  rows: readonly MergeSuggestionItem[];
  /** True for a holder of `customers.merge`; without it the Actions column is left out. */
  canMerge: boolean;
  /** The suggestion being dismissed now: its buttons are disabled. */
  busyId: string | null;
  onDismiss: (suggestionId: string) => void;
}

/**
 * The merge suggestions as a table: why it was opened, the older and the newer record, when, and
 * (for `customers.merge`) Merge, which opens the merge page with both records and the suggestion,
 * and Dismiss. Each button name carries both customers so a screen reader can tell the rows apart.
 */
export function MergeSuggestionsTable({ rows, canMerge, busyId, onDismiss }: Props) {
  const { t } = useTranslation();
  const format = useFormat();

  const columns = useMemo<ColumnDef<typeof features, MergeSuggestionItem>[]>(() => {
    const base: ColumnDef<typeof features, MergeSuggestionItem>[] = [
      {
        id: 'reason',
        header: () => t('customers.review.columns.reason'),
        cell: ({ row }) => t(`customers.review.reason.${row.original.reason}`),
      },
      {
        id: 'first',
        header: () => t('customers.review.columns.first'),
        cell: ({ row }) => <MergePairCustomer customer={row.original.customers[0]} />,
      },
      {
        id: 'second',
        header: () => t('customers.review.columns.second'),
        cell: ({ row }) => <MergePairCustomer customer={row.original.customers[1]} />,
      },
      {
        id: 'opened',
        header: () => t('customers.review.columns.opened'),
        cell: ({ row }) => format.dateTime(row.original.createdAt),
      },
    ];
    if (!canMerge) return base;
    return [
      ...base,
      {
        id: 'actions',
        header: () => t('customers.review.columns.actions'),
        cell: ({ row }) => {
          const [first, second] = row.original.customers;
          const names = {
            first: first.name ?? t('customers.unnamed'),
            second: second.name ?? t('customers.unnamed'),
          };
          return (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Button asChild size="sm">
                <Link
                  href={mergePageHref(first.id, second.id, row.original.id)}
                  aria-label={t('customers.review.mergeLabel', names)}
                >
                  {t('customers.review.merge')}
                </Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === row.original.id}
                aria-label={t('customers.review.dismissLabel', names)}
                onClick={() => onDismiss(row.original.id)}
              >
                {t('customers.review.dismiss')}
              </Button>
            </span>
          );
        },
      },
    ];
  }, [t, format, canMerge, busyId, onDismiss]);

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
  });

  return (
    <div className="relative overflow-x-auto rounded-lg border">
      <Table aria-label={t('customers.review.tableLabel')}>
        <TableHeader className="bg-muted">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="h-row-header hover:bg-muted">
              {group.headers.map((header) => (
                <TableHead key={header.id} scope="col" className="px-3 text-start font-medium">
                  <table.FlexRender header={header} />
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} className="hover:bg-muted">
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className="px-3 py-2 text-start align-top">
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
