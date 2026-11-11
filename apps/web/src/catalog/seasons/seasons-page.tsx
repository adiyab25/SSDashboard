'use client';

import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { GroupingListView } from '../grouping-list-view';

/**
 * The Seasons page, for people who manage the catalog (`catalog.manage`, spec 0012, AC-6, AC-16,
 * AC-18), like the Locations page: opened by its address without the permission it shows the no
 * access state and asks the api for nothing. The api enforces every write too.
 */
export function SeasonsPage() {
  const access = useAccess();
  const canManage = access.can('catalog.manage');

  if (access.failed)
    return <AccessErrorState titleKey="catalog.seasons.title" onRetry={access.retry} />;
  if (access.ready && !canManage) return <NoAccessState titleKey="catalog.seasons.title" />;
  return <GroupingListView kind="season" enabled={canManage} />;
}
