'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { NewOrderSkeleton } from './new-order-skeleton';
import { NewOrderView } from './new-order-view';

/**
 * The new order form. Opened by its address without `orders.confirm` it shows the no access state
 * and asks the api for nothing; the api enforces it too (`orders.gift` for a gifted order).
 */
export function NewOrderPage() {
  const access = useAccess();
  const allowed = access.can('orders.confirm');

  if (access.failed) return <AccessErrorState titleKey="orders.new.title" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="orders.new.title" />;
  if (!access.ready) return <NewOrderSkeleton />;
  return <NewOrderView />;
}
