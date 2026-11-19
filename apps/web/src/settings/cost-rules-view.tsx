'use client';

import type { CostRulesResponse, OrderCostRuleKind } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  CalendarCheckIcon,
  CalendarX2Icon,
  InfoIcon,
  LoaderCircleIcon,
  PlusIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NoAccessState } from '@/access/no-access-state';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { CostRuleDialog } from './cost-rule-dialog';
import { CostRulesHistory } from './cost-rules-history';
import { costRuleKeys, listCostRules } from './cost-rules-api';
import { useCostRuleText } from './use-cost-rule-text';

/** Props of `CostRulesView`. */
interface CostRulesViewProps {
  /** False until the page knows the person holds `cost.view`, so nothing is asked early. */
  enabled: boolean;
  /** Whether the person may record a rule (`settings.manage` and `cost.view`). */
  canAdd: boolean;
}

/** The header cell classes of the rules tables (DESIGN.md, data tables). */
const head = 'px-3';

/**
 * The Cost rules page body (spec 0009, AC-23, AC-25): the one `<h1>`, the lock date in words
 * (the "nothing is locked yet" prompt while it is unset, an alert while it is unreadable), the
 * rule in force today for each kind with who recorded it and from when, a New rule action per kind
 * for a person who may add one, and the history a page at a time. Loading, error, and no access
 * states; a 403 shows the shared no access state. Business data comes from
 * `GET /api/platform/cost-rules` only.
 */
export function CostRulesView({ enabled, canAdd }: CostRulesViewProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const words = useCostRuleText();
  const [adding, setAdding] = useState<OrderCostRuleKind | null>(null);
  const query = useInfiniteQuery({
    queryKey: costRuleKeys.all,
    queryFn: ({ pageParam, signal }) => listCostRules(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.history.nextCursor ?? undefined,
    enabled,
  });
  const first: CostRulesResponse | undefined = query.data?.pages[0];
  const history = query.data?.pages.flatMap((page) => page.history.items) ?? [];
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  if (forbidden) return <NoAccessState titleKey="settings.costRules.title" />;

  const recorder = (row: { recordedBy: { name: string | null } | null }) =>
    row.recordedBy === null
      ? t('settings.costRules.seeded')
      : (row.recordedBy.name ?? t('settings.row.unknownPerson'));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('settings.costRules.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.costRules.description')}</p>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('settings.costRules.loadError')}
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
              {t('settings.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : !first ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-5 w-72" />
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : (
        <>
          {first.lockDateInvalid ? (
            <Alert variant="destructive">
              <CalendarX2Icon aria-hidden />
              <AlertDescription>{t('settings.costRules.lockInvalid')}</AlertDescription>
            </Alert>
          ) : first.lockDate === null ? (
            <Alert className="text-muted-foreground">
              <InfoIcon aria-hidden />
              <AlertDescription>{t('settings.costRules.lockUnset')}</AlertDescription>
            </Alert>
          ) : (
            <p className="flex items-center gap-2 text-sm">
              <CalendarCheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {t('settings.costRules.lockSet', { date: format.dateOnly(first.lockDate) })}
            </p>
          )}

          <section aria-labelledby="cost-rules-current" className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <h2 id="cost-rules-current" className="text-base font-semibold">
                {t('settings.costRules.currentHeading')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('settings.costRules.today', { date: format.dateOnly(first.today) })}
                {!canAdd && ` ${t('settings.costRules.addNeedsSettings')}`}
              </p>
            </div>
            <div className="overflow-x-auto rounded-card gradient-card-edge sm:[&_td]:py-0 sm:[&_td:lang(ar)]:py-0">
              <Table aria-label={t('settings.costRules.currentTable')}>
                <TableHeader>
                  <TableRow className="h-row-header">
                    <TableHead scope="col" className={`${head} text-start`}>
                      {t('settings.costRules.columns.kind')}
                    </TableHead>
                    <TableHead scope="col" className={`${head} text-end`}>
                      {t('settings.costRules.columns.rule')}
                    </TableHead>
                    <TableHead scope="col" className={`${head} text-start`}>
                      {t('settings.costRules.columns.from')}
                    </TableHead>
                    <TableHead scope="col" className={`${head} text-start`}>
                      {t('settings.costRules.columns.by')}
                    </TableHead>
                    {canAdd && (
                      <TableHead scope="col" className={`${head} text-end`}>
                        <span className="sr-only">{t('settings.costRules.columns.actions')}</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {first.current.map(({ kind, rule, row }) => {
                    const name = words.kindName(kind);
                    return (
                      <TableRow key={kind} className="h-row">
                        <TableHead scope="row" className="h-row! px-3 text-start">
                          {name}
                        </TableHead>
                        <TableCell className="px-3 text-end tabular-nums">
                          {words.rule(kind, rule)}
                        </TableCell>
                        <TableCell className="px-3">
                          {row
                            ? format.dateOnly(row.effectiveFrom)
                            : t('settings.costRules.neverSet')}
                        </TableCell>
                        <TableCell className="px-3">{row ? recorder(row) : ''}</TableCell>
                        {canAdd && (
                          <TableCell className="px-3 text-end">
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={t('settings.costRules.addNamed', { name })}
                              onClick={() => setAdding(kind)}
                            >
                              <PlusIcon aria-hidden data-icon="inline-start" />
                              {t('settings.costRules.add')}
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>

          <CostRulesHistory
            rows={history}
            hasMore={query.hasNextPage}
            loadingMore={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
            recorder={recorder}
          />
        </>
      )}

      {adding && first && (
        <CostRuleDialog kind={adding} today={first.today} onClose={() => setAdding(null)} />
      )}
    </div>
  );
}
