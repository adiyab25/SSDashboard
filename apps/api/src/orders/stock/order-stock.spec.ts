import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogLocks } from '../../catalog/catalog-locks.service.js';
import type { CatalogService, StockableSku } from '../../catalog/catalog.service.js';
import type { LedgerService } from '../../inventory/ledger/ledger.service.js';
import type { OnlineStockGate } from '../../inventory/online-stock/online-stock-gate.js';
import type { OnlineStockService } from '../../inventory/online-stock/online-stock.service.js';
import { orderTransactionFromLedger, type OrderTransactions } from '../order-transactions.js';
import { LineShort } from '../orders.errors.js';
import type { OrderWriter } from '../writer/order-writer.js';
import { OPEN_ORDERS_HELD_CHECK, OrderStock, chunksOf, holdBatchesOf } from './order-stock.js';

const ORDER = '0190c0de-0000-7000-8000-000000000001';
const LINE_A = '0190c0de-0000-7000-8000-00000000000a';
const LINE_B = '0190c0de-0000-7000-8000-00000000000b';
const SKU_A = '0190c0de-0000-7000-8000-0000000000a1';
const SKU_B = '0190c0de-0000-7000-8000-0000000000b1';
const ONLINE = '0190c0de-0000-7000-8000-0000000000f1';
const ELSEWHERE = '0190c0de-0000-7000-8000-0000000000e1';

interface Fixture {
  lines?: { id: string; variant_id: string; quantity: number; short_quantity: number }[];
  skus?: Partial<Record<string, Partial<StockableSku>>>;
  online?: boolean;
  unfilled?: Record<string, number>;
  active?: { sourceId: string; sourceLineId: string; locationId: string }[];
}

interface ReserveCall {
  lines: { sourceLineId: string; quantity: number }[];
}

/** An OrderStock over fakes: the order transaction answers the open lines read. */
function stockWith(fixture: Fixture = {}) {
  const lines = fixture.lines ?? [
    { id: LINE_A, variant_id: SKU_A, quantity: 2, short_quantity: 0 },
    { id: LINE_B, variant_id: SKU_B, quantity: 1, short_quantity: 0 },
  ];
  const tx = orderTransactionFromLedger({
    execute: vi.fn(() => Promise.resolve({ rows: lines })),
  } as never);
  const ledger = {
    activeReservationLocations: vi.fn(
      (): Promise<{ sourceId: string; sourceLineId: string; locationId: string }[]> =>
        Promise.resolve(fixture.active ?? []),
    ),
    reserveLines: vi.fn((_tx: unknown, input: ReserveCall) =>
      Promise.resolve(
        input.lines.map((line) => {
          const unfilled = fixture.unfilled?.[line.sourceLineId] ?? 0;
          return {
            sourceLineId: line.sourceLineId,
            reservationId: line.sourceLineId,
            requested: line.quantity,
            held: line.quantity - unfilled,
            unfilled,
            short: unfilled > 0,
          };
        }),
      ),
    ),
    releaseLines: vi.fn(() => Promise.resolve([])),
    releaseSource: vi.fn(() => Promise.resolve([])),
  };
  const onlineStock = {
    shareOnlineFlag: vi.fn(() => Promise.resolve()),
    onlineLocation: vi.fn(() =>
      Promise.resolve(fixture.online === false ? null : { id: ONLINE, code: 'WH', name: {} }),
    ),
  };
  const gate = { register: vi.fn() };
  const facts = (ids: readonly string[]) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [
          id,
          { id, archived: false, kind: 'stocked', tracking: 'none', ...fixture.skus?.[id] },
        ]),
      ),
    );
  const catalog = { getSkus: vi.fn(facts) };
  const locks = { lockForShare: vi.fn((_tx: unknown, ids: readonly string[]) => facts(ids)) };
  const writer = {
    setShortQuantities: vi.fn(() => Promise.resolve()),
    clearShortQuantities: vi.fn(() => Promise.resolve()),
    lockOrder: vi.fn(() => Promise.resolve(true)),
  };
  const stock = new OrderStock(
    { db: {} } as unknown as DatabaseConnection,
    ledger as unknown as LedgerService,
    onlineStock as unknown as OnlineStockService,
    gate as unknown as OnlineStockGate,
    catalog as unknown as CatalogService,
    locks as unknown as CatalogLocks,
    writer as unknown as OrderWriter,
    {} as OrderTransactions,
  );
  return { stock, tx, ledger, writer, gate, locks, onlineStock, catalog };
}

