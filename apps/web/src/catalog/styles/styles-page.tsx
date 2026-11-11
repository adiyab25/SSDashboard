'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { StylesView } from './styles-view';

/**
 * The style list. Opened by its address without `stock.view` it shows the no access state and
 * asks the api for nothing (spec 0012, AC-16, AC-18); the api enforces the permission too.
 */
export function StylesPage() {
  const access = useAccess();
  const allowed = access.can('stock.view');

  if (access.failed)
    return <AccessErrorState titleKey="catalog.styles.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="catalog.styles.title" />;
  return <StylesView enabled={allowed} />;
}
