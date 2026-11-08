'use client';

import { InternalHat } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { StaffNoticeRow } from './staff-notice-row';
import { useModuleStates } from './use-module-states';

/**
 * The neutral notice for staff whose work stops at a lapse (spec 0009, AC-17), drawn under the
 * top bar beside the manager's license banner: "From 15 April the confirmation queue stops. Ask
 * your manager." It comes from the `staffNotices` of `GET /api/platform/modules`, shows only to a
 * person who wears an internal hat (wave 1 review W8: a partner or media buyer never sees a lapse
 * notice, whatever the answer holds), and never shows a price or a commercial term.
 */
export function StaffNoticeBanner() {
  const { t } = useTranslation();
  const access = useAccess();
  const { answer } = useModuleStates();
  const internal = access.hats.some((hat) => InternalHat.safeParse(hat).success);
  const notices = internal ? (answer?.staffNotices ?? []) : [];
  if (notices.length === 0) return null;

  return (
    <section aria-label={t('shell.modules.staffNotice.label')} className="border-b">
      <ul className="divide-y">
        {notices.map((notice) => (
          <StaffNoticeRow key={notice.bundle} notice={notice} />
        ))}
      </ul>
    </section>
  );
}
