'use client';

import type { SkuStatus } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
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
import { LoaderCircleIcon, PencilIcon, TagIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys, listSkus } from '@/inventory/inventory-api';
import { useAccess } from '@/access/use-access';
import { NewSkuDialog } from './new-sku-dialog';
import { SkuEditDialog } from './sku-edit-dialog';

const SEARCH_DELAY_MS = 300;

const COLUMNS = ['sku', 'name', 'price', 'status', 'actions'] as const;

const STATUSES: readonly SkuStatus[] = ['active', 'archived'];

/**
 * The SKU list (spec 0006, AC-13): search by code prefix or name, an active or archived
 * filter, and 50 a page with Load more.
 */
export function SkusPage() {
  const { t } = useTranslation();
  const canEdit = useAccess().can('catalog.edit');
  const format = useFormat();
  const text = useLocalizedText();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SkuStatus>('active');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery({
    queryKey: inventoryKeys.skuList(q, status),
    queryFn: ({ pageParam, signal }) => listSkus(q, status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = query.isPending;

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

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="sku-search" className="text-sm font-medium">
            {t('inventory.skus.search')}
          </label>
          <Input
            id="sku-search"
            type="search"
            value={search}
            autoComplete="off"
            aria-describedby="sku-search-hint"
            onChange={(event) => setSearch(event.target.value)}
          />
          <span id="sku-search-hint" className="text-xs text-muted-foreground">
            {t('inventory.skus.searchHint')}
          </span>
        </div>
        <div role="group" aria-label={t('inventory.skus.filterLabel')} className="flex gap-1">
          {STATUSES.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? 'secondary' : 'outline'}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {t(`inventory.skus.${value}`)}
            </Button>
          ))}
        </div>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.skus.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="relative overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.skus.tableLabel')} aria-busy={loading}>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                {COLUMNS.map((column) => (
                  <TableHead
                    key={column}
                    scope="col"
                    className={`px-3 font-medium ${column === 'price' ? 'text-end' : 'text-start'}`}
                  >
                    {t(`inventory.skus.columns.${column}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={index} className="h-row" aria-hidden>
                    <TableCell colSpan={COLUMNS.length} className="px-3">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {!loading && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COLUMNS.length} className="px-3 py-10">
                    <p className="text-center text-sm text-muted-foreground">
                      {q
                        ? t('inventory.skus.noMatch')
                        : status === 'archived'
                          ? t('inventory.skus.emptyArchived')
                          : `${t('inventory.skus.emptyTitle')}. ${t('inventory.skus.emptyBody')}`}
                    </p>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                rows.map((row) => (
                  <TableRow key={row.id} className="h-row hover:bg-muted">
                    <TableCell className="px-3">
                      <Link
                        href={`/skus/${row.id}`}
                        className="rounded-sm font-medium underline-offset-4 hover:underline focus-ring"
                      >
                        <LtrText>{row.code}</LtrText>
                      </Link>
                    </TableCell>
                    <TableCell className="px-3">{text(row.name, row.code)}</TableCell>
                    <TableCell className="px-3 text-end tabular-nums">
                      {row.price === null ? '' : format.money(row.price, 2)}
                    </TableCell>
                    <TableCell className="px-3">
                      <Badge variant={row.archived ? 'outline' : 'secondary'}>
                        {row.archived
                          ? t('inventory.skus.archivedBadge')
                          : t('inventory.skus.activeBadge')}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-3">
                      {canEdit && (
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
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
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
