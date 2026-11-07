'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { getLicense, licenseKeys } from '@/settings/license-api';
import { isLicenseProblem } from '@/settings/license-problem';
import { LicenseNoticeRow } from './license-notice-row';
import { LicenseProblemRow } from './license-problem-row';

/**
 * The manager's license banner (spec 0009, AC-17), drawn under the top bar for holders of
 * `settings.manage` only: one line per plan with an expiry that is 30 days from lapsing or already
 * past it (grace, wind down, off), each with its level in words, the dates, and a link to
 * `/settings#license`; and one line naming a failed check of the license file (AC-16: every
 * problem outcome, `none_configured` only while no license has ever been recorded). Nothing shows while
 * everything is fine, while loading, or when the call fails: the banner is a nudge, never a blocker. It reads the `notices` of
 * `GET /api/platform/license` (the modules route that would also carry them is not built yet) and
 * asks nothing until the who am I answer says the person may manage settings.
 */
export function LicenseBanner() {
  const { t } = useTranslation();
  const access = useAccess();
  const query = useQuery({
    queryKey: licenseKeys.all,
    queryFn: ({ signal }) => getLicense(signal),
    enabled: access.can('settings.manage'),
    staleTime: 60_000,
  });
  const notices = query.data?.notices ?? [];
  const check = query.data?.lastCheck ?? null;
  const problem =
    check !== null && isLicenseProblem(check, query.data?.licenses.length ?? 0) ? check : null;
  if (notices.length === 0 && problem === null) return null;

  return (
    <section aria-label={t('settings.license.banner.label')} className="border-b">
      <ul className="divide-y">
        {problem && <LicenseProblemRow outcome={problem.outcome} />}
        {notices.map((notice) => (
          <LicenseNoticeRow key={notice.bundle} notice={notice} />
        ))}
      </ul>
    </section>
  );
}
