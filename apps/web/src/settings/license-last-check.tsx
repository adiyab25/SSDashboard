'use client';

import type { LicenseCheckView } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { CircleAlertIcon, InfoIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { isLicenseProblem } from './license-problem';

/** Props of `LicenseLastCheck`. */
interface LicenseLastCheckProps {
  /** The latest check of the license file, or null when none has run yet. */
  check: LicenseCheckView | null;
  /** How many licenses are recorded: with any, "no file configured" is information only. */
  recordedCount: number;
}

/**
 * The last check of the license file (spec 0009, AC-16, AC-26): when it ran, what started it, and
 * what it found in a plain sentence. A problem outcome shows as an alert that says recorded
 * licenses keep counting (`none_configured` with a license recorded is plain information, an
 * install on uploads alone); a server clock found behind shows as information only.
 */
export function LicenseLastCheck({ check, recordedCount }: LicenseLastCheckProps) {
  const { t } = useTranslation();
  const format = useFormat();

  if (check === null) {
    return <p className="text-sm text-muted-foreground">{t('settings.license.lastCheckNone')}</p>;
  }

  const problem = isLicenseProblem(check, recordedCount);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {t(`settings.license.lastChecks.${check.trigger}`, {
          date: format.dateTime(check.checkedAt),
        })}
      </p>
      {problem ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden />
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-medium">{t(`settings.license.outcomes.${check.outcome}`)}</span>
            <span>
              {t(
                recordedCount === 0
                  ? 'settings.license.problemHintNone'
                  : 'settings.license.problemHint',
              )}
            </span>
          </AlertDescription>
        </Alert>
      ) : (
        <p>{t(`settings.license.outcomes.${check.outcome}`)}</p>
      )}
      {check.clockBehind && (
        <p className="flex items-start gap-2 rounded-card gradient-card-edge px-3 py-2 text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('settings.license.clockBehind')}
        </p>
      )}
    </div>
  );
}
