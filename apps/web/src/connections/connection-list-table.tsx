'use client';

import type { ConnectionHealth, ConnectionListItem } from '@ssdashboard/contracts';
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
import { cn } from '@ssdashboard/ui/lib/utils';
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const features = tableFeatures({});

/** Whether a row shows a reason or warning sentence under its health badge. */
function hasNote(item: ConnectionListItem): boolean {
  return Boolean(item.healthReason) || item.healthWarnings.length > 0;
}

/** The badge look of each health; the word is always shown, so color is never the only signal. */
const HEALTH_VARIANT: Record<ConnectionHealth, 'secondary' | 'outline' | 'destructive'> = {
  connecting: 'outline',
  ok: 'secondary',
  degraded: 'outline',
  failing: 'destructive',
};

/**
 * The connections of one page: name, store code, provider, status, and health with the reason and
 * the warnings in plain sentences (spec 0015, AC-1, AC-27). A row carries no credential, so none
 * is ever drawn. The store code is a code, so it reads left to right even in Arabic.
 */
export function ConnectionListTable({ rows }: { rows: readonly ConnectionListItem[] }) {
  const { t } = useTranslation();

  const columns = useMemo<ColumnDef<typeof features, ConnectionListItem>[]>(
    () => [
      {
        id: 'label',
        header: () => t('connections.columns.label'),
        cell: ({ row }) => (
          <bdi dir="auto" className="font-medium">
            {row.original.label}
          </bdi>
        ),
      },
      {
        id: 'storeCode',
        header: () => t('connections.columns.storeCode'),
        cell: ({ row }) =>
          row.original.storeCode === null ? (
            <span className="text-muted-foreground">{t('connections.noStore')}</span>
          ) : (
            <LtrText>{row.original.storeCode}</LtrText>
          ),
      },
      {
        id: 'provider',
        header: () => t('connections.columns.provider'),
        cell: ({ row }) => t(`connections.providers.${row.original.provider}`),
      },
      {
        id: 'status',
        header: () => t('connections.columns.status'),
        cell: ({ row }) => t(`connections.statuses.${row.original.status}`),
      },
      {
        id: 'health',
        header: () => t('connections.columns.health'),
        cell: ({ row }) => {
          const { health, healthReason, healthWarnings } = row.original;
          return (
            <div
              className={cn(
                'flex min-w-0 flex-col items-start gap-1',
                hasNote(row.original) && 'py-2',
              )}
            >
              <Badge variant={HEALTH_VARIANT[health]}>{t(`connections.health.${health}`)}</Badge>
              {healthReason && (
                <p className="max-w-prose text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t('connections.reasonPrefix')}
                  </span>{' '}
                  {t(`connections.reasons.${healthReason}`)}
                </p>
              )}
              {healthWarnings.map((warning) => (
                <p key={warning} className="max-w-prose text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t('connections.warningsPrefix')}
                  </span>{' '}
                  {t(`connections.warnings.${warning}`)}
                </p>
              ))}
            </div>
          );
        },
      },
    ],
    [t],
  );

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
  });

  return (
    <div className="relative overflow-hidden rounded-card gradient-card-edge">
      <Table aria-label={t('connections.tableLabel')}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="h-row-header">
              {group.headers.map((header) => (
                <TableHead key={header.id} scope="col" className="px-3 text-start">
                  <table.FlexRender header={header} />
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} className={cn(hasNote(row.original) && 'align-top')}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className="px-3 text-start">
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
