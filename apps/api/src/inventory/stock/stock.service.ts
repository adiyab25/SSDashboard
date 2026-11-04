import { Inject, Injectable } from '@nestjs/common';
import {
  Money,
  UnitCost,
  type SkuStockResponse,
  type StaffRole,
  type StockListQuery,
  type StockListResponse,
  type StockRow,
} from '@ssdashboard/contracts';
import { CatalogService } from '../../catalog/catalog.service.js';
import { decodeKeyset, encodeKeyset } from '../../platform/keyset-cursor.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { LocationsService } from '../locations/locations.service.js';

/** `round(totalValue / onHand, 4)` when on hand is positive, else null (spec 0006). */
export function averageCost(onHand: number, totalValue: string): string | null {
  return onHand > 0 ? UnitCost.perUnit(Money.of(totalValue), onHand).toString() : null;
}

/** Removes cost and value for anyone but an admin (AC-11). */
export function serializeStockRow(row: StockRow, role: StaffRole): StockRow {
  if (role === 'admin') return row;
  const { avgUnitCost: _avg, totalValue: _value, ...rest } = row;
  return rest;
}

/** Removes cost and value for anyone but an admin (AC-11). */
export function serializeSkuStock(stock: SkuStockResponse, role: StaffRole): SkuStockResponse {
  if (role === 'admin') return stock;
  const { totalValue: _value, ...rest } = stock;
  return {
    ...rest,
    locations: stock.locations.map(
      ({ avgUnitCost: _avg, totalValue: _total, ...location }) => location,
    ),
  };
}

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/** Stock on hand read from the ledger balances (spec 0006, AC-9 and AC-10). */
@Injectable()
export class StockService {
  constructor(
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(LocationsService) private readonly locations: LocationsService,
  ) {}

  /** The Stock page: one row per balance, most recent movement first, 50 a page. */
  async list(query: StockListQuery, role: StaffRole): Promise<StockListResponse> {
    const after = query.cursor ? decodeKeyset(query.cursor, 2) : undefined;
    const rows = await this.ledger.listStock({
      locationId: query.locationId,
      variantId: query.skuId,
      includeZero: query.includeZero,
      after: after ? { updatedAt: after[0] ?? '', id: after[1] ?? '' } : undefined,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const skus = await this.catalog.getSkus(page.map((row) => row.variantId));
    const places = await this.locations.byIds(page.map((row) => row.locationId));
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const sku = skus.get(row.variantId);
        return serializeStockRow(
          {
            sku: { id: row.variantId, code: sku?.code ?? '', name: sku?.name ?? {} },
            location: places.get(row.locationId) ?? { id: row.locationId, code: '', name: {} },
            onHand: row.onHand,
            negative: row.onHand < 0,
            avgUnitCost: averageCost(row.onHand, row.totalValue),
            totalValue: row.totalValue,
            lastMovedAt: row.updatedAt,
          },
          role,
        );
      }),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.updatedAt, last.id]) : null,
    };
  }

  /** Non zero on hand per location for one SKU, and the totals. Throws catalog `NotFound`. */
  async forSku(variantId: string, role: StaffRole): Promise<SkuStockResponse> {
    await this.catalog.getSku(variantId);
    const perLocation = new Map<string, { onHand: number; value: Money }>();
    let cursor: string | undefined;
    do {
      const page = await this.ledger.getLevels({ variantId, cursor, limit: 200 });
      for (const level of page.levels) {
        const sum = perLocation.get(level.locationId) ?? { onHand: 0, value: Money.zero };
        sum.onHand += level.onHand;
        sum.value = sum.value.plus(Money.of(level.totalValue));
        perLocation.set(level.locationId, sum);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const nonZero = [...perLocation.entries()].filter(([, sum]) => sum.onHand !== 0);
    const places = await this.locations.byIds(nonZero.map(([id]) => id));
    const locations = nonZero
      .map(([id, sum]) => ({
        location: places.get(id) ?? { id, code: '', name: {} },
        onHand: sum.onHand,
        avgUnitCost: averageCost(sum.onHand, sum.value.toString()),
        totalValue: sum.value.toString(),
      }))
      .sort((a, b) => byCode(a.location, b.location));
    return serializeSkuStock(
      {
        locations,
        totalOnHand: locations.reduce((total, row) => total + row.onHand, 0),
        totalValue: locations
          .reduce((total, row) => total.plus(Money.of(row.totalValue)), Money.zero)
          .toString(),
      },
      role,
    );
  }
}
