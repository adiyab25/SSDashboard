import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { HoldOpenOrdersResult } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { CatalogLocks } from '../../catalog/catalog-locks.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { LedgerError } from '../../inventory/ledger/ledger.errors.js';
import { LedgerService } from '../../inventory/ledger/ledger.service.js';
import {
  OnlineStockGate,
  type OnlineGateCheckResult,
} from '../../inventory/online-stock/online-stock-gate.js';
import { OnlineStockError } from '../../inventory/online-stock/online-stock.errors.js';
import { OnlineStockService } from '../../inventory/online-stock/online-stock.service.js';
import { OrderTransactions, type OrderTransaction } from '../order-transactions.js';
import { LineShort, LocationNotFound } from '../orders.errors.js';
import { OrderWriter } from '../writer/order-writer.js';

/** The lines an edit took out and put in, by order line id. */
export interface EditedLines {
  addedLineIds: readonly string[];
  cancelledLineIds: readonly string[];
}

/** The key of the orders module's online gate check (spec 0013 AC-26). */
export const OPEN_ORDERS_HELD_CHECK = 'orders.open_orders_held';

/** The route that fixes a failed `orders.open_orders_held` check. */
export const HOLD_OPEN_ORDERS_PATH = '/api/orders/hold-open-orders';

/** The reservation source type of every order line (spec 0013 Write paths). */
const SOURCE_TYPE = 'order';

/** The most lines one `reserveLines` or `releaseLines` call takes, and one hold batch holds. */
export const STOCK_BATCH_LINES = 200;

/** One open order line with a variant, as the stock calls need it. */
interface StockLine {
  id: string;
  orderId: string;
  variantId: string;
  quantity: number;
  shortQuantity: number;
}

/** What one line's hold came to: how many pieces still wait for stock. */
interface HeldLine {
  lineId: string;
  unfilled: number;
}

/** Splits a list into runs of at most `size`, keeping its order. */
export function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/**
 * Splits the lines to hold into batches of at most `size` lines, oldest order first, keeping one
 * order's lines together whenever the order fits in a batch (an order with more lines than `size`
 * takes batches of its own). Pure; the input is already ordered oldest order first.
 */
