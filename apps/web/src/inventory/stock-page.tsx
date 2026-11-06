'use client';

import type { StockRow } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
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
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  BoxesIcon,
  LoaderCircleIcon,
  MapPinPlusIcon,
  PackagePlusIcon,
  TagIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { NewSkuDialog } from '@/catalog/new-sku-dialog';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import {
  locationName,
  useCurrentLocation,
  useLocationSwitcher,
} from '@/shell/current-location-provider';
import { useLanguage } from '@/i18n/language-provider';
import { inventoryKeys, listStock } from './inventory-api';
import { NewLocationDialog } from './new-location-dialog';
import { SkuPicker, type PickedSku } from './sku-picker';

const features = tableFeatures({});

type ColumnId = 'sku' | 'name' | 'location' | 'onHand' | 'avgCost' | 'value' | 'lastMoved';

/** Number columns are end aligned with tabular digits (DESIGN.md, Data tables). */
const NUMERIC: ReadonlySet<ColumnId> = new Set(['onHand', 'avgCost', 'value']);

/**
 * Stock on hand per SKU and location, from the ledger balances (spec 0006, AC-9). Follows the
 * shell's current location. Cost and value columns appear for admins only (AC-11).
 */
export function StockPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const text = useLocalizedText();
  const access = useAccess();
  const seesCost = access.can('cost.view');
  const current = useCurrentLocation();
  const { locations, ready } = useLocationSwitcher();
  const { language, config } = useLanguage();
  const [dialog, setDialog] = useState<'sku' | 'location' | null>(null);

  const [sku, setSku] = useState<PickedSku | null>(null);
  const [includeZero, setIncludeZero] = useState(false);
  const skuId = sku?.id ?? null;
  const pickerRef = useRef<HTMLButtonElement>(null);

  const query = useInfiniteQuery({
    queryKey: inventoryKeys.stock(current, skuId, includeZero),
    queryFn: ({ pageParam, signal }) =>
      listStock(current, { skuId, includeZero }, pageParam, signal),
    enabled: ready,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  const selected = locations.find((location) => location.id === current);
  const scope = selected
    ? locationName(selected, {
        active: language,
        fallback: config?.defaultLanguage ?? 'en',
        enabled: config?.languages,
      })
    : t('shell.locations.all');

  const columns = useMemo<ColumnDef<typeof features, StockRow>[]>(() => {
    const all: (ColumnDef<typeof features, StockRow> & { id: ColumnId })[] = [
      {
        id: 'sku',
        header: () => t('inventory.stock.columns.sku'),
        cell: ({ row }) => <LtrText className="font-medium">{row.original.sku.code}</LtrText>,
      },
      {
        id: 'name',
        header: () => t('inventory.stock.columns.name'),
        cell: ({ row }) => text(row.original.sku.name, row.original.sku.code),
      },
      {
        id: 'location',
        header: () => t('inventory.stock.columns.location'),
        cell: ({ row }) => text(row.original.location.name, row.original.location.code),
      },
      {
        id: 'onHand',
        header: () => t('inventory.stock.columns.onHand'),
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2">
            {row.original.negative && (
              <Badge variant="destructive">{t('inventory.stock.negative')}</Badge>
            )}
            <span className={row.original.negative ? 'font-medium text-destructive' : ''}>
              {format.quantity(row.original.onHand)}
            </span>
          </span>
        ),
      },
      {
        id: 'avgCost',
        header: () => t('inventory.stock.columns.avgCost'),
        cell: ({ row }) =>
          row.original.avgUnitCost ? format.money(row.original.avgUnitCost, 4) : '',
      },
      {
        id: 'value',
        header: () => t('inventory.stock.columns.value'),
        cell: ({ row }) =>
          row.original.totalValue ? format.money(row.original.totalValue, 2) : '',
      },
      {
        id: 'lastMoved',
        header: () => t('inventory.stock.columns.lastMoved'),
        cell: ({ row }) => format.dateTime(row.original.lastMovedAt),
      },
    ];
    return seesCost
      ? all
      : all.filter((column) => column.id !== 'avgCost' && column.id !== 'value');
  }, [t, text, format, seesCost]);

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => `${row.sku.id}:${row.location.id}`,
  });

  const columnCount = columns.length;
  const loading = query.isPending;
  const filtered = skuId !== null || includeZero;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('inventory.stock.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('inventory.stock.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialog('sku')}>
            <TagIcon aria-hidden data-icon="inline-start" />
            {t('inventory.stock.newSku')}
          </Button>
          {access.can('catalog.manage') && (
            <Button variant="outline" onClick={() => setDialog('location')}>
              <MapPinPlusIcon aria-hidden data-icon="inline-start" />
              {t('inventory.stock.newLocation')}
            </Button>
          )}
          <Button asChild>
            <Link href="/stock-receipts/new">
              <PackagePlusIcon aria-hidden data-icon="inline-start" />
              {t('inventory.stock.receive')}
            </Link>
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('inventory.stock.scope', { location: scope })}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <div className="w-72 max-w-full">
            <SkuPicker
              id="stock-sku-filter"
              value={sku}
              onChange={setSku}
              buttonRef={pickerRef}
              label={t('inventory.stock.skuFilter')}
              placeholder={t('inventory.stock.skuFilter')}
            />
          </div>
          {sku && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('inventory.stock.clearSku')}
              onClick={() => {
                setSku(null);
                // The clear button unmounts with the filter, so focus goes back to the picker.
                pickerRef.current?.focus();
              }}
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={includeZero}
            onChange={(event) => setIncludeZero(event.target.checked)}
          />
          {t('inventory.stock.showZero')}
        </label>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.stock.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="relative overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.stock.tableLabel')} aria-busy={loading}>
            <TableHeader className="sticky top-0 bg-muted">
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="h-row-header hover:bg-muted">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      scope="col"
                      className={`px-3 font-medium ${NUMERIC.has(header.column.id as ColumnId) ? 'text-end' : 'text-start'}`}
                    >
                      <table.FlexRender header={header} />
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={index} className="h-row" aria-hidden>
                    <TableCell colSpan={columnCount} className="px-3">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {!loading && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columnCount} className="px-3 py-10">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <BoxesIcon aria-hidden className="size-8 text-muted-foreground" />
                      <div className="flex flex-col gap-1">
                        <p className="font-medium">
                          {filtered
                            ? t('inventory.stock.filteredEmptyTitle')
                            : t('inventory.stock.emptyTitle')}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {!filtered
                            ? t('inventory.stock.emptyBody')
                            : skuId === null
                              ? t('inventory.stock.filteredEmptyBodyZero')
                              : includeZero
                                ? t('inventory.stock.filteredEmptyBodySku')
                                : t('inventory.stock.filteredEmptyBody')}
                        </p>
                      </div>
                      {!filtered && (
                        <Button asChild size="sm">
                          <Link href="/stock-receipts/new">{t('inventory.stock.receive')}</Link>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className="h-row hover:bg-muted">
                    {row.getAllCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={`px-3 ${NUMERIC.has(cell.column.id as ColumnId) ? 'text-end tabular-nums' : 'text-start'}`}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
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

      {dialog === 'sku' && <NewSkuDialog onClose={() => setDialog(null)} />}
      {dialog === 'location' && <NewLocationDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
