'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { SettingsView } from './settings-view';

/**
 * The settings page (spec 0009, AC-25). Opened by its address without `settings.manage` (the
 * manager hat, spec 0008) it shows the no access state and asks the api for nothing; the api
 * enforces the permission too. If the who am I call fails it shows an error with Try again.
 */
export function SettingsPage() {
  const access = useAccess();
  const allowed = access.can('settings.manage');

  if (access.failed) return <AccessErrorState titleKey="settings.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="settings.title" />;
  return <SettingsView enabled={allowed} />;
}
