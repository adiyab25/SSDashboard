'use client';

import type { SkuStockResponse } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
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
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { getSkuStock, inventoryKeys } from '@/inventory/inventory-api';

/** Cost columns exist only when the api sent cost fields, which it does for people holding `cost.view` only. */
function hasCost(stock: SkuStockResponse): boolean {
  return (
    stock.totalValue !== undefined ||
    stock.locations.some((row) => row.avgUnitCost !== undefined || row.totalValue !== undefined)
  );
}

/** The SKU's on-hand quantity per location, with cost columns for people holding `cost.view` only. */
export function SkuStockSection({ skuId }: { skuId: string }) {
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
        <div className="overflow-hidden rounded-card gradient-card-edge">
          <Table aria-label={t('inventory.skuDetail.stockTable')} aria-busy={query.isPending}>
            <TableHeader>
              <TableRow className="h-row-header">
                <TableHead scope="col" className="px-3 text-start">
                  {t('inventory.skuDetail.stockColumns.location')}
                </TableHead>
                <TableHead scope="col" className="px-3 text-end">
                  {t('inventory.skuDetail.stockColumns.onHand')}
                </TableHead>
                {cost && (
                  <>
                    <TableHead scope="col" className="px-3 text-end">
                      {t('inventory.skuDetail.stockColumns.avgCost')}
                    </TableHead>
                    <TableHead scope="col" className="px-3 text-end">
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
                <TableRow key={row.location.id} className="h-row">
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
