'use client';

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
import { LoaderCircleIcon, PackagePlusIcon, ReceiptTextIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { useLanguage } from '@/i18n/language-provider';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import {
  locationName,
  useCurrentLocation,
  useLocationSwitcher,
} from '@/shell/current-location-provider';
import { inventoryKeys, listReceipts } from './inventory-api';

const SEARCH_DELAY_MS = 300;

const COLUMNS = ['number', 'date', 'location', 'reference', 'lines', 'status', 'postedBy'] as const;

/**
 * Stock receipts, newest first (spec 0006, AC-12): follows the shell's current location,
 * searches the number or reference, 50 a page, voided ones badged.
 */
export function ReceiptsPage() {
  const { t } = useTranslation();
  const canReceive = useAccess().can('stock.receive');
  const format = useFormat();
  const text = useLocalizedText();
  const current = useCurrentLocation();
  const { locations, ready } = useLocationSwitcher();
  const { language, config } = useLanguage();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery({
    queryKey: inventoryKeys.receipts(current, q),
    queryFn: ({ pageParam, signal }) => listReceipts(current, q, pageParam, signal),
    enabled: ready,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = query.isPending;

  const selected = locations.find((location) => location.id === current);
  const scope = selected
    ? locationName(selected, {
        active: language,
        fallback: config?.defaultLanguage ?? 'en',
        enabled: config?.languages,
      })
    : t('shell.locations.all');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('inventory.receipts.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('inventory.receipts.description')}</p>
        </div>
        {canReceive && (
          <Button asChild>
            <Link href="/stock-receipts/new">
              <PackagePlusIcon aria-hidden data-icon="inline-start" />
              {t('inventory.receipts.receive')}
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="receipt-search" className="text-sm font-medium">
            {t('inventory.receipts.search')}
          </label>
          <Input
            id="receipt-search"
            type="search"
            value={search}
            autoComplete="off"
            aria-describedby="receipt-search-hint"
            onChange={(event) => setSearch(event.target.value)}
          />
          <span id="receipt-search-hint" className="text-xs text-muted-foreground">
            {t('inventory.receipts.searchHint')}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('inventory.receipts.scope', { location: scope })}
        </p>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.receipts.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="relative overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.receipts.tableLabel')} aria-busy={loading}>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                {COLUMNS.map((column) => (
                  <TableHead
                    key={column}
                    scope="col"
                    className={`px-3 font-medium ${column === 'lines' ? 'text-end' : 'text-start'}`}
                  >
                    {t(`inventory.receipts.columns.${column}`)}
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
                    <div className="flex flex-col items-center gap-3 text-center">
                      <ReceiptTextIcon aria-hidden className="size-8 text-muted-foreground" />
                      {q ? (
                        <p className="text-sm text-muted-foreground">
                          {t('inventory.receipts.noMatch')}
                        </p>
                      ) : (
                        <>
                          <div className="flex flex-col gap-1">
                            <p className="font-medium">{t('inventory.receipts.emptyTitle')}</p>
                            <p className="text-sm text-muted-foreground">
                              {t('inventory.receipts.emptyBody')}
                            </p>
                          </div>
                          {canReceive && (
                            <Button asChild size="sm">
                              <Link href="/stock-receipts/new">
                                {t('inventory.receipts.receive')}
                              </Link>
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                rows.map((row) => (
                  <TableRow key={row.id} className="h-row hover:bg-muted">
                    <TableCell className="px-3">
                      <Link
                        href={`/stock-receipts/${row.id}`}
                        className="rounded-sm font-medium underline-offset-4 hover:underline focus-ring"
                      >
                        <LtrText>{row.number}</LtrText>
                      </Link>
                    </TableCell>
                    <TableCell className="px-3">{format.date(row.effectiveAt)}</TableCell>
                    <TableCell className="px-3">
                      {text(row.location.name, row.location.code)}
                    </TableCell>
                    <TableCell className="px-3">
                      {row.reference ? <LtrText>{row.reference}</LtrText> : null}
                    </TableCell>
                    <TableCell className="px-3 text-end tabular-nums">
                      {format.quantity(row.lineCount)}
                    </TableCell>
                    <TableCell className="px-3">
                      <Badge variant={row.status === 'voided' ? 'destructive' : 'secondary'}>
                        {t(`inventory.receiptDetail.status.${row.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-3">{row.postedBy.name}</TableCell>
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
    </div>
  );
}
