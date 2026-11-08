'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, UploadIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { getLicense, licenseKeys } from './license-api';
import { LicenseBundleRow } from './license-bundle-row';
import { LicenseLastCheck } from './license-last-check';
import { LicenseRecordedList } from './license-recorded-list';
import { LicenseResumingSteps } from './license-resuming-steps';
import { LicenseUploadDialog } from './license-upload-dialog';

/**
 * The Modules and license section of the settings screen (spec 0009, AC-25, AC-26): each plan with
 * its phase and expiry, the executing steps waiting for a renewal (`summary.resumingSteps`, AC-19), the last check of the license file, the recorded licenses, and the upload
 * button, and the module switches passed as `children` (AC-25: one section). It loads
 * `GET /api/platform/license` itself (`enabled` waits for access), so a failure here never hides the other sections, and it shows loading, an error with Try again, and the
 * empty state of an install with no license recorded. A 403 shows a sentence in place of the body;
 * the page's own gate decides who reaches the screen. Its anchor is `#license`, which the shell's
 * banner links to.
 */
export function LicenseSection({
  enabled,
  children,
}: {
  enabled: boolean;
  /** The module switches, drawn under the section's heading before the plans. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const base = useId();
  const query = useQuery({
    queryKey: licenseKeys.all,
    queryFn: ({ signal }) => getLicense(signal),
    enabled,
  });
  const [uploading, setUploading] = useState(false);
  const summary = query.data;
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  return (
    <section
      id="license"
      aria-labelledby={`${base}-title`}
      className="flex min-w-0 scroll-mt-20 flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${base}-title`} className="text-base font-semibold">
            {t('settings.sections.license')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('settings.license.description')}</p>
        </div>
        <Button variant="outline" size="sm" disabled={forbidden} onClick={() => setUploading(true)}>
          <UploadIcon aria-hidden data-icon="inline-start" />
          {t('settings.license.upload.open')}
        </Button>
      </div>

      {children}

      {query.isError && !summary ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {forbidden ? t('settings.dialog.errors.FORBIDDEN') : t('settings.license.loadError')}
            {!forbidden && (
              <Button
                size="sm"
                variant="outline"
                aria-disabled={query.isFetching}
                aria-busy={query.isFetching}
                onClick={() => {
                  if (!query.isFetching) void query.refetch();
                }}
              >
                {query.isFetching && (
                  <LoaderCircleIcon
                    aria-hidden
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                  />
                )}
                {t('settings.retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : !summary ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('settings.license.bundlesHeading')}</h3>
            <ul className="divide-y rounded-lg border">
              <LicenseBundleRow view="core" />
              {summary.bundles.map((view) => (
                <LicenseBundleRow key={view.bundle} view={view} />
              ))}
            </ul>
          </div>
          {summary.resumingSteps && summary.resumingSteps.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('settings.license.resumingHeading')}</h3>
              <LicenseResumingSteps steps={summary.resumingSteps} waiting />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('settings.license.lastCheckHeading')}</h3>
            <LicenseLastCheck check={summary.lastCheck} recordedCount={summary.licenses.length} />
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('settings.license.recordedHeading')}</h3>
            <LicenseRecordedList licenses={summary.licenses} />
          </div>
        </>
      )}

      {uploading && <LicenseUploadDialog onClose={() => setUploading(false)} />}
    </section>
  );
}
