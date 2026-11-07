'use client';

import type { AuditEntryView, AuditFieldChange } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ssdashboard/ui/components/dialog';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useReturnFocus } from '@/shared/use-return-focus';
import { auditKeys, getAuditEntry } from './audit-api';
import { AuditUndoDialog } from './audit-undo-dialog';
import { RecordHistoryPanel } from './record-history-panel';
import { useEntryText } from './use-entry-text';

/** A changed value as plain text: a string as written, anything else as JSON. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The entry detail (spec 0010, AC-12): who, when, what, and which record, then the changed fields
 * one row each (field name, before, after) so a screen reader reads a value with its field. A
 * personal field shows "Hidden, personal data" and never the stored marker. "Show entries of
 * the same action" links to the list filtered by the entry's correlation id, and "Show the history
 * of this record" opens the record history panel. A diff row says "none" for a side the field
 * does not have (`added`, `removed`), "empty" for a stored null, and "hidden" for personal data.
 * The Undo button shows only when the api says the viewer may undo the entry (`canUndo`) and opens
 * the one step confirm dialog; once undone the entry shows an "Undone" marker and focus moves to
 * it. Never undoes anything itself; focus goes back to the row's button on close, or to
 * `onSameAction`'s target after the same action link.
 */
export function AuditEntryDialog({
  entry,
  onClose,
  onSameAction,
}: {
  entry: AuditEntryView;
  onClose: () => void;
  /** Moves focus to the results once the dialog has closed through "same action" (M3R17). */
  onSameAction?: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useEntryText();
  const returnFocus = useReturnFocus();
  const [history, setHistory] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [justUndone, setJustUndone] = useState(false);
  const sameAction = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const detail = useQuery({
    queryKey: auditKeys.entry(entry.id),
    queryFn: ({ signal }) => getAuditEntry(entry.id, signal),
  });
  // The fresh answer wins over the row the list handed in: the row may be stale after an undo.
  const current = detail.data ?? entry;
  const undone = current.undone || justUndone;
  const canUndo = current.canUndo && !justUndone;

  useEffect(() => {
    if (justUndone) noticeRef.current?.focus();
  }, [justUndone]);

  function cell(change: AuditFieldChange, side: 'before' | 'after') {
    if (change.personal) return t('audit.detail.hidden');
    const absent = change.kind === (side === 'before' ? 'added' : 'removed');
    const value = change[side];
    if (!absent && value === null) {
      return <span className="text-muted-foreground">{t('audit.detail.empty')}</span>;
    }
    return absent || value === undefined ? (
      <span className="text-muted-foreground">{t('audit.detail.none')}</span>
    ) : (
      <span dir="auto" className="break-words">
        {valueText(value)}
      </span>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={t('audit.detail.close')}
        onCloseAutoFocus={(event) => {
          if (sameAction.current && onSameAction) {
            event.preventDefault();
            onSameAction();
          } else {
            returnFocus(event);
          }
        }}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {text.actionName(entry)}
            {undone && <Badge variant="outline">{t('audit.undo.undone')}</Badge>}
          </DialogTitle>
          <DialogDescription>{t('audit.detail.description')}</DialogDescription>
        </DialogHeader>

        {undone && (
          <p
            ref={noticeRef}
            role="status"
            tabIndex={-1}
            className="rounded-lg border bg-muted px-3 py-2 text-sm outline-none focus-ring"
          >
            {t('audit.undo.undoneNotice')}
          </p>
        )}

        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">{t('audit.columns.time')}</dt>
          <dd>
            <time dateTime={entry.recordedAt}>{format.dateTime(entry.recordedAt)}</time>
          </dd>
          <dt className="font-medium">{t('audit.columns.actor')}</dt>
          <dd>{text.actor(entry)}</dd>
          <dt className="font-medium">{t('audit.columns.record')}</dt>
          <dd>{text.record(entry)}</dd>
          <dt className="font-medium">{t('audit.columns.reason')}</dt>
          <dd>
            {entry.reason ? (
              <span dir="auto">{entry.reason}</span>
            ) : (
              <span className="text-muted-foreground">{t('audit.noReason')}</span>
            )}
          </dd>
        </dl>

        <section aria-labelledby="audit-changes-title" className="flex flex-col gap-2">
          <h3 id="audit-changes-title" className="text-base font-semibold">
            {t('audit.detail.changes')}
          </h3>
          {detail.isError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {t('audit.detail.loadError')}
                <Button
                  size="sm"
                  variant="outline"
                  aria-disabled={detail.isFetching}
                  aria-busy={detail.isFetching}
                  onClick={() => {
                    if (!detail.isFetching) void detail.refetch();
                  }}
                >
                  {detail.isFetching && (
                    <LoaderCircleIcon
                      aria-hidden
                      className="animate-spin motion-reduce:animate-none"
                      data-icon="inline-start"
                    />
                  )}
                  {t('audit.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : detail.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : detail.data.changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('audit.detail.noChanges')}</p>
          ) : (
            <div className="rounded-lg border">
              <Table aria-label={t('audit.detail.tableLabel')}>
                <TableHeader className="bg-muted">
                  <TableRow className="h-row-header hover:bg-muted">
                    <TableHead scope="col" className="px-3 text-start font-medium">
                      {t('audit.detail.field')}
                    </TableHead>
                    <TableHead scope="col" className="px-3 text-start font-medium">
                      {t('audit.detail.before')}
                    </TableHead>
                    <TableHead scope="col" className="px-3 text-start font-medium">
                      {t('audit.detail.after')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.changes.map((change) => (
                    <TableRow key={change.field} className="h-row hover:bg-muted">
                      <TableHead scope="row" className="px-3 text-start font-medium" dir="ltr">
                        {change.field}
                      </TableHead>
                      <TableCell className="px-3">{cell(change, 'before')}</TableCell>
                      <TableCell className="px-3">{cell(change, 'after')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link
              href={`/audit?${new URLSearchParams({ correlationId: entry.correlationId })}`}
              onClick={() => {
                sameAction.current = true;
                onClose();
              }}
            >
              {t('audit.detail.sameAction')}
            </Link>
          </Button>
          <Button
            variant="outline"
            aria-expanded={history}
            aria-controls="audit-entry-history"
            onClick={() => setHistory((open) => !open)}
          >
            {history ? t('audit.detail.hideHistory') : t('audit.detail.showHistory')}
          </Button>
          {canUndo && (
            <Button variant="destructive" onClick={() => setUndoing(true)}>
              {t('audit.undo.button')}
            </Button>
          )}
        </div>
        <div id="audit-entry-history">
          {history && (
            <RecordHistoryPanel
              recordType={entry.record.type}
              recordId={entry.record.id}
              headingLevel={3}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('audit.detail.close')}
          </Button>
        </DialogFooter>
        {undoing && (
          <AuditUndoDialog
            entry={entry}
            onClose={() => setUndoing(false)}
            onUndone={() => {
              setJustUndone(true);
              setUndoing(false);
            }}
            onDoneFocus={() => noticeRef.current?.focus()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
