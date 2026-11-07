'use client';

import type { LicenseCheckOutcome } from '@ssdashboard/contracts';
import { cn } from '@ssdashboard/ui/lib/utils';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { LEVEL_LOOK } from './license-level-look';

/**
 * The banner row for a failed check of the license file (spec 0009, AC-16): the "Action needed"
 * word, the outcome's own sentence (the one the section shows), and the link to the license
 * section. Recorded licenses keep counting, which the section says in full.
 */
export function LicenseProblemRow({ outcome }: { outcome: LicenseCheckOutcome }) {
  const { t } = useTranslation();
  const look = LEVEL_LOOK.critical;
  const Icon = look.icon;

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-s-4 bg-card px-4 py-2 text-sm',
        look.border,
      )}
    >
      <Icon aria-hidden className={cn('size-4 shrink-0', look.tint)} />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t('settings.license.banner.levels.critical')}</span>{' '}
        {t(`settings.license.outcomes.${outcome}`)}
      </p>
      <Link href="/settings#license" className="font-medium underline underline-offset-4">
        {t('settings.license.banner.link')}
      </Link>
    </li>
  );
}