describe('chunksOf and holdBatchesOf', () => {
  it('splits a list into runs of at most the size, in order', () => {
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunksOf([], 2)).toEqual([]);
  });

  it('keeps one order together when it fits and starts a new batch when it would not', () => {
    const line = (orderId: string, n: number) => ({ orderId, n });
    const lines = [line('a', 1), line('a', 2), line('b', 3), line('b', 4), line('c', 5)];

    expect(holdBatchesOf(lines, 3).map((batch) => batch.map((l) => l.n))).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it('gives an order larger than a batch batches of its own', () => {
    const lines = [{ orderId: 'a' }, { orderId: 'b' }, { orderId: 'b' }, { orderId: 'b' }];

    expect(holdBatchesOf(lines, 2).map((batch) => batch.length)).toEqual([1, 2, 1]);
  });
});

describe('OrderStock (spec 0013 AC-13)', () => {
  it('registers the orders.open_orders_held gate check at module start', () => {
    const { stock, gate } = stockWith();
    stock.onModuleInit();

    expect(gate.register).toHaveBeenCalledWith(
      expect.objectContaining({ key: OPEN_ORDERS_HELD_CHECK }),
    );
  });

  it('reserves every line at the online location with reserve_available and writes the shorts', async () => {
    const { stock, tx, ledger, writer } = stockWith({ unfilled: { [LINE_A]: 1 } });
    await stock.afterCreate(tx, ORDER, [LINE_A, LINE_B]);

    expect(ledger.reserveLines).toHaveBeenCalledWith(tx, {
      sourceType: 'order',
      sourceId: ORDER,
      shortage: 'reserve_available',
      lines: [
        { sourceLineId: LINE_A, variantId: SKU_A, locationId: ONLINE, quantity: 2 },
        { sourceLineId: LINE_B, variantId: SKU_B, locationId: ONLINE, quantity: 1 },
      ],
    });
    expect(writer.setShortQuantities).toHaveBeenCalledWith(tx, ORDER, [
      { lineId: LINE_A, shortQuantity: 1 },
      { lineId: LINE_B, shortQuantity: 0 },
    ]);
  });

  it('reserves nothing with no online location and marks every line short by its quantity', async () => {
    const { stock, tx, ledger, writer } = stockWith({ online: false });
    await stock.afterCreate(tx, ORDER, [LINE_A, LINE_B]);

    expect(ledger.reserveLines).not.toHaveBeenCalled();
    expect(writer.setShortQuantities).toHaveBeenCalledWith(tx, ORDER, [
      { lineId: LINE_A, shortQuantity: 2 },
      { lineId: LINE_B, shortQuantity: 1 },
    ]);
  });

  it('leaves an archived or lot tracked SKU unreserved, not short, and packable', async () => {
    const { stock, tx, ledger } = stockWith({
      skus: { [SKU_A]: { archived: true }, [SKU_B]: { tracking: 'lot' } },
    });
    await stock.topUp(tx, ORDER, true);

    expect(ledger.reserveLines).not.toHaveBeenCalled();
  });

  it('refuses a pack while a line is still short after the top up, but not a confirm', async () => {
    const short = stockWith({ unfilled: { [LINE_B]: 1 } });
    await expect(short.stock.topUp(short.tx, ORDER, true)).rejects.toBeInstanceOf(LineShort);
    await expect(short.stock.topUp(short.tx, ORDER, false)).resolves.toBeUndefined();

    const full = stockWith();
    await expect(full.stock.topUp(full.tx, ORDER, true)).resolves.toBeUndefined();
  });

  it('refuses a pack with no online location (every line reads short)', async () => {
    const { stock, tx } = stockWith({ online: false });

    await expect(stock.topUp(tx, ORDER, true)).rejects.toBeInstanceOf(LineShort);
  });

  it('releases the cancelled lines after locking every SKU row, then reserves the added ones', async () => {
    const { stock, tx, ledger, locks } = stockWith({
      lines: [{ id: LINE_B, variant_id: SKU_B, quantity: 1, short_quantity: 0 }],
    });
    await stock.afterEdit(tx, ORDER, { addedLineIds: [LINE_B], cancelledLineIds: [LINE_A] });

    const locked = locks.lockForShare.mock.invocationCallOrder[0] ?? 0;
    expect(locked).toBeLessThan(ledger.releaseLines.mock.invocationCallOrder[0] ?? 0);
    expect(ledger.releaseLines).toHaveBeenCalledWith(tx, {
      sourceType: 'order',
      sourceLineIds: [LINE_A],
    });
    expect(ledger.reserveLines).toHaveBeenCalledTimes(1);
    const released = ledger.releaseLines.mock.invocationCallOrder[0] ?? 0;
    expect(released).toBeLessThan(ledger.reserveLines.mock.invocationCallOrder[0] ?? 0);
  });

  it('releases the whole order on a cancel and clears its short quantities', async () => {
    const { stock, tx, ledger, writer } = stockWith();
    await stock.afterCancel(tx, ORDER);

    expect(ledger.releaseSource).toHaveBeenCalledWith(tx, { sourceType: 'order', sourceId: ORDER });
    expect(writer.clearShortQuantities).toHaveBeenCalledWith(tx, ORDER);
  });

  it('tops up only at the online location and keeps a line held elsewhere as it is', async () => {
    const { stock, tx, ledger } = stockWith({
      active: [{ sourceId: ORDER, sourceLineId: LINE_A, locationId: ELSEWHERE }],
    });
    await stock.topUp(tx, ORDER, false);

    const call = ledger.reserveLines.mock.calls[0]?.[1];
    expect(call?.lines.map((line) => line.sourceLineId)).toEqual([LINE_B]);
  });

  it('with no online location marks only the lines holding nothing short, and refuses a pack (review M1)', async () => {
    const { stock, tx, writer, ledger } = stockWith({
      online: false,
      active: [{ sourceId: ORDER, sourceLineId: LINE_A, locationId: ELSEWHERE }],
    });
    await expect(stock.topUp(tx, ORDER, true)).rejects.toBeInstanceOf(LineShort);

    expect(ledger.reserveLines).not.toHaveBeenCalled();
    expect(writer.setShortQuantities).toHaveBeenCalledWith(tx, ORDER, [
      { lineId: LINE_B, shortQuantity: 1 },
    ]);
  });

  it('takes the online flag lock before any other stock call, and locks the SKU rows to decide', async () => {
    const { stock, tx, ledger, onlineStock, locks, catalog } = stockWith();
    await stock.afterCreate(tx, ORDER, [LINE_A, LINE_B]);

    const flag = onlineStock.shareOnlineFlag.mock.invocationCallOrder[0] ?? Infinity;
    expect(flag).toBeLessThan(locks.lockForShare.mock.invocationCallOrder[0] ?? 0);
    expect(flag).toBeLessThan(ledger.reserveLines.mock.invocationCallOrder[0] ?? 0);
    expect(catalog.getSkus).not.toHaveBeenCalled();
  });

  it('takes no flag lock on a release only path: a cancel, or an edit that only removes lines (review N5)', async () => {
    const { stock, tx, onlineStock } = stockWith();
    await stock.afterCancel(tx, ORDER);
    await stock.afterEdit(tx, ORDER, { addedLineIds: [], cancelledLineIds: [LINE_A] });

    expect(onlineStock.shareOnlineFlag).not.toHaveBeenCalled();
    await stock.afterEdit(tx, ORDER, { addedLineIds: [LINE_B], cancelledLineIds: [LINE_A] });
    expect(onlineStock.shareOnlineFlag).toHaveBeenCalledTimes(1);
  });

  it('skips a SKU the lock finds archived instead of calling the ledger for it (review m3)', async () => {
    const { stock, tx, ledger } = stockWith({ skus: { [SKU_A]: { archived: true } } });
    await stock.afterCreate(tx, ORDER, [LINE_A, LINE_B]);

    const call = ledger.reserveLines.mock.calls[0]?.[1];
    expect(call?.lines.map((line) => line.sourceLineId)).toEqual([LINE_B]);
  });
});
