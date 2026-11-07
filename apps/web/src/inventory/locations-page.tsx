'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { LocationsView } from './locations-view';

/**
 * The Locations page, for people who may manage locations (`catalog.manage`, spec 0008; spec
 * 0006, AC-4): warehouses and shops with an active or archived filter, edit, archive, unarchive,
 * delete, and create. Opened by its address without the permission it shows the no access state
 * and asks the api for nothing; the api enforces the permission too.
 */
export function LocationsPage() {
  const access = useAccess();
  const canManage = access.can('catalog.manage');

  if (access.failed)
    return <AccessErrorState titleKey="inventory.locations.title" onRetry={access.retry} />;
  if (access.ready && !canManage) return <NoAccessState titleKey="inventory.locations.title" />;
  return <LocationsView enabled={canManage} />;
}
