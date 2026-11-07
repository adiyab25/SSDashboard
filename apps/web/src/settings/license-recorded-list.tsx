'use client';

import type { RecordedLicenseView } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useBundleName } from './use-bundle-name';

/** Props of `LicenseRecordedList`. */
interface LicenseRecordedListProps {
  /** Every recorded license, newest first, as the api sent them. */
  licenses: readonly RecordedLicenseView[];
}

/**
 * The recorded licenses (spec 0009, AC-26): the license id, where it came from, when it was issued
 * and recorded, and what it grants with its expiry. Shows a sentence when there are none. It never
 * shows a signature or a file path: the api does not send them.
 */
export function LicenseRecordedList({ licenses }: LicenseRecordedListProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const name = useBundleName();

  if (licenses.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.license.recordedEmpty')}</p>;
  }

  return (
    <ul className="divide-y rounded-lg border">
      {licenses.map((license) => (
        <li key={license.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
          <p className="font-medium">
            <LtrText>{license.licenseId}</LtrText>
          </p>
          <p className="text-muted-foreground">{t(`settings.license.sources.${license.source}`)}</p>
          <p className="text-muted-foreground">
            {t('settings.license.issuedOn', { date: format.dateOnly(license.issuedOn) })}
          </p>
          <p className="text-muted-foreground">
            {t('settings.license.recordedAt', { date: format.dateTime(license.recordedAt) })}
          </p>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted-foreground">{t('settings.license.grantsLabel')}</span>
            <ul className="flex flex-wrap gap-x-4">
              {license.bundles.map((bundle) => {
                const expiry =
                  bundle === 'operations'
                    ? license.operationsExpiresOn
                    : license.warehouseExpiresOn;
                return (
                  <li key={bundle}>
                    {expiry === null
                      ? t('settings.license.grantPerpetual', { bundle: name(bundle) })
                      : t('settings.license.grantUntil', {
                          bundle: name(bundle),
                          date: format.dateOnly(expiry),
                        })}
                  </li>
                );
              })}
            </ul>
          </div>
        </li>
      ))}
    </ul>
  );
}
