'use client';

import type { AuditEntryView } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { auditKeys, listAuditEntries, type AuditFilter } from './audit-api';
import { AuditEntriesTable } from './audit-entries-table';
import { AuditEntryDialog } from './audit-entry-dialog';
import { AuditExportControl } from './audit-export-control';
import { AuditFilterBar } from './audit-filter-bar';
import { filterFromParams, filterProblem, paramsFromFilter } from './audit-filter';
import { AuditPager } from './audit-pager';

/**
 * The audit trail body (spec 0010, AC-12, AC-15, AC-18): every recorded change, newest first, 50 a
 * page with Load more, narrowed by filters that live in the URL query so a link reproduces the
 * view. A row's Details button opens the entry with its field diff, and Export downloads the
 * current filter as CSV. `enabled` is false until the page knows the person holds `audit.read`
 * (spec 0008), so nothing is requested early; the export shows only to a person who holds
 * `audit.export`, and the person filter reads the staff list only for one who holds
 * `people.manage`. If the api still answers 403 the shared no access state shows instead of a
 * broken table. Read only: there is no way to edit an entry from here.
 */
export function AuditView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const access = useAccess();
  const router = useRouter();
  const search = useSearchParams();
  const searchText = search.toString();
  const filter = useMemo(() => filterFromParams(new URLSearchParams(searchText)), [searchText]);
  const problem = filterProblem(filter);
  const [open, setOpen] = useState<AuditEntryView | null>(null);

  const query = useInfiniteQuery({
    queryKey: auditKeys.list(filter),
    queryFn: ({ pageParam, signal }) => listAuditEntries(filter, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && problem === null,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  function apply(next: AuditFilter) {
    const qs = paramsFromFilter(next);
    router.push(qs ? `/audit?${qs}` : '/audit');
  }

  if (forbidden) return <NoAccessState titleKey="audit.title" />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('audit.description')}</p>
      </div>

      <AuditFilterBar
        applied={filter}
        onApply={apply}
        peopleEnabled={enabled && access.can('people.manage')}
      />

      {problem ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('audit.filters.problems.invalidLink')}</AlertDescription>
        </Alert>
      ) : query.isError && !query.data ? (
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
        <AuditEntriesTable rows={rows} loading={query.isPending} onOpen={setOpen} />
      )}

      <AuditPager
        rowCount={rows.length}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        isFetchNextPageError={query.isFetchNextPageError}
        fetchNextPage={() => void query.fetchNextPage()}
      />

      {enabled && access.can('audit.export') && <AuditExportControl filter={filter} />}

      {open && <AuditEntryDialog entry={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
