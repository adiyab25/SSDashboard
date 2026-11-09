'use client';

import type { MergeSuggestionPage } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import {
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { CheckCheckIcon, LoaderCircleIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useFormat } from '@/i18n/use-format';
import { customerKeys, dismissMergeSuggestion } from './customers-api';
import { mergeErrorKey } from './merge-error-key';
import { MergeSuggestionsTable } from './merge-suggestions-table';

interface Props {
  /** The paged suggestion query, owned by the customers screen so its tab can show the count. */
  query: UseInfiniteQueryResult<InfiniteData<MergeSuggestionPage>, Error>;
  /** True for a holder of `customers.merge`: only then are Merge and Dismiss offered. */
  canMerge: boolean;
}

/**
 * The To review tab (spec 0014, AC-9): the open merge suggestions oldest first, each with one tap
 * Merge (it opens the merge page with the pair and the suggestion filled in) and Dismiss. A
 * dismissed suggestion leaves the list and focus moves to the summary line, so a keyboard person
 * is not dropped at the top of the page. Failures read as translated messages; nothing personal
 * is logged.
 */
export function MergeSuggestionsPanel({ query, canMerge }: Props) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const summary = useRef<HTMLParagraphElement>(null);

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const openCount = query.data?.pages[0]?.openCount ?? 0;

  async function dismiss(id: string) {
    setBusyId(id);
    try {
      await dismissMergeSuggestion(id, {});
      toast.success(t('customers.review.dismissed'));
    } catch (error) {
      toast.error(t(mergeErrorKey(error)));
    } finally {
      await queryClient.invalidateQueries({ queryKey: customerKeys.suggestions });
      setBusyId(null);
      summary.current?.focus();
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{t('customers.review.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('customers.review.description')}</p>
      </div>

      <p
        ref={summary}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none empty:hidden"
      >
        {query.data ? t('customers.review.summary', { number: format.number(openCount) }) : ''}
      </p>

      {query.isPending && query.fetchStatus !== 'idle' && (
        <div className="flex flex-col gap-2" aria-busy aria-hidden>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {query.isError && !query.data && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('customers.review.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('customers.review.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.data &&
        (rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border px-4 py-10 text-center">
            <CheckCheckIcon aria-hidden className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">{t('customers.review.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('customers.review.emptyBody')}</p>
            </div>
          </div>
        ) : (
          <MergeSuggestionsTable
            rows={rows}
            canMerge={canMerge}
            busyId={busyId}
            onDismiss={(id) => void dismiss(id)}
          />
        ))}

      {query.isFetchNextPageError && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t('customers.review.loadMoreError')}
          </p>
          <Button size="sm" variant="outline" onClick={() => void query.fetchNextPage()}>
            {t('customers.review.retry')}
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
          {t('customers.review.loadMore')}
        </Button>
      )}
    </>
  );
}
