'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import { HistoryIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomerTimelineEntry } from './customer-timeline-entry';
import { customerKeys, listCustomerTimeline } from './customers-api';

/**
 * The customer's one timeline (spec 0014, AC-14, AC-15): orders, merges, phones, channel ids, and
 * the flag across every id of the customer, newest first, 25 a page with Load more. It shows what
 * the api sends and nothing else: the api already applied the hat's lens. A write elsewhere on
 * the profile (merge, undo, flag) refreshes it through the `customers` query keys. Failures read
 * as translated messages with a retry (a failed refresh with entries on screen too); no personal
 * data is logged. Focus never falls to the page: after Load more it moves to the first new entry,
 * after an Undo from an entry it moves to the Timeline heading, and Load more stays focusable
 * (`aria-disabled`) while it fetches.
 */
export function CustomerTimelineSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: customerKeys.timeline(customerId),
    queryFn: ({ pageParam, signal }) => listCustomerTimeline(customerId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  /** How many entries showed when Load more was pressed; set only until the new ones arrive. */
  const focusFrom = useRef<number | null>(null);

  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || entries.length <= from) return;
    focusFrom.current = null;
    const target = listRef.current?.children[from];
    if (target instanceof HTMLElement) target.focus();
  }, [entries.length]);

  function loadMore() {
    if (query.isFetchingNextPage) return;
    focusFrom.current = entries.length;
    void query.fetchNextPage();
  }

  return (
    <section aria-labelledby="customer-timeline-title" className="flex min-w-0 flex-col gap-2">
      <h2
        id="customer-timeline-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold"
      >
        {t('customers.profile.timeline.title')}
      </h2>

      {/* A polite status that is always in the page, so a screen reader hears it fill and empty. */}
      <span className="sr-only" aria-live="polite">
        {query.isPending ? t('customers.profile.timeline.loading') : ''}
      </span>

      {query.isPending && (
        <div aria-busy aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {query.isError && !query.isFetchNextPageError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('customers.profile.timeline.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('customers.profile.timeline.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.data &&
        (entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-card gradient-card-edge px-4 py-10 text-center">
            <HistoryIcon aria-hidden className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">{t('customers.profile.timeline.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('customers.profile.timeline.emptyBody')}
              </p>
            </div>
          </div>
        ) : (
          <ol ref={listRef} className="flex flex-col divide-y rounded-card gradient-card-edge">
            {entries.map((entry) => (
              <CustomerTimelineEntry
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
                onUndone={() => headingRef.current?.focus()}
              />
            ))}
          </ol>
        ))}

      {query.isFetchNextPageError && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t('customers.profile.timeline.loadMoreError')}
          </p>
          <Button size="sm" variant="outline" onClick={loadMore}>
            {t('customers.profile.timeline.retry')}
          </Button>
        </div>
      )}

      {query.hasNextPage && !query.isFetchNextPageError && (
        <Button
          variant="outline"
          className="self-center aria-disabled:pointer-events-none aria-disabled:opacity-50"
          aria-disabled={query.isFetchingNextPage}
          aria-busy={query.isFetchingNextPage}
          onClick={loadMore}
        >
          {query.isFetchingNextPage && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('customers.profile.timeline.loadMore')}
        </Button>
      )}
    </section>
  );
}
