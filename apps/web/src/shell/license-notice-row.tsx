'use client';

import type { LicenseNotice } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { cn } from '@ssdashboard/ui/lib/utils';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { LEVEL_LOOK } from './license-level-look';

/** The notice's sentence key: one per phase that can carry a notice. */
function sentenceKey(notice: LicenseNotice): MessageKey | null {
  switch (notice.phase) {
    case 'expiring':
      return 'settings.license.banner.expiring';
    case 'grace':
      return 'settings.license.banner.grace';
    case 'wind_down':
      // Only Operations winds down, and then the api names the day cash is followed until.
      return notice.windDownEndsOn === null
        ? 'settings.license.banner.off'
        : 'settings.license.banner.wind_down';
    case 'off':
      return 'settings.license.banner.off';
    case 'active':
    case 'not_licensed':
      // A notice never carries these phases; if one ever did, it would have nothing to say.
      return null;
  }
}

/** One notice: its level in words and an icon, the sentence, and the way to the license section. */
export function LicenseNoticeRow({ notice }: { notice: LicenseNotice }) {
  const { t } = useTranslation();
  const format = useFormat();
  const look = LEVEL_LOOK[notice.level];
  const Icon = look.icon;
  const key = sentenceKey(notice);
  if (key === null) return null;
  // Work stops at the lapse instant, local midnight: say the day and the time as the install does.
  const lapse =
    notice.phase === 'expiring' || notice.phase === 'grace'
      ? format.dateTime(notice.lapsesAt)
      : format.dateOnly(notice.lapsesOn);
  const sentence = t(key, {
    bundle: t(`settings.license.bundles.${notice.bundle}`),
    expires: format.dateOnly(notice.expiresOn),
    lapse,
    until: notice.windDownEndsOn === null ? '' : format.dateOnly(notice.windDownEndsOn),
    days: format.quantity(notice.daysLeft),
  });

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-s-4 bg-card px-4 py-2 text-sm',
        look.border,
      )}
    >
      <Icon aria-hidden className={cn('size-4 shrink-0', look.tint)} />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t(`settings.license.banner.levels.${notice.level}`)}</span>{' '}
        {sentence}
      </p>
      <Link href="/settings#license" className="font-medium underline underline-offset-4">
        {t('settings.license.banner.link')}
      </Link>
    </li>
  );
}
