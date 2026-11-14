'use client';

import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { useTranslation } from 'react-i18next';

/**
 * A table with a lowercase mono header, a plain row, a row pinned to its hover state, and a
 * selected row (the start edge tint). The hovered and selected rows each hold a link and an owed
 * chip, the story of spec 0025 AC-5: in light the hover is the ink tint, never `accent`, so the
 * cyan link and the owed text stay readable on it.
 */
export function TableSample() {
  const { t } = useTranslation();
  const rows = [
    { code: 'ORD-1001', state: 'confirmed', pinned: undefined, selected: false },
    { code: 'ORD-1002', state: 'owed', pinned: 'hover', selected: false },
    { code: 'ORD-1003', state: 'owed', pinned: undefined, selected: true },
  ] as const;

  return (
    <div className="rounded-card border bg-card">
      <Table aria-label={t('design.table.label')}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('design.table.order')}</TableHead>
            <TableHead>{t('design.table.customer')}</TableHead>
            <TableHead>{t('design.table.state')}</TableHead>
            <TableHead>{t('design.table.note')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.code}
              data-state={row.selected ? 'selected' : undefined}
              data-state-preview={row.pinned}
            >
              <TableCell>
                <a
                  className="text-primary underline-offset-4 hover:underline focus-ring"
                  href="/design"
                >
                  <LtrText className="font-mono">{row.code}</LtrText>
                </a>
              </TableCell>
              <TableCell>{t('design.table.customerName')}</TableCell>
              <TableCell>
                <StatusChip
                  meaning={row.state}
                  label={t(row.state === 'owed' ? 'design.status.owed' : 'design.status.confirmed')}
                />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {t(
                  row.selected
                    ? 'design.table.selectedRow'
                    : row.pinned
                      ? 'design.table.hoverRow'
                      : 'design.table.plainRow',
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
