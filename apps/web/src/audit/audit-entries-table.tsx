'use client';

import type { AuditEntryView } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { ScrollTextIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useEntryText } from './use-entry-text';

const COLUMNS = ['time', 'actor', 'action', 'record', 'reason'] as const;

/**
 * The audit entries as a table: when, who, what, which record, and why. Shows five skeleton
 * rows while loading and "No entries match" when the list is empty. It reads nothing from the
 * api; the page hands it the rows. Never edits an entry.
 */
export function AuditEntriesTable({
  rows,
  loading,
  onOpen,
  emptyText,
  labelledBy,
}: {
  rows: readonly AuditEntryView[];
  loading: boolean;
  /** Adds a Details button to each row that opens the entry; the history panel passes none. */
  onOpen?: (entry: AuditEntryView) => void;
  /** The empty state's text; defaults to "No entries match". */
  emptyText?: string;
  /** The id of a heading that names the table; default is the "Audit entries" label. */
  labelledBy?: string;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useEntryText();

  return (
    <div className="relative overflow-x-auto rounded-card gradient-card-edge">
      <Table
        {...(labelledBy
          ? { 'aria-labelledby': labelledBy }
          : { 'aria-label': t('audit.tableLabel') })}
        aria-busy={loading}
      >
        <TableHeader className="sticky top-0">
          <TableRow className="h-row-header">
            {COLUMNS.map((column) => (
              <TableHead key={column} scope="col" className="px-3 text-start">
                {t(`audit.columns.${column}`)}
              </TableHead>
            ))}
            {onOpen && (
              <TableHead scope="col" className="w-12 px-3 text-start">
                <span className="sr-only">{t('audit.row.details')}</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            Array.from({ length: 5 }, (_, index) => (
              <TableRow key={index} className="h-row" aria-hidden>
                <TableCell colSpan={COLUMNS.length + (onOpen ? 1 : 0)} className="px-3">
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))}
          {!loading && rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={COLUMNS.length + (onOpen ? 1 : 0)} className="px-3 py-10">
                <div className="flex flex-col items-center gap-3 text-center">
                  <ScrollTextIcon aria-hidden className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{emptyText ?? t('audit.empty')}</p>
                </div>
              </TableCell>
            </TableRow>
          )}
          {!loading &&
            rows.map((entry) => (
              <TableRow key={entry.id} className="h-row">
                <TableCell className="px-3 whitespace-nowrap">
                  <time dateTime={entry.recordedAt}>{format.dateTime(entry.recordedAt)}</time>
                </TableCell>
                <TableCell className="px-3">{text.actor(entry)}</TableCell>
                <TableCell className="px-3 font-medium">
                  <span className="flex flex-wrap items-center gap-2">
                    {text.action(entry)}
                    {entry.undone && <Badge variant="outline">{t('audit.undo.undone')}</Badge>}
                  </span>
                </TableCell>
                <TableCell className="px-3">{text.record(entry)}</TableCell>
                <TableCell className="px-3">
                  {entry.reason ? (
                    <span dir="auto">{entry.reason}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('audit.noReason')}</span>
                  )}
                </TableCell>
                {onOpen && (
                  <TableCell className="px-3 sm:py-0 sm:[&:lang(ar)]:py-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('audit.row.open', {
                        action: text.actionName(entry),
                        record: entry.record.label ?? '',
                      })}
                      onClick={() => onOpen(entry)}
                    >
                      {t('audit.row.details')}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
