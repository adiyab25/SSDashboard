'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { CustomersView } from './customers-view';

/**
 * The customer search. Opened by its address without `customers.view` it shows the no access state
 * and asks the api for nothing (spec 0008, AC-11; spec 0014, AC-18); the api enforces it too.
 */
export function CustomersPage() {
  const access = useAccess();
  const allowed = access.can('customers.view');

  if (access.failed) return <AccessErrorState titleKey="customers.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="customers.title" />;
  return <CustomersView enabled={allowed} />;
}
