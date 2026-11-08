'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { ConnectStoreForm } from './connect-store-form';

/**
 * The connect form page at `/connections/new` (spec 0015, AC-1, AC-27). Opened by its address
 * without `settings.manage` it shows the no access state and renders no form; the api enforces the
 * permission too. If the who am I call fails it shows an error with Try again.
 */
export function ConnectStoreFormPage() {
  const access = useAccess();

  if (access.failed) {
    return <AccessErrorState titleKey="connections.form.title" onRetry={access.retry} />;
  }
  if (access.ready && !access.can('settings.manage')) {
    return <NoAccessState titleKey="connections.form.title" />;
  }
  if (!access.ready) return null;
  return <ConnectStoreForm />;
}
