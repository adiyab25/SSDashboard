'use client';

import type { StyleSummary } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { CollapsingTable } from '@ssdashboard/ui/dashboard/collapsing-table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, ShirtIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { catalogKeys, listStyles, type StyleListFilters } from '../catalog-api';
import { useGroupingChoices } from '../use-grouping-choices';
import { StyleAssignDialog, type AssignMode, type AssignTarget } from './style-assign-dialog';
import { StyleFilterBar, type StyleFilterValues } from './style-filter-bar';

const SEARCH_DELAY_MS = 300;
/** The most styles one bulk assign takes (the contract's limit, AC-9). */
const MAX_ASSIGN = 200;

/**
 * The style list (spec 0012, AC-8, AC-9): search, season (with "No season"), group, and status
 * filters, 50 a page with Load more. A person holding `catalog.edit` selects styles and sets
 * their season or group in one all or nothing step. Changing a filter clears the selection, so
 * a bulk step never touches a style the person no longer sees. Below 640px the table becomes
 * cards.
 */
export function StylesView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const canEdit = useAccess().can('catalog.edit');
  const format = useFormat();
  const text = useLocalizedText();
  const [filters, setFilters] = useState<StyleFilterValues>({
    search: '',
    status: 'active',
    season: '',
    group: '',
  });
  const [q, setQ] = useState('');
  /** Selected styles, id to code (the code names a style the api no longer finds). */
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const [assigning, setAssigning] = useState<AssignMode | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(filters.search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [filters.search]);

  const request: StyleListFilters = {
    q,
    status: filters.status,
    ...(filters.season && { seasonId: filters.season }),
    ...(filters.group && { productGroupId: filters.group }),
  };
  const query = useInfiniteQuery({
    queryKey: catalogKeys.styleList(request),
    queryFn: ({ pageParam, signal }) => listStyles(request, pageParam, signal),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const choices = useGroupingChoices(enabled);
  const filtered = q !== '' || filters.season !== '' || filters.group !== '';

  const toggle = (row: StyleSummary, on: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(row.id, row.code);
      else next.delete(row.id);
      return next;
    });
  const allShown = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Map(rows.map((row) => [row.id, row.code])) : new Map());
  const tooMany = selected.size > MAX_ASSIGN;
  const targets: AssignTarget[] = [...selected].map(([id, code]) => ({ id, code }));

  const columns = [
    ...(canEdit
      ? [
          {
            id: 'select',
            header: t('catalog.styles.columns.select'),
            cell: (row: StyleSummary) => (
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-primary focus-ring"
                checked={selected.has(row.id)}
                aria-label={t('catalog.styles.selectLabel', { code: row.code })}
                onChange={(event) => toggle(row, event.target.checked)}
              />
            ),
          },
        ]
      : []),
    {
      id: 'code',
      header: t('catalog.styles.columns.code'),
      title: true,
      cell: (row: StyleSummary) => (
        <Link
          href={`/styles/${row.id}`}
          className="rounded-chip font-medium underline-offset-4 hover:underline focus-ring"
        >
          <LtrText>{row.code}</LtrText>
        </Link>
      ),
    },
    {
      id: 'name',
      header: t('catalog.styles.columns.name'),
      cell: (row: StyleSummary) => text(row.name, row.code),
    },
    {
      id: 'season',
      header: t('catalog.styles.columns.season'),
      cell: (row: StyleSummary) =>
        row.season ? (
          text(row.season.name, row.season.code)
        ) : (
          <span className="text-muted-foreground">{t('catalog.common.noSeason')}</span>
        ),
    },
    {
      id: 'group',
      header: t('catalog.styles.columns.group'),
      cell: (row: StyleSummary) => text(row.productGroup.name, row.productGroup.code),
    },
    {
      id: 'variants',
      header: t('catalog.styles.columns.variants'),
      align: 'end' as const,
      cell: (row: StyleSummary) => format.quantity(row.activeVariantCount),
    },
    {
      id: 'status',
      header: t('catalog.styles.columns.status'),
      cell: (row: StyleSummary) => (
        <Badge variant={row.archived ? 'outline' : 'secondary'}>
          {row.archived ? t('catalog.common.archivedBadge') : t('catalog.common.activeBadge')}
        </Badge>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('catalog.styles.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('catalog.styles.description')}</p>
      </div>

      <StyleFilterBar
        values={filters}
        choices={choices}
        onChange={(next) => {
          setFilters((current) => ({ ...current, ...next }));
          setSelected(new Map());
        }}
      />

      {canEdit && rows.length > 0 && (
        <div
          role="group"
          aria-label={t('catalog.styles.bulkLabel')}
          className="flex flex-wrap items-center gap-3 rounded-card gradient-card-edge px-3 py-2 text-sm"
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-primary focus-ring"
              checked={allShown}
              onChange={(event) => toggleAll(event.target.checked)}
            />
            {t('catalog.styles.selectAll')}
          </label>
          <span aria-live="polite" className="text-muted-foreground">
            {t('catalog.styles.selectedCount', { count: selected.size })}
          </span>
          <div className="flex flex-wrap gap-2 sm:ms-auto">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || tooMany}
              aria-describedby={tooMany ? 'styles-too-many' : undefined}
              onClick={() => setAssigning('season')}
            >
              {t('catalog.styles.setSeason')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || tooMany}
              aria-describedby={tooMany ? 'styles-too-many' : undefined}
              onClick={() => setAssigning('group')}
            >
              {t('catalog.styles.setGroup')}
            </Button>
            {selected.size > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => toggleAll(false)}>
                {t('catalog.styles.clearSelection')}
              </Button>
            )}
          </div>
          {tooMany && (
            <p id="styles-too-many" className="basis-full text-destructive">
              {t('catalog.styles.tooMany')}
            </p>
          )}
        </div>
      )}

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('catalog.styles.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('catalog.common.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.isPending ? (
        <div
          aria-busy
          className="flex flex-col gap-2 sm:gap-0 sm:rounded-card sm:gradient-card-edge"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex h-row items-center px-3" aria-hidden>
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-card gradient-card-edge px-4 py-10 text-center">
          <ShirtIcon aria-hidden className="size-8 text-muted-foreground" />
          {filtered ? (
            <p className="text-sm text-muted-foreground">{t('catalog.styles.noMatch')}</p>
          ) : filters.status === 'archived' ? (
            <p className="text-sm text-muted-foreground">{t('catalog.styles.emptyArchived')}</p>
          ) : (
            <>
              <p className="font-medium">{t('catalog.styles.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('catalog.styles.emptyBody')}</p>
            </>
          )}
        </div>
      ) : (
        <CollapsingTable
          caption={t('catalog.styles.tableLabel')}
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          className="sm:overflow-hidden sm:rounded-card sm:gradient-card-edge sm:[&_td]:py-0 sm:[&_td:lang(ar)]:py-0"
        />
      )}

      {query.hasNextPage && (
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
          {t('catalog.common.loadMore')}
        </Button>
      )}

      {assigning && (
        <StyleAssignDialog
          mode={assigning}
          styles={targets}
          choices={choices}
          onDone={() => setSelected(new Map())}
          onMissing={(ids) =>
            setSelected((current) => {
              const next = new Map(current);
              for (const id of ids) next.delete(id);
              return next;
            })
          }
          onClose={() => setAssigning(null)}
        />
      )}
    </div>
  );
}
