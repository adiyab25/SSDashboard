'use client';

import type { LicenseBundleView } from '@ssdashboard/contracts';
import { Badge } from '@ssdashboard/ui/components/badge';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useBundleName } from './use-bundle-name';

/** Props of `LicenseBundleRow`. */
interface LicenseBundleRowProps {
  /** One plan, or Core, which is always on and has no expiry. */
  view: LicenseBundleView | 'core';
}

/**
 * One plan in the Modules and license section (spec 0009, AC-25, AC-26): its name, its phase as a
 * word and a sentence, and its expiry (or that it never ends), the days left, and when it stops.
 * Core is always on. The phase is a word as well as a colour, so it never rests on colour alone.
 */
export function LicenseBundleRow({ view }: LicenseBundleRowProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const name = useBundleName();

  if (view === 'core') {
    return (
      <li className="flex flex-col gap-1 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-medium">{name('core')}</h4>
          <Badge variant="secondary">{t('settings.license.coreAlways')}</Badge>
        </div>
      </li>
    );
  }

  const ended = view.daysLeft !== null && view.daysLeft < 0;
  const warn = view.phase === 'expiring' || view.phase === 'grace';
  const bad = view.phase === 'wind_down' || view.phase === 'off';

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium">{name(view.bundle)}</h4>
        <Badge
          variant={bad ? 'destructive' : view.phase === 'active' ? 'secondary' : 'outline'}
          className={warn ? 'border-transparent bg-warning/10 text-warning' : undefined}
        >
          {t(`settings.license.phases.${view.phase}`)}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(`settings.license.phaseHints.${view.phase}`)}
      </p>
      {view.phase !== 'not_licensed' && (
        <div className="flex flex-col gap-0.5 text-sm">
          <p>
            {view.perpetual || view.expiresOn === null
              ? t('settings.license.perpetual')
              : ended
                ? t('settings.license.endedOn', { date: format.dateOnly(view.expiresOn) })
                : t('settings.license.endsOn', { date: format.dateOnly(view.expiresOn) })}
          </p>
          {view.daysLeft !== null && !ended && (
            <p>{t('settings.license.daysLeft', { days: format.quantity(view.daysLeft) })}</p>
          )}
          {view.lapsesAt !== null && (view.phase === 'expiring' || view.phase === 'grace') && (
            <p>{t('settings.license.stopsAt', { date: format.dateTime(view.lapsesAt) })}</p>
          )}
        </div>
      )}
    </li>
  );
}
