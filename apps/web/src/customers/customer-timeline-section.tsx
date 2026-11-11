'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import { HistoryIcon, LoaderCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CustomerTimelineEntry } from './customer-timeline-entry';
import { customerKeys, listCustomerTimeline } from './customers-api';

/**
 * The customer's one timeline (spec 0014, AC-14, AC-15): orders, merges, phones, channel ids, and
 * the flag across every id of the customer, newest first, 25 a page with Load more. It shows what
 * the api sends and nothing else: the api already applied the hat's lens. A write elsewhere on
 * the profile (merge, undo, flag) refreshes it through the `customers` query keys. Failures read
 * as translated messages with a retry; no personal data is logged.
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

  return (
    <section aria-labelledby="customer-timeline-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="customer-timeline-title" className="text-base font-semibold">
        {t('customers.profile.timeline.title')}
      </h2>

      {query.isPending && (
        <div aria-busy aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {query.isError && !query.data && (
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
          <div className="flex flex-col items-center gap-3 rounded-lg border px-4 py-10 text-center">
            <HistoryIcon aria-hidden className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">{t('customers.profile.timeline.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('customers.profile.timeline.emptyBody')}
              </p>
            </div>
          </div>
        ) : (
          <ol className="flex flex-col divide-y rounded-lg border">
            {entries.map((entry) => (
              <CustomerTimelineEntry key={`${entry.kind}:${entry.id}`} entry={entry} />
            ))}
          </ol>
        ))}

      {query.isFetchNextPageError && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t('customers.profile.timeline.loadMoreError')}
          </p>
          <Button size="sm" variant="outline" onClick={() => void query.fetchNextPage()}>
            {t('customers.profile.timeline.retry')}
          </Button>
        </div>
      )}

      {query.hasNextPage && !query.isFetchNextPageError && (
        <Button
          variant="outline"
          className="self-center"
          disabled={query.isFetchingNextPage}
          aria-busy={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
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
