'use client';

import { useTranslation } from 'react-i18next';
import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { MyWorkList } from './my-work-list';

/**
 * My work at `/my-work` (spec 0016, AC-14): the one `<h1>` and the person's task list. Opened by
 * its address without `tasks.work` it shows the no access state and asks the api for nothing
 * (spec 0008, AC-11); the api enforces the permission too, and the module gate of the shell
 * explains a `tasks` module that is off.
 */
export function MyWorkPage() {
  const { t } = useTranslation();
  const access = useAccess();
  const allowed = access.can('tasks.work');

  if (access.failed) return <AccessErrorState titleKey="tasks.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="tasks.title" />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('tasks.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('tasks.description')}</p>
      </div>
      <MyWorkList enabled={allowed} />
    </div>
  );
}
