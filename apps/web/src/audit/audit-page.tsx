'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { AuditView } from './audit-view';

/**
 * The audit trail page (spec 0010, AC-12, AC-18). Opened by its address without `audit.read` (the
 * manager hat, spec 0008) it shows the no access state and asks the api for nothing; the api
 * enforces the permission too. If the who am I call fails it shows an error with Try again.
 */
export function AuditPage() {
  const access = useAccess();
  const allowed = access.can('audit.read');

  if (access.failed) return <AccessErrorState titleKey="audit.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="audit.title" />;
  return <AuditView enabled={allowed} />;
}
