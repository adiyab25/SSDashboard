'use client';

import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@ssdashboard/ui/components/sidebar';
import { RefreshCwOffIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useTaskSummary } from './use-task-summary';

/** The order list address with the hold filter on (spec 0016, AC-7). */
export const UNSYNCED_EDITS_HREF = '/orders?hold=1';

/**
 * The unsynced edits badge of the navigation (spec 0016, AC-7): its own link, after My work, to
 * the order list filtered to orders on hold, with the count of order edits that did not reach
 * Shopify. It shows only when the summary carries `unsyncedEdits` (the api sends it to
 * `orders.confirm` holders alone) and the count is above 0, so it never shows to a person without
 * `tasks.work`, while loading, or when the call fails. A count and an address only: no order data.
 */
export function UnsyncedEditsNavItem() {
  const { t } = useTranslation();
  const format = useFormat();
  const { summary } = useTaskSummary();
  const count = summary?.unsyncedEdits ?? 0;
  if (count <= 0) return null;
  const n = format.quantity(count);
  const label = t('tasks.nav.unsyncedLabel');
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={label}
        className="coarse:h-touch coarse:group-data-[collapsible=icon]:size-touch!"
      >
        <Link href={UNSYNCED_EDITS_HREF}>
          <RefreshCwOffIcon aria-hidden />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        <span aria-hidden>{n}</span>
        <span className="sr-only">{t('tasks.nav.unsyncedCount', { count, n })}</span>
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}
