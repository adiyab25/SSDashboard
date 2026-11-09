'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { getOnlineStatus, inventoryKeys } from './inventory-api';

/**
 * The standing line of the Stock and Locations pages (spec 0011 AC-20): "No location feeds online
 * stock: Shopify is not being updated", shown exactly while `GET /api/stock/online-status` answers
 * no online location. `linkToGate` adds the link to the Locations page, where the gate opens, for
 * a person holding `catalog.manage`; the Locations page itself passes false. It draws nothing
 * while loading or when the read fails, and it only explains.
 */
export function OnlineStatusNotice({ linkToGate }: { linkToGate: boolean }) {
  const { t } = useTranslation();
  const access = useAccess();
  const status = useQuery({
    queryKey: inventoryKeys.onlineStatus,
    queryFn: ({ signal }) => getOnlineStatus(signal),
  });
  if (!status.data || status.data.onlineLocation !== null) return null;

  return (
    <section aria-label={t('inventory.onlineGate.noticeLabel')}>
      <Alert>
        <TriangleAlertIcon aria-hidden />
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {t('inventory.onlineGate.notice')}
          {linkToGate && access.can('catalog.manage') && (
            <Button asChild size="sm" variant="outline">
              <Link href="/locations">{t('inventory.onlineGate.noticeLink')}</Link>
            </Button>
          )}
        </AlertDescription>
      </Alert>
    </section>
  );
}
