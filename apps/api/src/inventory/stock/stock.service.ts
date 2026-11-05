import { Inject, Injectable } from '@nestjs/common';
import {
  Money,
  UnitCost,
  type SkuMovement,
  type SkuMovementsQuery,
  type SkuMovementsResponse,
  type SkuStockResponse,
  type StaffRole,
  type StockListQuery,
  type StockListResponse,
  type StockRow,
} from '@ssdashboard/contracts';
import { CatalogService } from '../../catalog/catalog.service.js';
import { decodeTimeIdKeyset, encodeKeyset } from '../../platform/keyset-cursor.js';
import { StaffDirectory } from '../../staff/staff-directory.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { ReceiptsService } from '../receipts/receipts.service.js';

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

/** Removes unit cost and line value for anyone but an admin (AC-11). */
export function serializeMovement(movement: SkuMovement, role: StaffRole): SkuMovement {
  if (role === 'admin') return movement;
  const { unitCost: _cost, totalCost: _total, ...rest } = movement;
  return rest;
}

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/** Stock on hand read from the ledger balances (spec 0006, AC-9 and AC-10). */
@Injectable()
export class StockService {
  /**
   * Takes the ledger for balances and the catalog, locations, receipts and staff directory that
   * name what those balances refer to.
   */
  constructor(
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(LocationsService) private readonly locations: LocationsService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /** The Stock page: one row per balance, most recent movement first, 50 a page. */
  async list(query: StockListQuery, role: StaffRole): Promise<StockListResponse> {
    const after = query.cursor ? decodeTimeIdKeyset(query.cursor) : undefined;
    const rows = await this.ledger.listStock({
      locationId: query.locationId,
      variantId: query.skuId,
      includeZero: query.includeZero,
      after: after ? { updatedAt: after.at, id: after.id } : undefined,
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

  /**
   * A SKU's movement history, newest first, 50 a page with load more (AC-10). A stock receipt
   * row links to its number (a void's row is `isReversal`); posted by names come from the staff
   * directory. Throws catalog `NotFound` for an unknown SKU.
   */
  async movements(
    variantId: string,
    query: SkuMovementsQuery,
    role: StaffRole,
  ): Promise<SkuMovementsResponse> {
    const after = query.cursor ? decodeTimeIdKeyset(query.cursor) : undefined;
    await this.catalog.getSku(variantId);
    const rows = await this.ledger.getMovements({
      variantId,
      after: after ? { recordedAt: after.at, id: after.id } : undefined,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const places = await this.locations.byIds(page.map((row) => row.locationId));
    const numbers = await this.receipts.numbersByIds(
      page.filter((row) => row.sourceType === 'stock_receipt').map((row) => row.sourceId),
    );
    const names = await this.staff.namesByIds(
      page.map((row) => row.postedBy).filter((id): id is string => id !== null),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const number = row.sourceType === 'stock_receipt' ? numbers.get(row.sourceId) : undefined;
        return serializeMovement(
          {
            id: row.id,
            effectiveAt: row.effectiveAt,
            recordedAt: row.recordedAt,
            location: places.get(row.locationId) ?? { id: row.locationId, code: '', name: {} },
            quantity: row.quantity,
            sourceType: row.sourceType,
            isReversal: row.reversesGroupId !== null,
            source: number ? { id: row.sourceId, number } : null,
            postedBy: row.postedBy
              ? { id: row.postedBy, name: names.get(row.postedBy) ?? '' }
              : null,
            unitCost: row.unitCost,
            totalCost: row.totalCost,
          },
          role,
        );
      }),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.recordedAt, last.id]) : null,
    };
  }
}
