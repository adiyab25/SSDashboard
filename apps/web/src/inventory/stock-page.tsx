'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { StockView } from './stock-view';

/**
 * The stock on hand page. Opened by its address without `stock.view` it shows the no access state and asks the api for
 * nothing (spec 0008, AC-11); the api enforces the permission too.
 */
export function StockPage() {
  const access = useAccess();
  const allowed = access.can('stock.view');

  if (access.failed)
    return <AccessErrorState titleKey="inventory.stock.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="inventory.stock.title" />;
  return <StockView enabled={allowed} />;
}
