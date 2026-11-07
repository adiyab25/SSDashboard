'use client';

import {
  AUDIT_EXPORT_MAX_DAYS,
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_REASON_HEADER,
  auditExportDayCount,
} from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { DownloadIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/auth/api-fetch';
import { exportUrl, type AuditFilter } from './audit-api';

/** How long the object url of a saved file stays valid after the click. */
const REVOKE_DELAY_MS = 10_000;

/** The file name the api chose in `Content-Disposition`, or a plain fallback. */
function fileNameOf(response: Response): string {
  const header = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(header)?.[1] ?? 'audit-trail.csv';
}

/** Hands a downloaded file to the browser the way a link with `download` does. */
function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Later, so a browser that starts the download asynchronously still finds the file.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** The error code of a failed export answer, or `generic`. */
async function errorCodeOf(response: Response): Promise<string> {
  const json: unknown = await response.json().catch(() => null);
  return typeof json === 'object' &&
    json !== null &&
    'code' in json &&
    typeof json.code === 'string'
    ? json.code
    : 'generic';
}

/**
 * The CSV export of the current filter (spec 0010, AC-15). It needs both days of the range and
 * says why when they are missing or more than 366 days apart; the api checks again and its
 * answers (400 `INVALID_FILTER`, 413 `EXPORT_TOO_LARGE`, 403) are shown from their codes. The file
 * is fetched, so an error never replaces the page with JSON; the button stays focused while it
 * works (`aria-disabled`). An optional reason is kept in the audit entry of the export itself.
 */
export function AuditExportControl({ filter }: { filter: AuditFilter }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const { dayFrom, dayTo } = filter;
  // Inclusive: the first and the last day both count (spec 0010, AC-15).
  const days = dayFrom && dayTo ? auditExportDayCount(dayFrom, dayTo) : null;
  const needRange = !dayFrom || !dayTo;
  const tooLong = days !== null && days > AUDIT_EXPORT_MAX_DAYS;
  const reversed = days !== null && days < 1;
  const blocked = needRange || tooLong || reversed;
  const hint = needRange
    ? t('audit.export.needRange')
    : reversed
      ? t('audit.filters.problems.dayOrder')
      : tooLong
        ? t('audit.export.rangeTooLong', { days: AUDIT_EXPORT_MAX_DAYS })
        : null;

  async function download() {
    if (busy || blocked || !dayFrom || !dayTo) return;
    setBusy(true);
    setDone(false);
    setFailure(null);
    try {
      const trimmed = reason.trim();
      const response = await apiFetch(exportUrl({ ...filter, dayFrom, dayTo }), {
        cache: 'no-store',
        // The reason is free text: a header, never the url, so no access log keeps it.
        ...(trimmed && { headers: { [AUDIT_REASON_HEADER]: encodeURIComponent(trimmed) } }),
      });
      if (!response.ok) {
        const code = await errorCodeOf(response);
        setFailure(
          code === 'EXPORT_TOO_LARGE'
            ? t('audit.export.errors.tooLarge', { rows: AUDIT_EXPORT_MAX_ROWS })
            : code === 'INVALID_FILTER'
              ? t('audit.export.errors.invalid')
              : response.status === 403
                ? t('audit.export.errors.forbidden')
                : t('audit.export.errors.generic'),
        );
        return;
      }
      saveFile(await response.blob(), fileNameOf(response));
      setDone(true);
    } catch {
      setFailure(t('audit.export.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="audit-export-title"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="audit-export-title" className="text-base font-semibold">
          {t('audit.export.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('audit.export.hint', { days: AUDIT_EXPORT_MAX_DAYS })}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="audit-export-reason" className="text-sm font-medium">
            {t('audit.export.reason')}
          </label>
          <Input
            id="audit-export-reason"
            maxLength={500}
            autoComplete="off"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <Button
          variant="outline"
          aria-disabled={busy || blocked}
          aria-busy={busy}
          aria-describedby={hint ? 'audit-export-block' : undefined}
          onClick={() => void download()}
        >
          {busy ? (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          ) : (
            <DownloadIcon aria-hidden data-icon="inline-start" />
          )}
          {t('audit.export.button')}
        </Button>
      </div>
      {hint && (
        <p id="audit-export-block" className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {busy ? t('audit.export.busy') : done ? t('audit.export.done') : null}
      </p>
      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
