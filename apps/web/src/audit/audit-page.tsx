'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { AuditEntriesTable } from './audit-entries-table';
import { auditKeys, listAuditEntries, type AuditFilter } from './audit-api';

/** Milestone 1 sends no filter; milestone 3 replaces this with the filter bar's state. */
const NO_FILTER: AuditFilter = {};

/**
 * The audit trail (spec 0010, AC-12, AC-18): every recorded change, newest first, 50 a page with
 * Load more. Needs `audit.read` (the manager hat, spec 0008); the api answers 403 to anyone else and this page says so instead of
 * showing a broken table. Read only: there is no way to edit an entry from here.
 */
export function AuditPage() {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: auditKeys.list(NO_FILTER),
    queryFn: ({ pageParam, signal }) => listAuditEntries(NO_FILTER, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const endRef = useRef<HTMLParagraphElement>(null);
  const wantsEnd = useRef(false);
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  // Load more unmounts on the last page, so focus moves to the end of list line, not to body.
  const atEnd = !query.hasNextPage;
  useEffect(() => {
    if (wantsEnd.current && atEnd) {
      wantsEnd.current = false;
      endRef.current?.focus();
    }
  }, [atEnd, rows.length]);

  if (forbidden) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('audit.forbidden')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('audit.description')}</p>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('audit.loadError')}
            <Button
              size="sm"
              variant="outline"
              aria-disabled={query.isFetching}
              aria-busy={query.isFetching}
              onClick={() => {
                if (!query.isFetching) void query.refetch();
              }}
            >
              {query.isFetching && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('audit.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <AuditEntriesTable rows={rows} loading={query.isPending} />
      )}

      {query.isFetchNextPageError && (
        <Alert variant="destructive">
          <AlertDescription>{t('audit.loadMoreError')}</AlertDescription>
        </Alert>
      )}
      {query.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          aria-disabled={query.isFetchingNextPage}
          aria-busy={query.isFetchingNextPage}
          onClick={() => {
            if (query.isFetchingNextPage) return;
            wantsEnd.current = true;
            void query.fetchNextPage();
          }}
        >
          {query.isFetchingNextPage && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('audit.loadMore')}
        </Button>
      )}
      {atEnd && rows.length > 0 && !query.isPending && (
        <p
          ref={endRef}
          tabIndex={-1}
          className="text-center text-sm text-muted-foreground outline-none focus-ring"
        >
          {t('audit.endOfList')}
        </p>
      )}
    </div>
  );
}
