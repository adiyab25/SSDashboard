'use client';

import type { SkuSummary } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { CollapsingTable } from '@ssdashboard/ui/dashboard/collapsing-table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, PencilIcon, TagIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys, listSkus, type SkuListFilters } from '@/inventory/inventory-api';
import { NewSkuDialog } from './new-sku-dialog';
import { SkuEditDialog } from './sku-edit-dialog';
import { SkuFilterBar, type SkuFilterValues } from './sku-filter-bar';
import { SkuNameCell } from './sku-name-cell';
import { useGroupingChoices } from './use-grouping-choices';

const SEARCH_DELAY_MS = 300;

/**
 * The SKU list (spec 0006 AC-13, spec 0012 AC-3 and AC-4): search by name, SKU code, or barcode,
 * season and group filters, an active or archived switch, and 50 a page with Load more. Below
 * 640px the table becomes a list of cards (spec 0012, AC-18).
 */
export function SkusView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const canEdit = useAccess().can('catalog.edit');
  const format = useFormat();
  const text = useLocalizedText();
  const [filters, setFilters] = useState<SkuFilterValues>({
    search: '',
    status: 'active',
    season: '',
    group: '',
  });
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(filters.search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [filters.search]);

  const request: SkuListFilters = {
    q,
    status: filters.status,
    ...(filters.season && { seasonId: filters.season }),
    ...(filters.group && { productGroupId: filters.group }),
  };
  const query = useInfiniteQuery({
    queryKey: inventoryKeys.skuList(request),
    queryFn: ({ pageParam, signal }) => listSkus(request, pageParam, signal),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const options = useGroupingChoices(enabled);
  const loading = query.isPending;
  const filtered = q !== '' || filters.season !== '' || filters.group !== '';

  const columns = [
    {
      id: 'sku',
      header: t('inventory.skus.columns.sku'),
      title: true,
      cell: (row: SkuSummary) => (
        <Link
          href={`/skus/${row.id}`}
          className="rounded-chip font-medium underline-offset-4 hover:underline focus-ring"
        >
          <LtrText>{row.code}</LtrText>
        </Link>
      ),
    },
    {
      id: 'name',
      header: t('inventory.skus.columns.name'),
      cell: (row: SkuSummary) => <SkuNameCell sku={row} />,
    },
    {
      id: 'style',
      header: t('inventory.skus.columns.style'),
      cell: (row: SkuSummary) => <LtrText>{row.style.code}</LtrText>,
    },
    {
      id: 'season',
      header: t('inventory.skus.columns.season'),
      cell: (row: SkuSummary) =>
        row.season ? (
          text(row.season.name, row.season.code)
        ) : (
          <span className="text-muted-foreground">{t('inventory.skus.noSeason')}</span>
        ),
    },
    {
      id: 'group',
      header: t('inventory.skus.columns.group'),
      cell: (row: SkuSummary) => text(row.productGroup.name, row.productGroup.code),
    },
    {
      id: 'price',
      header: t('inventory.skus.columns.price'),
      align: 'end' as const,
      cell: (row: SkuSummary) => (row.price === null ? '' : format.money(row.price, 2)),
    },
    {
      id: 'status',
      header: t('inventory.skus.columns.status'),
      cell: (row: SkuSummary) => (
        <Badge variant={row.archived ? 'outline' : 'secondary'}>
          {row.archived ? t('inventory.skus.archivedBadge') : t('inventory.skus.activeBadge')}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: t('inventory.skus.columns.actions'),
      cell: (row: SkuSummary) =>
        canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('inventory.skus.editLabel', { code: row.code })}
            onClick={() => setEditing(row.id)}
          >
            <PencilIcon aria-hidden data-icon="inline-start" />
            {t('inventory.skus.edit')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('inventory.skus.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('inventory.skus.description')}</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreating(true)}>
            <TagIcon aria-hidden data-icon="inline-start" />
            {t('inventory.skus.newSku')}
          </Button>
        )}
      </div>

      <SkuFilterBar
        values={filters}
        options={options}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
      />

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.skus.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : loading ? (
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
        <p className="rounded-card gradient-card-edge px-3 py-10 text-center text-sm text-muted-foreground">
          {filtered
            ? t('inventory.skus.noMatch')
            : filters.status === 'archived'
              ? t('inventory.skus.emptyArchived')
              : `${t('inventory.skus.emptyTitle')}. ${t('inventory.skus.emptyBody')}`}
        </p>
      ) : (
        <CollapsingTable
          caption={t('inventory.skus.tableLabel')}
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          className="sm:overflow-hidden sm:rounded-card sm:gradient-card-edge"
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
          {t('inventory.loadMore')}
        </Button>
      )}

      {creating && <NewSkuDialog onClose={() => setCreating(false)} />}
      {editing && <SkuEditDialog skuId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
