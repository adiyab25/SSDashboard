'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { CUSTOMER_SEARCH_RATE_LIMITED } from '@ssdashboard/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FlagIcon, LoaderCircleIcon, SearchIcon, UsersRoundIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { customerKeys, searchCustomers } from './customers-api';
import { classifyCustomerSearch } from './customer-search-input';
import { CustomerResultsTable } from './customer-results-table';

/** What was searched: kept in component state only, never in the address (spec 0014, AC-3). */
interface Submitted {
  kind: 'phone' | 'name' | 'flagged';
  text: string;
}

/**
 * The Search tab of the customers screen (spec 0014, AC-3, AC-5, AC-18): one box that takes a phone in any form or a
 * piece of a name, sent as a POST body when the person presses Search. Neither the phone nor the
 * name is put in the address, the query string, or browser history; results page by cursor.
 */
export function CustomerSearchPanel({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [inputError, setInputError] = useState<'nameTooShort' | 'nameTooLong' | null>(null);

  const query = useInfiniteQuery({
    queryKey: customerKeys.search(submitted?.kind ?? 'phone', submitted?.text ?? ''),
    queryFn: ({ pageParam, signal }) =>
      searchCustomers(
        submitted?.kind === 'flagged'
          ? { flagged: true }
          : submitted?.kind === 'phone'
            ? { phone: submitted.text }
            : { nameContains: submitted?.text ?? '' },
        pageParam,
        signal,
      ),
    enabled: enabled && submitted !== null,
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const input = classifyCustomerSearch(typed);
    switch (input.kind) {
      case 'empty':
        setInputError(null);
        return;
      case 'name-too-short':
        setInputError('nameTooShort');
        return;
      case 'name-too-long':
        setInputError('nameTooLong');
        return;
      case 'phone':
      case 'name':
        setInputError(null);
        // The same search again has the same query key, so ask the api again by hand.
        if (submitted?.kind === input.kind && submitted.text === input.text) {
          void query.refetch();
        } else {
          setSubmitted({ kind: input.kind, text: input.text });
        }
        return;
    }
  };

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const searching = submitted !== null && query.isPending && enabled;
  const failure = query.error instanceof ApiError ? query.error : null;
  // A failed Load more keeps the rows already shown and says so beside its button only.
  const nextPageFailed = query.isFetchNextPageError;
  const rateLimited = failure?.status === 429 || failure?.code === CUSTOMER_SEARCH_RATE_LIMITED;
  const errorKey =
    inputError ??
    (nextPageFailed
      ? null
      : rateLimited
        ? 'rateLimited'
        : failure?.code === 'INVALID_PHONE'
          ? 'invalidPhone'
          : failure?.code === 'INVALID_QUERY'
            ? 'invalidQuery'
            : null);
  const count = rows.length;
  const statusText = !query.data
    ? ''
    : query.hasNextPage
      ? t('customers.search.foundMore', { count })
      : t('customers.search.found', { count });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form role="search" onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
        <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-md">
          <label htmlFor="customer-search" className="text-sm font-medium">
            {t('customers.search.label')}
          </label>
          <Input
            id="customer-search"
            type="search"
            value={typed}
            autoComplete="off"
            aria-invalid={errorKey !== null}
            aria-describedby={
              errorKey ? 'customer-search-hint customer-search-error' : 'customer-search-hint'
            }
            onChange={(event) => setTyped(event.target.value)}
          />
          <span id="customer-search-hint" className="text-xs text-muted-foreground">
            {t('customers.search.hint')}
          </span>
        </div>
        <Button type="submit">
          <SearchIcon aria-hidden data-icon="inline-start" />
          {t('customers.search.submit')}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-pressed={submitted?.kind === 'flagged'}
          onClick={() => {
            setInputError(null);
            if (submitted?.kind === 'flagged') setSubmitted(null);
            else setSubmitted({ kind: 'flagged', text: '' });
          }}
        >
          <FlagIcon aria-hidden data-icon="inline-start" />
          {t('customers.search.flaggedShow')}
        </Button>
      </form>

      {errorKey && (
        <p id="customer-search-error" role="alert" className="text-sm text-destructive">
          {t(`customers.search.${errorKey}`)}
        </p>
      )}

      {submitted === null && (
        <div className="flex flex-col items-center gap-3 rounded-lg border px-4 py-10 text-center">
          <UsersRoundIcon aria-hidden className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{t('customers.search.promptTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('customers.search.promptBody')}</p>
          </div>
        </div>
      )}

      {searching && (
        <div className="flex flex-col gap-2" aria-busy aria-hidden>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {query.isError && !errorKey && !nextPageFailed && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('customers.search.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('customers.search.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {statusText}
      </p>

      {query.data && (
        <>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1 rounded-lg border px-4 py-10 text-center">
              <p className="font-medium">
                {t(
                  submitted?.kind === 'flagged'
                    ? 'customers.search.noFlaggedTitle'
                    : 'customers.search.noMatchTitle',
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  submitted?.kind === 'flagged'
                    ? 'customers.search.noFlaggedBody'
                    : 'customers.search.noMatchBody',
                )}
              </p>
            </div>
          ) : (
            <CustomerResultsTable rows={rows} />
          )}
        </>
      )}

      {nextPageFailed && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {rateLimited ? t('customers.search.rateLimited') : t('customers.search.loadMoreError')}
          </p>
          <Button size="sm" variant="outline" onClick={() => void query.fetchNextPage()}>
            {t('customers.search.retry')}
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
          {t('customers.search.loadMore')}
        </Button>
      )}
    </div>
  );
}
