'use client';

import type { CustomerBrief } from '@ssdashboard/contracts';
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
import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { CustomerFlagBadge } from './customer-flag-badge';

const features = tableFeatures({});

type ColumnId = 'name' | 'phone' | 'phones' | 'flag' | 'created';

/** Number columns are end aligned with tabular digits (DESIGN.md, Data tables). */
const NUMERIC: ReadonlySet<string> = new Set<ColumnId>(['phones']);

/**
 * The customers a search found: name (the link to the profile), primary phone, how many phones,
 * the flag, and when the record was added. The phone is personal data shown in full to holders of
 * `customers.view` (spec 0014, Security model), inside `LtrText`.
 */
export function CustomerResultsTable({ rows }: { rows: readonly CustomerBrief[] }) {
  const { t } = useTranslation();
  const format = useFormat();

  const columns = useMemo<ColumnDef<typeof features, CustomerBrief>[]>(
    () => [
      {
        id: 'name',
        header: () => t('customers.columns.name'),
        cell: ({ row }) => (
          <Link
            href={`/customers/${row.original.id}`}
            className="rounded-chip font-medium underline-offset-4 hover:underline focus-ring"
          >
            <bdi dir="auto">{row.original.name ?? t('customers.unnamed')}</bdi>
          </Link>
        ),
      },
      {
        id: 'phone',
        header: () => t('customers.columns.phone'),
        cell: ({ row }) =>
          row.original.primaryPhone === null ? null : (
            <LtrText>{row.original.primaryPhone}</LtrText>
          ),
      },
      {
        id: 'phones',
        header: () => t('customers.columns.phones'),
        cell: ({ row }) => format.number(row.original.phoneCount),
      },
      {
        id: 'flag',
        header: () => t('customers.columns.flag'),
        cell: ({ row }) => <CustomerFlagBadge kind={row.original.flagKind} />,
      },
      {
        id: 'created',
        header: () => t('customers.columns.created'),
        cell: ({ row }) => format.dateTime(row.original.createdAt),
      },
    ],
    [t, format],
  );

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
  });

  return (
    <div className="relative overflow-hidden rounded-card gradient-card-edge">
      <Table aria-label={t('customers.search.tableLabel')}>
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
            <TableRow key={row.id} className="h-row">
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
  );
}