export function holdBatchesOf<T extends { orderId: string }>(
  lines: readonly T[],
  size: number,
): T[][] {
  const byOrder: T[][] = [];
  for (const line of lines) {
    const last = byOrder.at(-1);
    if (last?.[0]?.orderId === line.orderId) last.push(line);
    else byOrder.push([line]);
  }
  const batches: T[][] = [];
  let current: T[] = [];
  for (const group of byOrder) {
    if (group.length > size) {
      if (current.length) batches.push(current);
      current = [];
      batches.push(...chunksOf(group, size));
      continue;
    }
    if (current.length + group.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Source ids per set based reservation read, so one bound array stays small. */
const READ_CHUNK = 5_000;

/**
 * The orders module's seam to the stock ledger (spec 0013 AC-13, AC-26, `stock/order-stock.ts`).
 * Every move that holds or frees stock calls it at its point in the order transaction:
 * `afterCreate` and `afterLink` reserve, `afterEdit` releases the cancelled lines and reserves the
 * added ones, `afterCancel` releases the whole order, and `topUp` (confirm and pack) tops short
 * lines up, a pack refusing a line still short with `LineShort` (409 `LINE_SHORT`, Q-16.5). Each
 * goes through spec 0011's `reserveLines` (`shortage: 'reserve_available'`), `releaseLines`, and
 * `releaseSource` with `sourceType: 'order'` at `OnlineStockService.onlineLocation()`, and writes
 * `short_quantity` from the answers through `OrderWriter`, after the unit's last `reserveLines`. It
 * also registers the `orders.open_orders_held` gate check and holds open orders at a location
 * before it goes online.
 *
 * Every operation first takes the online flag lock shared (`OnlineStockService.shareOnlineFlag`),
 * so an order never reserves at a location while the online flag moves away from it (review M2).
 * Then it locks the SKU rows (`CatalogLocks.lockForShare`) and decides what is reservable from that
 * locked answer, so a SKU archived meanwhile is skipped, never a ledger refusal.
 *
 * It must never write an order table itself (the writer does), never read an inventory table (it
 * asks the ledger and the online stock service), and never open a transaction except one
 * `OrderTransactions.run` per hold batch. Lines without a variant, and lines whose SKU cannot hold
 * stock (archived, not a stocked kind, or lot tracked, which an order line cannot name), are neither
 * reserved nor short. With no online location nothing new is reserved: a line holding nothing reads
 * short by its quantity, a held line keeps its stored short, and a pack is refused. A line whose
 * active reservation sits at another location keeps it and ships from there (spec 0011 AC-19:
 * reservations at the old location stay there).
 */
@Injectable()
export class OrderStock implements OnModuleInit {
  /** Takes the ledger, the online stock reads and gate, the catalog reads and locks, the writer, and the runner. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(OnlineStockService) private readonly onlineStock: OnlineStockService,
    @Inject(OnlineStockGate) private readonly gate: OnlineStockGate,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(CatalogLocks) private readonly catalogLocks: CatalogLocks,
    @Inject(OrderWriter) private readonly writer: OrderWriter,
    @Inject(OrderTransactions) private readonly transactions: OrderTransactions,
  ) {}

  /** Registers `orders.open_orders_held` with the online gate (spec 0013 AC-26). */
  onModuleInit(): void {
    this.gate.register({
      key: OPEN_ORDERS_HELD_CHECK,
      run: (locationId, executor) => this.openOrdersHeld(locationId, executor),
    });
  }

  /**
   * After an order is created (AC-13: reserve at creation): reserves every open line with a
   * variant at the online location. The caller never calls it for an order created past `packed`
   * or cancelled (an import in its found states, AC-14).
   */
  async afterCreate(
    tx: OrderTransaction,
    orderId: string,
    lineIds: readonly string[],
  ): Promise<void> {
    await this.onlineStock.shareOnlineFlag(tx);
    await this.reserveAtOnline(tx, orderId, await this.openLines(tx, orderId, lineIds));
  }

  /**
   * After `linkChannelLineVariant` mapped a line of an order still in `new`, `confirmed`, or
   * `packed` (AC-25 b): reserves that line.
   */
  async afterLink(tx: OrderTransaction, orderId: string, lineId: string): Promise<void> {
    await this.onlineStock.shareOnlineFlag(tx);
    await this.reserveAtOnline(tx, orderId, await this.openLines(tx, orderId, [lineId]));
  }

  /**
   * After an edit (AC-13): releases the reservations of the cancelled lines (their stock fills the
   * oldest waiting demand) and reserves the added ones, writing the short quantities after the
   * last `reserveLines`. The SKU rows of both sides are locked `FOR SHARE` up front in ascending
   * id; the pair locks are still taken per ledger call (release, then reserve), so two edits that
   * swap the same two sizes in opposite directions can deadlock, which the runner's single rerun
   * breaks.
   */
  async afterEdit(tx: OrderTransaction, orderId: string, lines: EditedLines): Promise<void> {
    await this.onlineStock.shareOnlineFlag(tx);
    const added = await this.openLines(tx, orderId, lines.addedLineIds);
    if (lines.cancelledLineIds.length > 0) {
      const cancelledVariants = await this.variantsOf(tx, orderId, lines.cancelledLineIds);
      await this.catalogLocks.lockForShare(tx, [
        ...cancelledVariants,
        ...added.map((line) => line.variantId),
      ]);
      for (const sourceLineIds of chunksOf(lines.cancelledLineIds, STOCK_BATCH_LINES)) {
        await this.ledger.releaseLines(tx, { sourceType: SOURCE_TYPE, sourceLineIds });
      }
    }
    await this.reserveAtOnline(tx, orderId, added);
  }

  /**
   * After a cancel (AC-7, AC-13): releases every reservation of the order (`releaseSource`) and
   * brings every line's `short_quantity` to 0.
   */
  async afterCancel(tx: OrderTransaction, orderId: string): Promise<void> {
    await this.onlineStock.shareOnlineFlag(tx);
    await this.ledger.releaseSource(tx, { sourceType: SOURCE_TYPE, sourceId: orderId });
    await this.writer.clearShortQuantities(tx, orderId);
  }

  /**
   * On confirm and before pack (AC-13): calls `reserveLines` again for the order's open lines,
   * which tops their waiting demand up, and writes the new short quantities. For a pack, a line
   * still short afterwards (and every reservable line while no location is online) throws
   * `LineShort` (409 `LINE_SHORT`), which rolls the pack back.
   */
  async topUp(tx: OrderTransaction, orderId: string, forPacking: boolean): Promise<void> {
    await this.onlineStock.shareOnlineFlag(tx);
    const held = await this.reserveAtOnline(tx, orderId, await this.openLines(tx, orderId));
    if (forPacking && held.some((line) => line.unfilled > 0)) throw new LineShort();
  }

  /**
   * The `orders.open_orders_held` gate check (AC-26, spec 0011 AC-19): passes when every open line
   * with a variant of an order in `new`, `confirmed`, or `packed` holds an active reservation at
   * the candidate location or at the current online location (holds there stay there after the
   * move); `count` is the lines that do not. Reads only, through `executor`, in a few set based
   * statements whatever the number of open orders.
   */
  async openOrdersHeld(locationId: string, executor: Executor): Promise<OnlineGateCheckResult> {
    const online = await this.onlineStock.onlineLocation(executor);
    const unheld = await this.unheldAt(locationId, online?.id ?? null, executor);
    return {
      label: 'orders.onlineGate.openOrdersHeld',
      passed: unheld.length === 0,
      count: unheld.length,
      action: {
        method: 'POST',
        path: HOLD_OPEN_ORDERS_PATH,
        label: 'orders.onlineGate.holdOpenOrders',
      },
    };
  }

  /**
   * `POST /api/orders/hold-open-orders` (AC-26, spec 0011 AC-19): reserves at `locationId` every
   * open line the gate check counts as unheld, oldest order first, one `OrderTransactions.run` per
   * batch of at most 200 lines, each order row locked first (ascending id). A line holding nothing
   * is reserved there; a line held at a location that does not feed online stock is released there
   * and reserved here (releasing there cannot oversell); a line held at the current online location
   * is never touched. A shortage never refuses: the line waits for stock and counts in
   * `linesShort`. A repeat holds nothing twice. Throws `LocationNotFound` for a missing or archived
   * location or one that could never feed online stock, and `OrderLockTimeout` (503 `BUSY`) when a
   * batch waits too long; batches already done stay done. Must not be called inside an order
   * transaction.
   */
  async holdOpenOrdersAt(locationId: string): Promise<HoldOpenOrdersResult> {
    await this.assertCandidate(locationId);
    const online = await this.onlineStock.onlineLocation();
    const unheld = await this.unheldAt(locationId, online?.id ?? null, this.connection.db);
    let linesHeld = 0;
    let linesShort = 0;
    for (const batch of holdBatchesOf(unheld, STOCK_BATCH_LINES)) {
      const done = await this.transactions.run((tx) => this.holdBatch(tx, batch, locationId));
      linesHeld += done.held;
      linesShort += done.short;
    }
    const after = await this.onlineStock.onlineLocation();
    const left = await this.unheldAt(locationId, after?.id ?? null, this.connection.db);
    return { linesHeld, linesShort, linesLeft: left.length };
  }

  /**
   * Holds one batch at the location inside its order transaction; rerunnable, keeps no state.
   * Order rows first (ascending id), then the online flag lock, then the SKU rows, then the ledger
   * calls (the releases, then one `reserveLines` per order), and the short quantities last, after
   * the batch's last `reserveLines`, so line rows are written after every pair lock, as a restock
   * does (security review L1).
   */
  private async holdBatch(
    tx: OrderTransaction,
    batch: readonly StockLine[],
    locationId: string,
  ): Promise<{ held: number; short: number }> {
    const at = locationId.toLowerCase();
    const orderIds = [...new Set(batch.map((line) => line.orderId.toLowerCase()))].sort();
    for (const orderId of orderIds) await this.writer.lockOrder(tx, orderId);
    await this.onlineStock.shareOnlineFlag(tx);
    const online = (await this.onlineStock.onlineLocation(tx))?.id.toLowerCase() ?? null;
    // Read again under the locks: an order may have moved on, or a line been cancelled.
    const { rows: holding } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM orders WHERE id = ANY(${pgArray(orderIds)}::uuid[])
        AND fulfillment_state IN ('new', 'confirmed', 'packed')`);
    const holdingIds = new Set(holding.map((row) => row.id));
    const wanted = new Set(batch.map((line) => line.id));
    const open: StockLine[] = [];
    for (const orderId of orderIds) {
      if (!holdingIds.has(orderId)) continue;
      open.push(...(await this.openLines(tx, orderId)).filter((line) => wanted.has(line.id)));
    }
    const reservable = await this.reservable(open, tx, tx);
    const active = await this.activeAt([...new Set(reservable.map((line) => line.orderId))], tx);
    const elsewhere: string[] = [];
    const toHold = reservable.filter((line) => {
      const heldAt = active.get(line.id);
      if (heldAt === at || (heldAt !== undefined && heldAt === online)) return false;
      if (heldAt !== undefined) elsewhere.push(line.id);
      return true;
    });
    if (!toHold.length) return { held: 0, short: 0 };
    if (elsewhere.length) {
      await this.ledger.releaseLines(tx, { sourceType: SOURCE_TYPE, sourceLineIds: elsewhere });
    }
    const byOrder = new Map<string, StockLine[]>();
    for (const line of toHold) {
      byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), line]);
    }
    const answers: { orderId: string; held: HeldLine[] }[] = [];
    for (const [orderId, lines] of byOrder) {
      answers.push({ orderId, held: await this.reserve(tx, orderId, lines, locationId) });
    }
    let held = 0;
    let short = 0;
    for (const answer of answers) {
      await this.writeShorts(tx, answer.orderId, answer.held);
      for (const line of answer.held) {
        if (line.unfilled > 0) short += 1;
        else held += 1;
      }
    }
    return { held, short };
  }

  /**
   * Reserves `lines` of one order at the online location and writes their short quantities after
   * the reservation; answers each reservable line's `unfilled` as the pack check reads it. A line
   * held at another location answers its stored short (it ships from where its pieces are). With no
   * online location every reservable line answers its full quantity (a pack is refused), while only
   * a line holding nothing is marked short by its quantity; a held line keeps its stored short,
   * which still copies its reservation's `unfilled_quantity` (review M1).
   */
  private async reserveAtOnline(
    tx: OrderTransaction,
    orderId: string,
    lines: readonly StockLine[],
  ): Promise<HeldLine[]> {
    const reservable = await this.reservable(lines, tx, tx);
    if (!reservable.length) return [];
    const active = await this.activeAt([orderId], tx);
    const online = await this.onlineStock.onlineLocation(tx);
    if (!online) {
      await this.writeShorts(
        tx,
        orderId,
        reservable
          .filter((line) => !active.has(line.id))
          .map((line) => ({ lineId: line.id, unfilled: line.quantity })),
      );
      return reservable.map((line) => ({ lineId: line.id, unfilled: line.quantity }));
    }
    const onlineId = online.id.toLowerCase();
    const here = reservable.filter((line) => {
      const heldAt = active.get(line.id);
      return heldAt === undefined || heldAt === onlineId;
    });
    const kept = reservable
      .filter((line) => !here.includes(line))
      .map((line) => ({ lineId: line.id, unfilled: line.shortQuantity }));
    const held = await this.reserve(tx, orderId, here, online.id);
    await this.writeShorts(tx, orderId, held);
    return [...held, ...kept];
  }

  /** `reserveLines` in runs of 200 at one location; answers each line's `unfilled`, writes nothing. */
  private async reserve(
    tx: OrderTransaction,
    orderId: string,
    lines: readonly StockLine[],
    locationId: string,
  ): Promise<HeldLine[]> {
    const held: HeldLine[] = [];
    for (const chunk of chunksOf(lines, STOCK_BATCH_LINES)) {
      const answers = await this.ledger.reserveLines(tx, {
        sourceType: SOURCE_TYPE,
        sourceId: orderId,
        shortage: 'reserve_available',
        lines: chunk.map((line) => ({
          sourceLineId: line.id,
          variantId: line.variantId,
          locationId,
          quantity: line.quantity,
        })),
      });
      for (const answer of answers) {
        held.push({ lineId: answer.sourceLineId, unfilled: answer.unfilled });
      }
    }
    return held;
  }

  /** Writes the short quantity of each answered line through the writer, in one statement. */
  private async writeShorts(
    tx: OrderTransaction,
    orderId: string,
    held: readonly HeldLine[],
  ): Promise<void> {
    if (!held.length) return;
    await this.writer.setShortQuantities(
      tx,
      orderId,
      held.map((line) => ({ lineId: line.lineId, shortQuantity: line.unfilled })),
    );
  }

  /**
   * The lines whose SKU can hold stock: stocked, not archived, and not lot tracked. Inside an order
   * transaction (`lockTx`) it locks the SKU rows `FOR SHARE` in ascending id first and decides on
   * that locked answer, so an archive cannot slip in before `reserveLines` (review m3); a read only
   * caller (the gate check) reads them without a lock.
   */
  private async reservable(
    lines: readonly StockLine[],
    executor: Executor,
    lockTx?: OrderTransaction,
  ): Promise<StockLine[]> {
    if (!lines.length) return [];
    const ids = lines.map((line) => line.variantId);
    const facts: ReadonlyMap<string, { archived: boolean; kind: string; tracking: string }> = lockTx
      ? await this.catalogLocks.lockForShare(lockTx, ids)
      : await this.catalog.getSkus(ids, executor);
    return lines.filter((line) => {
      const sku = facts.get(line.variantId);
      return sku !== undefined && !sku.archived && sku.kind === 'stocked' && sku.tracking !== 'lot';
    });
  }

  /** The active reservation location (lower case) of each line of these orders, by line id. */
  private async activeAt(
    orderIds: readonly string[],
    executor: Executor,
  ): Promise<Map<string, string>> {
    const active = new Map<string, string>();
    for (const chunk of chunksOf(orderIds, READ_CHUNK)) {
      const rows = await this.ledger.activeReservationLocations(SOURCE_TYPE, chunk, executor);
      for (const row of rows) {
        active.set(row.sourceLineId.toLowerCase(), row.locationId.toLowerCase());
      }
    }
    return active;
  }

  /** The open lines with a variant of one order (all of them, or those in `lineIds`), by position. */
  private async openLines(
    tx: OrderTransaction,
    orderId: string,
    lineIds?: readonly string[],
  ): Promise<StockLine[]> {
    if (lineIds?.length === 0) return [];
    const only = lineIds ? sql`AND id = ANY(${pgArray(lineIds)}::uuid[])` : sql``;
    const { rows } = await tx.execute<{
      id: string;
      variant_id: string;
      quantity: number;
      short_quantity: number;
    }>(sql`
      SELECT id, variant_id, quantity, short_quantity FROM order_lines
      WHERE order_id = ${orderId}::uuid AND line_state = 'open' AND variant_id IS NOT NULL ${only}
      ORDER BY position, id`);
    return rows.map((row) => ({
      id: row.id,
      orderId,
      variantId: row.variant_id,
      quantity: row.quantity,
      shortQuantity: row.short_quantity,
    }));
  }

  /** The variants of some lines of one order, whatever their state. */
  private async variantsOf(
    tx: OrderTransaction,
    orderId: string,
    lineIds: readonly string[],
  ): Promise<string[]> {
    const { rows } = await tx.execute<{ variant_id: string }>(sql`
      SELECT variant_id FROM order_lines
      WHERE order_id = ${orderId}::uuid AND id = ANY(${pgArray(lineIds)}::uuid[])
        AND variant_id IS NOT NULL`);
    return rows.map((row) => row.variant_id);
  }

  /**
   * The open reservable lines of holding orders that hold no active reservation at `locationId`
   * nor at the online location `onlineId` (spec 0011 AC-19), oldest order first (`placed_at`,
   * `id`, then line position). Reads only, through `executor`: one read of the lines, one of the
   * SKUs, and one set based read of the reservations per 5,000 orders.
   */
  private async unheldAt(
    locationId: string,
    onlineId: string | null,
    executor: Executor,
  ): Promise<StockLine[]> {
    const { rows } = await executor.execute<{
      id: string;
      order_id: string;
      variant_id: string;
      quantity: number;
      short_quantity: number;
    }>(sql`
      SELECT l.id, l.order_id, l.variant_id, l.quantity, l.short_quantity
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.fulfillment_state IN ('new', 'confirmed', 'packed')
        AND l.line_state = 'open' AND l.variant_id IS NOT NULL
      ORDER BY o.placed_at, o.id, l.position, l.id`);
    const candidates = await this.reservable(
      rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        variantId: row.variant_id,
        quantity: row.quantity,
        shortQuantity: row.short_quantity,
      })),
      executor,
    );
    const active = await this.activeAt(
      [...new Set(candidates.map((line) => line.orderId))],
      executor,
    );
    const at = locationId.toLowerCase();
    const online = onlineId?.toLowerCase() ?? null;
    return candidates.filter((line) => {
      const heldAt = active.get(line.id);
      return heldAt === undefined || (heldAt !== at && heldAt !== online);
    });
  }

  /**
   * Refuses a location that is missing, archived, or could never feed online stock, with
   * `LocationNotFound`, through the online stock service's candidate read (one variant row at
   * most).
   */
  private async assertCandidate(locationId: string): Promise<void> {
    try {
      await this.onlineStock.forCandidate(locationId, { limit: 1 });
    } catch (error) {
      if (
        (error instanceof LedgerError &&
          (error.code === 'UnknownReference' || error.code === 'InvalidInput')) ||
        (error instanceof OnlineStockError && error.code === 'NotOnlineCandidate')
      ) {
        throw new LocationNotFound();
      }
      throw error;
    }
  }
}
