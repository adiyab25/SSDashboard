'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { MergeView } from './merge-view';

/**
 * The merge screen. Opened by its address without `customers.merge` it shows the no access state
 * and asks the api for nothing (spec 0008, AC-11; spec 0014, AC-18); the api enforces it too.
 */
export function MergePage() {
  const access = useAccess();
  const allowed = access.can('customers.merge');

  if (access.failed)
    return <AccessErrorState titleKey="customers.merge.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="customers.merge.title" />;
  return <MergeView enabled={allowed} />;
}
