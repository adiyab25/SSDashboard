'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { auditKeys, listRecordHistory } from './audit-api';
import { AuditEntriesTable } from './audit-entries-table';
import { AuditPager } from './audit-pager';

/**
 * The history of one record (spec 0010, AC-12, AC-13): every audit entry of that record, newest
 * first, with Load more. The reusable block other record screens embed under their own heading
 * level; it draws an `h2` and never an `h1`. Needs `audit.read` (the manager hat, spec 0008): the
 * api answers 403 to anyone else and the panel says so. Loading, empty, error with retry, and 403 are all drawn. Read only.
 */
export function RecordHistoryPanel({
  recordType,
  recordId,
  headingLevel = 2,
}: {
  /** The record type code, such as `stock_receipt`. */
  recordType: string;
  /** The record's id. */
  recordId: string;
  /** The level of the panel's heading: 2 on a page, 3 inside a dialog whose title is an h2. */
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: auditKeys.record(recordType, recordId),
    queryFn: ({ pageParam, signal }) => listRecordHistory(recordType, recordId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const headingId = `audit-history-${recordId}`;
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <Heading id={headingId} className="text-base font-semibold">
        {t('audit.history.title')}
      </Heading>
      {forbidden ? (
        <p className="text-sm text-muted-foreground">{t('audit.history.forbidden')}</p>
      ) : query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('audit.history.loadError')}
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
        <>
          <AuditEntriesTable
            rows={rows}
            loading={query.isPending}
            labelledBy={headingId}
            emptyText={t('audit.history.empty')}
          />
          <AuditPager
            rowCount={rows.length}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            isFetchNextPageError={query.isFetchNextPageError}
            fetchNextPage={() => void query.fetchNextPage()}
          />
        </>
      )}
    </section>
  );
}
