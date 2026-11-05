'use client';

import type { SkuMovement } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
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
import { LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys, listSkuMovements } from '@/inventory/inventory-api';

const linkClass = 'rounded-sm font-medium underline-offset-4 hover:underline focus-ring';

/** The SKU's movement history, newest first, loaded a page at a time. */
export function SkuHistorySection({ skuId }: { skuId: string }) {
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
