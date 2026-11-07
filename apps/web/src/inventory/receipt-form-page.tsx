'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { ReceiptFormSkeleton } from './receipt-form-skeleton';
import { ReceiptFormView } from './receipt-form-view';

/**
 * The new stock receipt form. Opened by its address without `stock.receive` it shows the no access state and asks the api for
 * nothing (spec 0008, AC-11); the form mounts only once the person is known to hold it, with a
 * skeleton under the title until then and an error with Try again if the who am I call fails; the api enforces the permission too.
 */
export function ReceiptFormPage() {
  const access = useAccess();
  const allowed = access.can('stock.receive');

  if (access.failed)
    return <AccessErrorState titleKey="inventory.receipt.newTitle" onRetry={access.retry} />;
  if (access.ready && !allowed) return <NoAccessState titleKey="inventory.receipt.newTitle" />;
  if (!access.ready) return <ReceiptFormSkeleton />;
  return <ReceiptFormView />;
}
