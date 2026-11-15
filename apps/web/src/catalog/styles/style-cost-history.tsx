'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { CollapsingTable } from '@ssdashboard/ui/dashboard/collapsing-table';
import type { CostRecordRow } from '@ssdashboard/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { catalogKeys, listCostRecords } from '../catalog-api';

/**
 * The cost history of one style (spec 0012, AC-13, `cost.view`): every record newest first,
 * 20 a page with "Show more". Records are only ever added, so there is no edit here. Mount it
 * only for a person holding `cost.view`: it is the only place that calls the cost records route.
 */
export function StyleCostHistory({ styleId }: { styleId: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const query = useInfiniteQuery({
    queryKey: catalogKeys.costRecords(styleId),
    queryFn: ({ pageParam, signal }) => listCostRecords(styleId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  const columns = [
    {
      id: 'variant',
      header: t('catalog.cost.history.columns.variant'),
      title: true,
      cell: (row: CostRecordRow) =>
        row.variant ? <LtrText>{row.variant.code}</LtrText> : t('catalog.cost.history.styleLevel'),
    },
    {
      id: 'season',
      header: t('catalog.cost.history.columns.season'),
      cell: (row: CostRecordRow) => <LtrText>{row.season.code}</LtrText>,
    },
    {
      id: 'basis',
      header: t('catalog.cost.history.columns.basis'),
      cell: (row: CostRecordRow) => t(`catalog.cost.basis.${row.costBasis}`),
    },
    {
      id: 'unitCost',
      header: t('catalog.cost.history.columns.unitCost'),
      align: 'end' as const,
      cell: (row: CostRecordRow) => format.money(row.unitCost, 4),
    },
    {
      id: 'effectiveFrom',
      header: t('catalog.cost.history.columns.effectiveFrom'),
      cell: (row: CostRecordRow) => format.dateOnly(row.effectiveFrom),
    },
    {
      id: 'source',
      header: t('catalog.cost.history.columns.source'),
      cell: (row: CostRecordRow) =>
        row.source ? (
          row.source
        ) : (
          <span className="text-muted-foreground">{t('catalog.cost.history.noSource')}</span>
        ),
    },
    {
      id: 'recordedAt',
      header: t('catalog.cost.history.columns.recordedAt'),
      cell: (row: CostRecordRow) => format.dateTime(row.recordedAt),
    },
    {
      id: 'recordedBy',
      header: t('catalog.cost.history.columns.recordedBy'),
      cell: (row: CostRecordRow) =>
        row.recordedBy ? (
          (row.recordedBy.name ?? (
            <span className="text-muted-foreground">{t('catalog.cost.history.unknownPerson')}</span>
          ))
        ) : (
          <span className="text-muted-foreground">{t('catalog.cost.history.system')}</span>
        ),
    },
  ];

  return (
    <section aria-labelledby="style-cost-history-title" className="flex flex-col gap-3">
      <h2 id="style-cost-history-title" className="text-base font-semibold">
        {t('catalog.cost.history.title')}
      </h2>
      {query.isPending ? (
        <div aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-control w-full" />
          <Skeleton className="h-control w-full" />
        </div>
      ) : query.isError && rows.length === 0 ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('catalog.cost.history.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('catalog.common.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="rounded-card gradient-card-edge px-3 py-10 text-center text-sm text-muted-foreground">
          {t('catalog.cost.history.empty')}
        </p>
      ) : (
        <>
          <CollapsingTable
            caption={t('catalog.cost.history.tableLabel')}
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            className="sm:overflow-hidden sm:rounded-card sm:gradient-card-edge"
          />
          {query.isFetchNextPageError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t('catalog.cost.history.loadError')}</AlertDescription>
            </Alert>
          )}
          {query.hasNextPage && (
            <Button
              variant="outline"
              className="self-start"
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
              {t('catalog.cost.history.loadMore')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
