'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/auth/use-me';
import { LocationsView } from './locations-view';

/**
 * The Locations page, admins only (spec 0006, AC-4): warehouses and shops with an active
 * or archived filter, edit, archive, unarchive, delete, and create. The api enforces the role
 * too; staff never see this page in the navigation.
 */
export function LocationsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const isAdmin = me?.permissions.includes('catalog.manage') ?? false;

  if (me && !isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('inventory.locations.title')}</h1>
        <Alert>
          <AlertDescription>{t('inventory.locations.adminOnly')}</AlertDescription>
        </Alert>
      </div>
    );
  }
  return <LocationsView enabled={isAdmin} />;
}
