'use client';

import type { SkuDetail, SkuMovement, SkuStockResponse } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { getSku, getSkuStock, inventoryKeys, listSkuMovements } from '@/inventory/inventory-api';
import { SkuEditDialog } from './sku-edit-dialog';

const linkClass = 'rounded-sm font-medium underline-offset-4 hover:underline focus-ring';

/** One SKU: its stock per location and its movement history (spec 0006, AC-10). */
export function SkuDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const query = useQuery({
    queryKey: inventoryKeys.sku(id),
    queryFn: ({ signal }) => getSku(id, signal),
  });

  if (query.isPending) return <SkuDetailSkeleton />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('inventory.skus.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {notFound ? t('inventory.skuDetail.notFound') : t('inventory.skuDetail.loadError')}
            {!notFound && (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                {t('inventory.retry')}
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/skus">{t('inventory.skuDetail.back')}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return <SkuView sku={query.data} />;
}

export function SkuDetailSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('inventory.skus.title')}</h1>
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

function SkuView({ sku }: { sku: SkuDetail }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">
              <LtrText>{sku.code}</LtrText>
            </h1>
            {sku.archived && <Badge variant="outline">{t('inventory.skus.archivedBadge')}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{text(sku.name, sku.code)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/skus">{t('inventory.skuDetail.back')}</Link>
          </Button>
          <Button onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden data-icon="inline-start" />
            {t('inventory.skuDetail.edit')}
          </Button>
        </div>
      </div>

      <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('inventory.skuDetail.price')}</dt>
          <dd className="font-medium tabular-nums">
            {sku.price === null ? t('inventory.skuDetail.noPrice') : format.money(sku.price, 2)}
          </dd>
        </div>
      </dl>

      <StockSection skuId={sku.id} />
      <HistorySection skuId={sku.id} />

      {editing && (
        <SkuEditDialog
          skuId={sku.id}
          onClose={() => setEditing(false)}
          onDeleted={() => router.replace('/skus')}
        />
      )}
    </div>
  );
}

/** Cost columns exist only when the api sent cost fields, which it does for admins only. */
function hasCost(stock: SkuStockResponse): boolean {
  return (
    stock.totalValue !== undefined ||
    stock.locations.some((row) => row.avgUnitCost !== undefined || row.totalValue !== undefined)
  );
}

function StockSection({ skuId }: { skuId: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const query = useQuery({
    queryKey: inventoryKeys.skuStock(skuId),
    queryFn: ({ signal }) => getSkuStock(skuId, signal),
  });
  const stock = query.data;
  const cost = stock ? hasCost(stock) : false;
  const columnCount = cost ? 4 : 2;

  return (
    <section aria-labelledby="sku-stock-title" className="flex flex-col gap-3">
      <h2 id="sku-stock-title" className="text-base font-semibold">
        {t('inventory.skuDetail.stockTitle')}
      </h2>
      {query.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.skuDetail.stockLoadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.skuDetail.stockTable')} aria-busy={query.isPending}>
            <TableHeader className="bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.skuDetail.stockColumns.location')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-end font-medium">
                  {t('inventory.skuDetail.stockColumns.onHand')}
                </TableHead>
                {cost && (
                  <>
                    <TableHead scope="col" className="px-3 text-end font-medium">
                      {t('inventory.skuDetail.stockColumns.avgCost')}
                    </TableHead>
                    <TableHead scope="col" className="px-3 text-end font-medium">
                      {t('inventory.skuDetail.stockColumns.value')}
                    </TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isPending && (
                <TableRow className="h-row" aria-hidden>
                  <TableCell colSpan={columnCount} className="px-3">
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {stock && stock.locations.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columnCount}
                    className="px-3 py-6 text-center text-sm text-muted-foreground"
                  >
                    {t('inventory.skuDetail.noStock')}
                  </TableCell>
                </TableRow>
              )}
              {stock?.locations.map((row) => (
                <TableRow key={row.location.id} className="h-row hover:bg-muted">
                  <TableCell className="px-3">
                    {text(row.location.name, row.location.code)}
                  </TableCell>
                  <TableCell className="px-3 text-end tabular-nums">
                    {format.quantity(row.onHand)}
                  </TableCell>
                  {cost && (
                    <>
                      <TableCell className="px-3 text-end tabular-nums">
                        {row.avgUnitCost ? format.money(row.avgUnitCost, 4) : ''}
                      </TableCell>
                      <TableCell className="px-3 text-end tabular-nums">
                        {row.totalValue ? format.money(row.totalValue, 2) : ''}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
            {stock && stock.locations.length > 0 && (
              <TableFooter>
                <TableRow className="h-row">
                  <TableCell className="px-3 font-medium">
                    {t('inventory.skuDetail.total')}
                  </TableCell>
                  <TableCell className="px-3 text-end font-medium tabular-nums">
                    {format.quantity(stock.totalOnHand)}
                  </TableCell>
                  {cost && (
                    <>
                      <TableCell className="px-3" />
                      <TableCell className="px-3 text-end font-medium tabular-nums">
                        {stock.totalValue ? format.money(stock.totalValue, 2) : ''}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
    </section>
  );
}

function HistorySection({ skuId }: { skuId: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const query = useInfiniteQuery({
    queryKey: inventoryKeys.skuMovements(skuId),
    queryFn: ({ pageParam, signal }) => listSkuMovements(skuId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = query.isPending;
  const cost = rows.some((row) => row.unitCost !== undefined || row.totalCost !== undefined);
  const columnCount = cost ? 7 : 5;

  const source = (row: SkuMovement) => {
    if (row.source && row.isReversal) {
      return (
        <Link href={`/stock-receipts/${row.source.id}`} className={linkClass}>
          {t('inventory.skuDetail.voidOf')} <LtrText>{row.source.number}</LtrText>
        </Link>
      );
    }
    if (row.isReversal) return t('inventory.skuDetail.voidOf');
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2">
        {t(`inventory.skuDetail.sourceTypes.${row.sourceType}`)}
        {row.source && (
          <Link href={`/stock-receipts/${row.source.id}`} className={linkClass}>
            <LtrText>{row.source.number}</LtrText>
          </Link>
        )}
      </span>
    );
  };

  return (
    <section aria-labelledby="sku-history-title" className="flex flex-col gap-3">
      <h2 id="sku-history-title" className="text-base font-semibold">
        {t('inventory.skuDetail.historyTitle')}
      </h2>
      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.skuDetail.historyLoadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.skuDetail.historyTable')} aria-busy={loading}>
            <TableHeader className="bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.skuDetail.columns.date')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.skuDetail.columns.location')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-end font-medium">
                  {t('inventory.skuDetail.columns.quantity')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.skuDetail.columns.source')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-start font-medium">
                  {t('inventory.skuDetail.columns.postedBy')}
                </TableHead>
                {cost && (
                  <>
                    <TableHead scope="col" className="px-3 text-end font-medium">
                      {t('inventory.skuDetail.columns.unitCost')}
                    </TableHead>
                    <TableHead scope="col" className="px-3 text-end font-medium">
                      {t('inventory.skuDetail.columns.totalCost')}
                    </TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow className="h-row" aria-hidden>
                  <TableCell colSpan={columnCount} className="px-3">
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columnCount}
                    className="px-3 py-6 text-center text-sm text-muted-foreground"
                  >
                    {t('inventory.skuDetail.noMovements')}
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                rows.map((row) => (
                  <TableRow key={row.id} className="h-row hover:bg-muted">
                    <TableCell className="px-3">{format.dateTime(row.effectiveAt)}</TableCell>
                    <TableCell className="px-3">
                      {text(row.location.name, row.location.code)}
                    </TableCell>
                    <TableCell className="px-3 text-end tabular-nums">
                      <LtrText>
                        {row.quantity > 0 ? '+' : ''}
                        {format.quantity(row.quantity)}
                      </LtrText>
                    </TableCell>
                    <TableCell className="px-3">{source(row)}</TableCell>
                    <TableCell className="px-3">
                      {row.postedBy ? row.postedBy.name : t('inventory.skuDetail.system')}
                    </TableCell>
                    {cost && (
                      <>
                        <TableCell className="px-3 text-end tabular-nums">
                          {row.unitCost ? format.money(row.unitCost, 4) : ''}
                        </TableCell>
                        <TableCell className="px-3 text-end tabular-nums">
                          {row.totalCost ? format.money(row.totalCost, 2) : ''}
                        </TableCell>
                      </>
                    )}
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
    </section>
  );
}
