'use client';

import { SidebarMenuBadge } from '@ssdashboard/ui/components/sidebar';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useTaskSummary } from './use-task-summary';

/**
 * The overdue count beside My work in the navigation (spec 0016, AC-7). Nothing shows while the
 * count is 0, while it loads, when the call fails, or for a person without `tasks.work`. The digit
 * is hidden from screen readers in favor of a full sentence, so the count never reads as a bare
 * number. It sits after the link inside the same menu item.
 */
export function MyWorkNavBadge() {
  const { t } = useTranslation();
  const format = useFormat();
  const { summary } = useTaskSummary();
  const overdue = summary?.mine.overdue ?? 0;
  if (overdue <= 0) return null;
  const n = format.quantity(overdue);
  return (
    <SidebarMenuBadge>
      <span aria-hidden>{n}</span>
      <span className="sr-only">{t('tasks.nav.overdue', { count: overdue, n })}</span>
    </SidebarMenuBadge>
  );
}
