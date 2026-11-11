'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useAccess } from '@/access/use-access';
import { CustomerSearchPanel } from './customer-search-panel';
import {
  CustomersTabs,
  customersPanelId,
  customersTabId,
  type CustomersTab,
} from './customers-tabs';
import { customerKeys, listMergeSuggestions } from './customers-api';
import { MergeSuggestionsPanel } from './merge-suggestions-panel';

/**
 * The customers screen (spec 0014, AC-3, AC-5, AC-9, AC-18): the one `<h1>` and two tabs. Search
 * is the default; To review lists the open merge suggestions and shows how many there are. Both
 * panels stay mounted, so a typed search survives a visit to the other tab. The suggestion
 * list needs `customers.view`; merging or dismissing one needs `customers.merge`, and those
 * buttons are left out for a person without it.
 */
export function CustomersView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const format = useFormat();
  const access = useAccess();
  const [tab, setTab] = useState<CustomersTab>('search');

  const suggestions = useInfiniteQuery({
    queryKey: customerKeys.suggestions,
    queryFn: ({ pageParam, signal }) => listMergeSuggestions(pageParam, signal),
    enabled,
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const openCount = suggestions.data?.pages[0]?.openCount;
  const reviewLabel =
    openCount === undefined || openCount === 0
      ? t('customers.tabs.review')
      : t('customers.tabs.reviewCount', { number: format.number(openCount) });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('customers.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('customers.description')}</p>
      </div>

      <CustomersTabs tab={tab} onTabChange={setTab} reviewLabel={reviewLabel} />

      <div
        role="tabpanel"
        id={customersPanelId('search')}
        aria-labelledby={customersTabId('search')}
        hidden={tab !== 'search'}
        className="flex min-w-0 flex-col gap-4"
      >
        <CustomerSearchPanel enabled={enabled} />
      </div>
      <div
        role="tabpanel"
        id={customersPanelId('review')}
        aria-labelledby={customersTabId('review')}
        hidden={tab !== 'review'}
        className="flex min-w-0 flex-col gap-4"
      >
        <MergeSuggestionsPanel query={suggestions} canMerge={access.can('customers.merge')} />
      </div>
    </div>
  );
}
