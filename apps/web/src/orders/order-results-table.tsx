'use client';

import type { OrderListItem } from '@ssdashboard/contracts';
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
import { useLocalizedText } from '@/i18n/use-localized-text';
import { CashChip } from './cash-chip';
import { FulfillmentChip } from './fulfillment-chip';
import { OrderFlags } from './order-flags';
import { OrderNumber } from './order-number';

const features = tableFeatures({});

type ColumnId = 'number' | 'who' | 'channel' | 'total' | 'due' | 'state' | 'cash';

/** Money columns are end aligned with tabular digits (DESIGN.md, Data tables). */
const NUMERIC: ReadonlySet<string> = new Set<ColumnId>(['total', 'due']);

/**
 * The orders a list page found, in the design system's fixed column order: number (with its store,
 * placed time, and the small flags), who, where, how much (total and amount due), fulfillment, and
 * cash. The ship to name is personal data shown to `orders.view` holders, isolated for its
 * direction; the number is a link to the order page.
 */
export function OrderResultsTable({ rows }: { rows: readonly OrderListItem[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();

  const columns = useMemo<ColumnDef<typeof features, OrderListItem>[]>(
    () => [
      {
        id: 'number',
        header: () => t('orders.columns.number'),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5 py-1">
            <Link
              href={`/orders/${row.original.id}`}
              className="w-fit rounded-chip font-medium underline-offset-4 hover:underline focus-ring"
            >
              <OrderNumber order={row.original} />
            </Link>
            <span className="text-xs text-muted-foreground">
              {format.dateTime(row.original.placedAt)}
            </span>
            <OrderFlags order={row.original} />
          </div>
        ),
      },
      {
        id: 'who',
        header: () => t('orders.columns.who'),
        cell: ({ row }) =>
          row.original.shipToName === null ? null : <bdi dir="auto">{row.original.shipToName}</bdi>,
      },
      {
        id: 'channel',
        header: () => t('orders.columns.channel'),
        cell: ({ row }) => <bdi dir="auto">{text(row.original.channelName, '')}</bdi>,
      },
      {
        id: 'total',
        header: () => t('orders.columns.total'),
        cell: ({ row }) => format.money(row.original.totalAmount, 2),
      },
      {
        id: 'due',
        header: () => t('orders.columns.due'),
        cell: ({ row }) => format.money(row.original.codDueAmount, 2),
      },
      {
        id: 'state',
        header: () => t('orders.columns.state'),
        cell: ({ row }) => (
          <FulfillmentChip state={row.original.fulfillmentState} outcome={row.original.outcome} />
        ),
      },
      {
        id: 'cash',
        header: () => t('orders.columns.cash'),
        cell: ({ row }) => <CashChip state={row.original.cashState} />,
      },
    ],
    [t, format, text],
  );

  const table = useTable({ features, columns, data: rows, getRowId: (row) => row.id });

  return (
    <div className="relative overflow-x-auto rounded-card gradient-card-edge">
      <Table aria-label={t('orders.tableLabel')}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="h-row-header">
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  scope="col"
                  className={`px-3 ${NUMERIC.has(header.column.id) ? 'text-end' : 'text-start'}`}
                >
                  <table.FlexRender header={header} />
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} className="min-h-row">
              {row.getAllCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={`px-3 align-top ${NUMERIC.has(cell.column.id) ? 'text-end tabular-nums' : 'text-start'}`}
                >
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
