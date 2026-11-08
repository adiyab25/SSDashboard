'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { OrdersView } from './orders-view';

/**
 * The order list. Opened by its address without `orders.view` it shows the no access state and
 * asks the api for nothing (spec 0008, AC-11); the api enforces it too.
 */
export function OrdersPage() {
  const access = useAccess();
  const allowed = access.can('orders.view');

  if (access.failed) return <AccessErrorState titleKey="orders.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="orders.title" />;
  return <OrdersView enabled={allowed} />;
}
