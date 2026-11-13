'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, PlusIcon, SearchIcon, ShoppingBagIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { OrderFilterBar } from './order-filter-bar';
import {
  customerIdFromAddress,
  EMPTY_FILTERS,
  holdFromAddress,
  isFiltered,
  type OrderFilters,
} from './order-filters';
import { OrderResultsTable } from './order-results-table';
import { getOrderFilterOptions, listOrders, orderKeys } from './orders-api';

/**
 * The order list (spec 0013, AC-4, AC-20): newest first in keyset pages of 50 with Load more,
 * filters that apply at once, and one search box for a phone in any form or an order number. The
 * search text is sent as a POST body and kept in component state only: no typed text, phone or
 * number, ever reaches the address, a query string, or browser history. Only a customer id from
 * the customer page may arrive in the address.
 */
export function OrdersView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const access = useAccess();
  const params = useSearchParams();
  const [filters, setFilters] = useState<OrderFilters>(() => ({
    ...EMPTY_FILTERS,
    customerId: customerIdFromAddress(params.get('customerId')),
    hold: holdFromAddress(params.get('hold')),
  }));
  // The navigation link to `?hold=1` can be followed while this page is open: apply the address.
  const holdInAddress = holdFromAddress(params.get('hold'));
  const [seenHold, setSeenHold] = useState(holdInAddress);
  if (seenHold !== holdInAddress) {
    setSeenHold(holdInAddress);
    setFilters((current) => ({ ...current, hold: holdInAddress }));
  }
  const [typed, setTyped] = useState('');
  const canCreate = access.can('orders.confirm');

  // Every store and channel to filter by, Shopify ones included; `orders.view` may read them.
  const options = useQuery({
    queryKey: orderKeys.filterOptions,
    queryFn: ({ signal }) => getOrderFilterOptions(signal),
    enabled,
    retry: false,
  });

  const query = useInfiniteQuery({
    queryKey: orderKeys.list(filters),
    queryFn: ({ pageParam, signal }) => listOrders(filters, pageParam, signal),
    enabled,
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = typed.trim();
    if (q === filters.q) void query.refetch();
    else setFilters({ ...filters, q });
  };

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const failure = query.error instanceof ApiError ? query.error : null;
  const nextPageFailed = query.isFetchNextPageError;
  const rateLimited = failure?.status === 429;
  const count = rows.length;
  const statusText = !query.data
    ? ''
    : query.hasNextPage
      ? t('orders.list.shownMore', { count })
      : t('orders.list.shown', { count });
  const firstPageFailed = query.isError && !nextPageFailed;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('orders.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('orders.description')}</p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/orders/new">
              <PlusIcon aria-hidden data-icon="inline-start" />
              {t('orders.newOrder')}
            </Link>
          </Button>
        )}
      </div>

      <form role="search" onSubmit={onSearch} className="flex flex-wrap items-end gap-3" noValidate>
        <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-md">
          <label htmlFor="order-search" className="text-sm font-medium">
            {t('orders.search.label')}
          </label>
          <Input
            id="order-search"
            type="search"
            value={typed}
            autoComplete="off"
            aria-describedby="order-search-hint"
            onChange={(event) => setTyped(event.target.value)}
          />
          <span id="order-search-hint" className="text-xs text-muted-foreground">
            {t('orders.search.hint')}
          </span>
        </div>
        <Button type="submit">
          <SearchIcon aria-hidden data-icon="inline-start" />
          {t('orders.search.submit')}
        </Button>
        {filters.q && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setTyped('');
              setFilters({ ...filters, q: '' });
            }}
          >
            {t('orders.search.clear')}
          </Button>
        )}
      </form>

      <OrderFilterBar value={filters} onChange={setFilters} options={options.data ?? null} />

      {query.isPending && enabled && (
        <div className="flex flex-col gap-2" aria-busy aria-hidden>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {firstPageFailed && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {rateLimited
              ? t('orders.list.rateLimited')
              : failure?.code === 'INVALID_QUERY'
                ? t('orders.list.invalidQuery')
                : t('orders.list.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('orders.list.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {statusText}
      </p>

      {query.data &&
        (rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border px-4 py-10 text-center">
            <ShoppingBagIcon aria-hidden className="size-8 text-muted-foreground" />
            <p className="font-medium">
              {isFiltered(filters) || filters.customerId
                ? t('orders.list.noMatchTitle')
                : t('orders.list.emptyTitle')}
            </p>
            <p className="text-sm text-muted-foreground">
              {isFiltered(filters) || filters.customerId
                ? t('orders.list.noMatchBody')
                : t('orders.list.emptyBody')}
            </p>
          </div>
        ) : (
          <OrderResultsTable rows={rows} />
        ))}

      {nextPageFailed && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {rateLimited ? t('orders.list.rateLimited') : t('orders.list.loadMoreError')}
          </p>
          <Button size="sm" variant="outline" onClick={() => void query.fetchNextPage()}>
            {t('orders.list.retry')}
          </Button>
        </div>
      )}

      {query.hasNextPage && !nextPageFailed && (
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
          {t('orders.list.loadMore')}
        </Button>
      )}
    </div>
  );
}
