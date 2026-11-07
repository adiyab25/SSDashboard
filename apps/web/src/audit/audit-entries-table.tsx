'use client';

import type { AuditEntryView } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
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
import { ACTOR_KIND_KEYS, actionLabelKey, recordTypeLabelKey } from './audit-labels';

const COLUMNS = ['time', 'actor', 'action', 'record', 'reason'] as const;

/**
 * The audit entries as a table: when, who, what, which record, and why. Shows five skeleton
 * rows while loading and "No entries match" when the list is empty. It reads nothing from the
 * api; the page hands it the rows. Never edits an entry.
 */
export function AuditEntriesTable({
  rows,
  loading,
}: {
  rows: readonly AuditEntryView[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();

  function actorOf(entry: AuditEntryView) {
    if (entry.actorName) return entry.actorName;
    if (entry.actor.kind === 'person') return t('audit.unknownPerson');
    return (
      <>
        {t(ACTOR_KIND_KEYS[entry.actor.kind])}
        {entry.actor.ref ? (
          <>
            {' '}
            <LtrText>{entry.actor.ref}</LtrText>
          </>
        ) : null}
      </>
    );
  }

  function actionOf(entry: AuditEntryView) {
    const key = actionLabelKey(entry.action);
    return key ? t(key) : <LtrText>{entry.action}</LtrText>;
  }

  function recordOf(entry: AuditEntryView) {
    const key = recordTypeLabelKey(entry.record.type);
    return (
      <span className="flex flex-col">
        <span className="text-xs text-muted-foreground">
          {key ? t(key) : <LtrText>{entry.record.type}</LtrText>}
        </span>
        {entry.record.label ? <LtrText>{entry.record.label}</LtrText> : null}
      </span>
    );
  }

  return (
    <div className="relative overflow-x-auto rounded-lg border">
      <Table aria-label={t('audit.tableLabel')} aria-busy={loading}>
        <TableHeader className="sticky top-0 bg-muted">
          <TableRow className="h-row-header hover:bg-muted">
            {COLUMNS.map((column) => (
              <TableHead key={column} scope="col" className="px-3 text-start font-medium">
                {t(`audit.columns.${column}`)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            Array.from({ length: 5 }, (_, index) => (
              <TableRow key={index} className="h-row" aria-hidden>
                <TableCell colSpan={COLUMNS.length} className="px-3">
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))}
          {!loading && rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={COLUMNS.length} className="px-3 py-10">
                <div className="flex flex-col items-center gap-3 text-center">
                  <ScrollTextIcon aria-hidden className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
                </div>
              </TableCell>
            </TableRow>
          )}
          {!loading &&
            rows.map((entry) => (
              <TableRow key={entry.id} className="h-row hover:bg-muted">
                <TableCell className="px-3 whitespace-nowrap">
                  <time dateTime={entry.recordedAt}>{format.dateTime(entry.recordedAt)}</time>
                </TableCell>
                <TableCell className="px-3">{actorOf(entry)}</TableCell>
                <TableCell className="px-3 font-medium">{actionOf(entry)}</TableCell>
                <TableCell className="px-3">{recordOf(entry)}</TableCell>
                <TableCell className="px-3">
                  {entry.reason ? (
                    <span dir="auto">{entry.reason}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('audit.noReason')}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
