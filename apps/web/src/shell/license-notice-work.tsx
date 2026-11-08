'use client';

import { licenseNoticeWork, MODULE_REGISTRY, type LicenseNotice } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useCapabilityName } from './use-capability-name';

/**
 * What stops and what continues for one license notice (spec 0009, AC-17), worded from
 * `licenseNoticeWork` over the module registry. A part with nothing in it draws nothing, so a
 * notice with no capabilities to name keeps its plain banner text. Never shown to a person without
 * `settings.manage`: the banner that holds it is already gated.
 */
export function LicenseNoticeWork({ notice, lapse }: { notice: LicenseNotice; lapse: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const name = useCapabilityName();
  const { stops, continues } = licenseNoticeWork(MODULE_REGISTRY, notice);
  if (stops.length === 0 && continues.length === 0) return null;
  const separator = t('shell.modules.listSeparator');
  const stopsKey =
    notice.phase === 'expiring' || notice.phase === 'grace'
      ? 'settings.license.banner.stopsAhead'
      : 'settings.license.banner.stopsDone';
  const continuing = continues.map((work) => {
    switch (work.until) {
      case 'wind_down_end':
        return work.untilOn === null
          ? t('settings.license.banner.continuesOpen', { name: name(work.capability) })
          : t('settings.license.banner.continuesUntil', {
              name: name(work.capability),
              date: format.dateOnly(work.untilOn),
            });
      case 'open_items_closed':
        return t('settings.license.banner.continuesOpen', { name: name(work.capability) });
    }
  });

  return (
    <div className="basis-full space-y-1 ps-7 text-muted-foreground">
      {stops.length > 0 && <p>{t(stopsKey, { lapse, what: stops.map(name).join(separator) })}</p>}
      {continuing.length > 0 && (
        <p>{t('settings.license.banner.continues', { what: continuing.join(separator) })}</p>
      )}
    </div>
  );
}
