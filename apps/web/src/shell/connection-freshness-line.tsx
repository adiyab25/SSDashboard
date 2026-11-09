'use client';

import type { ConnectionFreshnessItem } from '@ssdashboard/contracts';
import { cn } from '@ssdashboard/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { connectionFreshnessKey, getConnectionFreshness } from './connection-freshness-api';

const MINUTE_MS = 60_000;

/** True when the line must warn: a late or failing connection, or any failed write or order. */
function needsWarning(item: ConnectionFreshnessItem): boolean {
  return item.state !== 'fresh' || item.failedCommands > 0 || item.failedOrderEvents > 0;
}

/**
 * The freshness line of the back office (spec 0015, AC-18), drawn under the top bar for every hat
 * with `orders.view`: per active Shopify connection, "Shopify Essentials: last order 3 minutes
 * ago, checked 2 minutes ago", then "2 Shopify writes failed" and "1 order failed to arrive" while
 * those counts are above 0, and the words "Tell the manager." when the connection is late or
 * failing or a count is above 0. It reads `GET /api/connections/freshness` once a minute and
 * measures every age against the answer's `asOf`, never the browser clock. Nothing shows without
 * `orders.view`, while loading, when the call fails, or while there is no connection: the line is
 * a nudge, never a blocker. The visible text changes every minute, so it is not a live region; a
 * separate hidden polite status carries only the warnings, so it speaks when one appears or
 * changes and never on a plain poll. It must never show a credential or a customer's data.
 */
export function ConnectionFreshnessLine() {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const access = useAccess();
  const query = useQuery({
    queryKey: connectionFreshnessKey,
    queryFn: ({ signal }) => getConnectionFreshness(signal),
    enabled: access.can('orders.view'),
    refetchInterval: MINUTE_MS,
    staleTime: MINUTE_MS,
  });
  const answer = query.data;
  if (!access.can('orders.view') || !answer || answer.items.length === 0) return null;

  const asOf = Date.parse(answer.asOf);

  /** "3 minutes ago", counted against the server's instant (a later instant counts as just now). */
  const ago = (instant: string): string => {
    const minutes = Math.max(0, Math.floor((asOf - Date.parse(instant)) / MINUTE_MS));
    if (minutes < 1) return t('shell.freshness.justNow');
    if (minutes < 60) {
      return t('shell.freshness.minutesAgo', { count: minutes, n: format.quantity(minutes) });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return t('shell.freshness.hoursAgo', { count: hours, n: format.quantity(hours) });
    }
    const days = Math.floor(hours / 24);
    return t('shell.freshness.daysAgo', { count: days, n: format.quantity(days) });
  };

  /** The state and the failed counts in words, without times; empty when nothing is wrong. */
  const problems = (item: ConnectionFreshnessItem): string => {
    const parts: string[] = [];
    if (item.state === 'failing') parts.push(t('shell.freshness.stateFailing'));
    else if (item.state === 'late') parts.push(t('shell.freshness.stateLate'));
    if (item.failedCommands > 0) {
      const count = item.failedCommands;
      parts.push(t('shell.freshness.failedCommands', { count, n: format.quantity(count) }));
    }
    if (item.failedOrderEvents > 0) {
      const count = item.failedOrderEvents;
      parts.push(t('shell.freshness.failedOrders', { count, n: format.quantity(count) }));
    }
    return parts.join(t('shell.modules.listSeparator'));
  };

  const storeName = (item: ConnectionFreshnessItem) =>
    text(item.storePublicName, t('shell.freshness.storeFallback'));

  const spoken = answer.items
    .filter(needsWarning)
    .map((item) => `${storeName(item)}: ${problems(item)}. ${t('shell.freshness.tellManager')}`)
    .join(' ');

  return (
    <section aria-label={t('shell.freshness.label')} className="border-b">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {spoken}
      </p>
      <ul className="divide-y">
        {answer.items.map((item) => {
          const warn = needsWarning(item);
          const order = item.lastOrderAt
            ? t('shell.freshness.lastOrder', { when: ago(item.lastOrderAt) })
            : t('shell.freshness.noOrder');
          const checked = item.lastSweepAt
            ? t('shell.freshness.checked', { when: ago(item.lastSweepAt) })
            : t('shell.freshness.neverChecked');
          return (
            <li
              key={item.connectionId}
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-sm',
                warn
                  ? 'border-s-4 border-s-warning bg-card text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {warn && <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />}
              <p className="min-w-0 flex-1">
                {t('shell.freshness.line', { store: storeName(item), order, checked })}
                {warn && (
                  <span className="font-semibold">
                    {' '}
                    <span className="sr-only">{t('shell.freshness.warningLabel')}: </span>
                    {problems(item)}. {t('shell.freshness.tellManager')}
                  </span>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
