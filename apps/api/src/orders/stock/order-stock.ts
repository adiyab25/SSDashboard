import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  carrierShipmentKey,
  orderLabelOf,
  type AwaitingRestockCloseReason,
  type AwaitingRestockedReason,
  type ChannelFulfillmentPostReason,
  type FulfillmentState,
  type HoldOpenOrdersResult,
  type StockOutSource,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { CatalogLocks } from '../../catalog/catalog-locks.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ChannelsService } from '../../channels/channels.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor, type Transaction } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { TasksService } from '../../tasks/tasks.service.js';
import { auditActorOf, type OrderActor } from '../order-actor.js';
import { OrderAttentionRaised, attentionTaskKey } from '../orders.events.js';
import { ShipmentJobs } from '../shipment/shipment-jobs.js';
import { lockOrderForChange } from '../writer/locked-order.js';
import { returnedQuantitiesOf, type ChannelFulfilledLine } from './channel-fulfillment.js';
import { LedgerError } from '../../inventory/ledger/ledger.errors.js';
import { LedgerService } from '../../inventory/ledger/ledger.service.js';
import {
  OnlineStockGate,
  type OnlineGateCheckResult,
} from '../../inventory/online-stock/online-stock-gate.js';
import { OnlineStockError } from '../../inventory/online-stock/online-stock.errors.js';
import { OnlineStockService } from '../../inventory/online-stock/online-stock.service.js';
import {
  OrderTransactions,
  orderTransactionFromLedger,
  type OrderTransaction,
} from '../order-transactions.js';
import {
  ChannelReturnSourceRefused,
  CloseAlreadyRequested,
  LineShort,
  LocationNotFound,
  NoLinesDiffer,
  NothingAwaiting,
  OrderLocked,
  OrderNotFound,
  OrderStoreMissing,
  RestockKeyConflict,
  StockOutAlreadyRequested,
} from '../orders.errors.js';
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

/** The longest Shopify refund or return id `recordChannelReturn` keeps (code re-review N5). */
export const CHANNEL_RETURN_SOURCE_ID_MAX = 100;

/** The most refunds and returns one order keeps for the dedupe (code re-review N5). */
export const CHANNEL_RETURN_SOURCES_MAX = 200;

/** The most lines one `reserveLines` or `releaseLines` call takes, and one hold batch holds. */
export const STOCK_BATCH_LINES = 200;

/** A refund or return Shopify reported on an order (spec 0013 AC-27 d, spec 0015 AC-28). */
export interface ChannelReturn {
  /** The returned quantity per Shopify line item. */
  lines: readonly ChannelFulfilledLine[];
  source: { type: 'shopify_refund' | 'shopify_return'; id: string };
  /**
   * Whether Shopify marked the pieces to restock (default true). The pieces await restock either
   * way; when not marked, the attention's source type says `shopify_refund_no_restock`.
   */
  markedToRestock?: boolean;
}

/** What `recordChannelReturn` answers: the lines it put on the awaiting list, and how many. */
export type ChannelReturnResult =
  | { applied: true; lines: { lineId: string; added: number }[] }
  | { applied: false; why: 'not_shopify_stock_out' | 'already_applied' | 'nothing_to_await' };

/** What `restockAwaiting` answers: the restock posting's group, and whether it was a replay. */
export interface RestockResult {
  groupId: string;
  replayed: boolean;
}

/** One order line awaiting restock of a variant at a location, for spec 0011 AC-28. */
export interface PendingRestock {
  variantId: string;
  orderId: string;
  /** `<store code>/<order number>`, as every order label (AC-3). */
  label: string;
}

/** Where an awaiting line's pieces left from, and at what cost (AC-27 e). */
interface PostedFrom {
  locationId: string;
  unitCost: string;
}

/** The order reason code a restock posting's source type follows (AC-27 e). */
function restockSourceOf(
  fulfillmentState: FulfillmentState,
): 'returned_to_origin_restock' | 'customer_return_restock' {
  return fulfillmentState === 'cancelled'
    ? 'returned_to_origin_restock'
    : 'customer_return_restock';
}

/** One open order line with a variant, as the stock calls need it. */
interface StockLine {
  id: string;
  orderId: string;
  variantId: string;
  quantity: number;
  shortQuantity: number;
  /** The order is `packed`: its pieces are in a box, so a hold of it never moves (review N1). */
  packed?: boolean;
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
 * Every operation that can reserve (`afterCreate`, `afterLink`, `afterEdit` always, `topUp`,
 * and each hold batch) first takes the online flag lock shared
 * (`OnlineStockService.shareOnlineFlag`), before any other stock lock, so an order never reserves
 * at a location while the online flag moves away from it (review M2); those operations wait while
 * a flag move runs. `afterEdit` takes it even for an edit that only removes lines, because the
 * same unit may reserve next (the Shopify inbox applies a removal, then creates an exchange
 * replacement), and the shared lock must come before the release's location locks. Only
 * `afterCancel`, after which the order never reserves again, takes no flag lock (review N5). Then
 * it locks the SKU rows (`CatalogLocks.lockForShare`) and decides what is reservable from that
 * locked answer, so a SKU archived meanwhile is skipped, never a ledger refusal.
 *
 * It must never write an order table itself (the writer does), never read an inventory table (it
 * asks the ledger and the online stock service), and never open a transaction except one
 * `OrderTransactions.run` per hold batch. Lines without a variant, and lines whose SKU cannot hold
 * stock (archived, not a stocked kind, or lot tracked, which an order line cannot name), are
 * neither reserved nor short. With no online location nothing new is reserved: a line holding nothing reads
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
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(ShipmentJobs) private readonly shipments: ShipmentJobs,
    @Inject(TasksService) private readonly tasks: TasksService,
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
    // Always, also for a removal only edit: the unit may reserve next (final delta check).
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
    // A release only: no online location is read, so no flag lock (review N5).
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
   * A Shopify refund or return of the order (spec 0013 AC-27 d), called by feature 13 inside its
   * unit of work: for an order whose stock out came from a Shopify fulfillment, puts the returned
   * quantities on the matching lines' `awaiting_restock_quantity`, whether or not Shopify marked
   * them to restock, and raises `returned_pieces_to_receive` (source the refund or return, or
   * `shopify_refund_no_restock` when not marked). Each line takes at most its posted pieces not
   * yet awaiting, restocked, or closed, and a refund or return already applied (by its source type
   * and id) adds nothing and answers `already_applied` (owner ruling 2026-11-21). A source id
   * that is empty or longer than 100 characters, or a 201st source on one order, is refused with
   * `ChannelReturnSourceRefused` (code re-review N5). Returns of an
   * order that left stock otherwise stay with features 21, 34, and 35 (`not_shopify_stock_out`).
   * Moves no state and posts nothing.
   */
  async recordChannelReturn(
    tx: OrderTransaction,
    orderId: string,
    back: ChannelReturn,
    _actor: OrderActor,
  ): Promise<ChannelReturnResult> {
    if (!(await this.writer.lockOrder(tx, orderId))) throw new OrderNotFound();
    const { rows: orders } = await tx.execute<{ stock_out_source: StockOutSource | null }>(sql`
      SELECT stock_out_source FROM orders WHERE id = ${orderId}::uuid`);
    if (orders[0]?.stock_out_source !== 'shopify_fulfillment') {
      return { applied: false, why: 'not_shopify_stock_out' };
    }
    if (back.source.id.length === 0 || back.source.id.length > CHANNEL_RETURN_SOURCE_ID_MAX) {
      throw new ChannelReturnSourceRefused();
    }
    const source = `${back.source.type}:${back.source.id}`;
    const recorded = await this.writer.recordChannelReturnSource(
      tx,
      orderId,
      source,
      CHANNEL_RETURN_SOURCES_MAX,
    );
    if (recorded === 'full') throw new ChannelReturnSourceRefused();
    if (recorded === 'already') return { applied: false, why: 'already_applied' };
    const { rows } = await tx.execute<{
      id: string;
      channel_line_id: string | null;
      stock_out_quantity: number | null;
      awaiting_restock_quantity: number;
      restocked_quantity: number;
      closed_quantity: number;
    }>(sql`
      SELECT id, channel_line_id, stock_out_quantity, awaiting_restock_quantity,
             restocked_quantity, closed_quantity
      FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY position, id`);
    const wanted = returnedQuantitiesOf(
      rows.map((row) => ({
        id: row.id,
        channelLineId: row.channel_line_id,
        stockOutQuantity: row.stock_out_quantity,
        awaitingRestockQuantity: row.awaiting_restock_quantity,
        restockedQuantity: row.restocked_quantity,
        closedQuantity: row.closed_quantity,
      })),
      back.lines,
    );
    const lines = await this.writer.awaitReturn(tx, orderId, wanted);
    if (lines.length === 0) return { applied: false, why: 'nothing_to_await' };
    await this.events.publish(
      tx,
      new OrderAttentionRaised(
        orderId,
        'returned_pieces_to_receive',
        back.markedToRestock === false ? 'shopify_refund_no_restock' : back.source.type,
        back.source.id,
      ),
    );
    return { applied: true, lines };
  }

  /**
   * Puts `quantity` awaiting pieces of a line back on the shelf (spec 0013 AC-27 e): the "Received
   * on the shelf" action, feature 20's scan, and feature 21 call it; none posts on its own. A
   * replay of `order_restock:<orderId>:<lineId>:<userId>:<idempotencyKey>` (the actor type in place
   * of the user id for a system caller) answers the stored posting before
   * any awaiting check when it is the very same request (one movement of this line and quantity,
   * posted by the same person), and `RestockKeyConflict` (409 `IDEMPOTENCY_CONFLICT`) otherwise
   * (security review M). Otherwise it posts the quantity back with the ledger's `post` (source
   * `returned_to_origin_restock` for a cancelled order, `customer_return_restock` otherwise) at the
   * line's `unit_cost` (else the posting's), to the location the line left from in the latest
   * unreversed `order_shipment` posting, and in the posting's `within` moves the pieces from
   * `awaiting_restock_quantity` to `restocked_quantity` with a conditional update (the line lock comes after inventory's
   * locks) and writes `order.awaiting_restocked`; a row that does not match throws
   * `NothingAwaiting` and rolls the posting back. Never more than awaits. Opens its own ledger
   * transaction: never call it inside another.
   */
  async restockAwaiting(
    orderId: string,
    lineId: string,
    quantity: number,
    idempotencyKey: string,
    actor: OrderActor,
    how: AwaitingRestockedReason = 'received_on_shelf',
  ): Promise<RestockResult> {
    // The person is part of the key (security re-review): another person's request with the same
    // client key is a request of its own, never a replay of this one.
    const by = actor.type === 'person' ? actor.userId : actor.type;
    const key = `order_restock:${orderId}:${lineId}:${by}:${idempotencyKey}`.toLowerCase();
    const postedBy = actor.type === 'person' ? actor.userId : null;
    const replay = await this.ledger.postingFor(key);
    if (replay) {
      const [movement, ...others] = replay.movements;
      const same =
        others.length === 0 &&
        movement?.sourceLineId?.toLowerCase() === lineId.toLowerCase() &&
        movement.quantity === quantity &&
        (replay.postedBy?.toLowerCase() ?? null) === (postedBy?.toLowerCase() ?? null);
      if (!same) throw new RestockKeyConflict();
      return { groupId: replay.groupId, replayed: true };
    }
    const { rows } = await this.connection.db.execute<{
      variant_id: string | null;
      unit_cost: string | null;
      split_from_line_id: string | null;
      awaiting_restock_quantity: number;
      fulfillment_state: FulfillmentState;
      stock_out_generation: number;
      store_id: string;
      order_number: string;
    }>(sql`
      SELECT l.variant_id, l.unit_cost, l.split_from_line_id, l.awaiting_restock_quantity,
             o.fulfillment_state, o.stock_out_generation, o.store_id, o.order_number
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.id = ${lineId}::uuid AND l.order_id = ${orderId}::uuid`);
    const line = rows[0];
    if (!line?.variant_id || line.awaiting_restock_quantity < quantity || quantity <= 0) {
      throw new NothingAwaiting();
    }
    const from = await this.postedFrom(
      orderId,
      [lineId, line.split_from_line_id],
      line.stock_out_generation,
    );
    if (!from) throw new NothingAwaiting();
    const [store] = await this.channels.stores([line.store_id]);
    if (!store) throw new OrderStoreMissing();
    const variantId = line.variant_id;
    const outcome = await this.ledger.post(
      {
        idempotencyKey: key,
        sourceType: restockSourceOf(line.fulfillment_state),
        sourceId: orderId,
        postedBy,
        lines: [
          {
            variantId,
            locationId: from.locationId,
            quantity,
            unitCost: line.unit_cost ?? from.unitCost,
            sourceLineId: lineId,
          },
        ],
      },
      {
        within: async (stockTx) => {
          const tx = orderTransactionFromLedger(stockTx);
          const lowered = await this.writer.lowerAwaitingRestock(
            tx,
            orderId,
            lineId,
            quantity,
            'restocked',
          );
          if (!lowered) throw new NothingAwaiting();
          const auditActor = auditActorOf(actor);
          await this.audit.record(tx, {
            actor: auditActor,
            action: 'order.awaiting_restocked',
            record: {
              type: 'order',
              id: orderId,
              label: orderLabelOf({ storeCode: store.code, orderNumber: line.order_number }),
            },
            before: { lineId, awaitingRestockQuantity: lowered.before },
            after: { lineId, awaitingRestockQuantity: lowered.after, restockedQuantity: quantity },
            reason: how,
            correlationId: this.audit.newCorrelationId(auditActor),
          });
        },
      },
    );
    return { groupId: outcome.groupId, replayed: outcome.replayed };
  }

  /**
   * Closes awaiting pieces that never come back, or asks for it (spec 0013 AC-27 f), in the
   * caller's order transaction, under the order row lock and its concurrency token. With
   * `mayClose` (a `stock.correct` holder) it moves the pieces from `awaiting_restock_quantity` to
   * `closed_quantity` (`NothingAwaiting` when fewer await), which also settles any open close
   * request of the line, and writes `order.awaiting_restock_closed`; without it (a warehouse hat
   * with `stock.receive` only) it marks a close request open on the line, writes
   * `order.awaiting_restock_close_requested`, and raises `awaiting_restock_close_requested` for the
   * manager (source the line), the adjustment request pattern of spec 0011 AC-27. A second request
   * while one is open is refused with `CloseAlreadyRequested` (409 `CLOSE_ALREADY_REQUESTED`,
   * security review low). Closing posts no movement: the pieces already left the ledger.
   */
  async closeAwaiting(
    tx: OrderTransaction,
    orderId: string,
    lineId: string,
    close: { quantity: number; reasonCode: AwaitingRestockCloseReason; expectedUpdatedAt: string },
    person: Extract<OrderActor, { type: 'person' }>,
    mayClose: boolean,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId, close.expectedUpdatedAt);
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();
    const record = {
      type: 'order',
      id: orderId,
      label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
    };
    const auditActor = auditActorOf(person);
    if (mayClose) {
      const lowered = await this.writer.lowerAwaitingRestock(
        tx,
        orderId,
        lineId,
        close.quantity,
        'closed',
      );
      if (!lowered) throw new NothingAwaiting();
      await this.audit.record(tx, {
        actor: auditActor,
        action: 'order.awaiting_restock_closed',
        record,
        before: { lineId, awaitingRestockQuantity: lowered.before },
        after: { lineId, awaitingRestockQuantity: lowered.after, closedQuantity: close.quantity },
        reason: close.reasonCode,
        correlationId: this.audit.newCorrelationId(auditActor),
      });
      return;
    }
    const awaiting = await this.writer.requestAwaitingClose(tx, orderId, lineId, close.quantity);
    if (awaiting === null) throw new NothingAwaiting();
    if (awaiting === 'open') throw new CloseAlreadyRequested();
    await this.audit.record(tx, {
      actor: auditActor,
      action: 'order.awaiting_restock_close_requested',
      record,
      before: { lineId, awaitingRestockQuantity: awaiting },
      after: { lineId, awaitingRestockQuantity: awaiting, requestedQuantity: close.quantity },
      reason: close.reasonCode,
      correlationId: this.audit.newCorrelationId(auditActor),
    });
    await this.events.publish(
      tx,
      new OrderAttentionRaised(orderId, 'awaiting_restock_close_requested', 'order_line', lineId),
    );
  }

  /**
   * "Post what Shopify fulfilled" (spec 0013 AC-27 a), in the caller's order transaction, under the
   * order row lock and its concurrency token: requests the stock out of exactly the quantities
   * Shopify fulfilled (`fulfilled`, by order line id, as `ConnectorsService.channelFulfilledLines`
   * answers them; each capped at its line's quantity, a line Shopify did not fulfil at 0, so the
   * rest reads not shipped), releases the reservations of the lines it leaves out entirely (the
   * shipment job releases the rest of a partly posted line in its posting), enqueues the shipment
   * posting job, writes `order.channel_fulfillment_posted` (the posted and released quantity per
   * line), and closes the `fulfilled_lines_differ` attention's task. The frozen money stays as it
   * is. Refused with `StockOutAlreadyRequested` once a request exists, `OrderLocked` for a
   * cancelled order, and `NoLinesDiffer` when Shopify's quantities are unknown or equal the open
   * lines.
   */
  async postChannelFulfillment(
    tx: OrderTransaction,
    orderId: string,
    post: {
      reasonCode: ChannelFulfillmentPostReason;
      expectedUpdatedAt: string;
      fulfilled: readonly { lineId: string; quantity: number }[] | null;
    },
    person: Extract<OrderActor, { type: 'person' }>,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId, post.expectedUpdatedAt);
    if (order.stockOutSource !== null) throw new StockOutAlreadyRequested();
    if (order.fulfillmentState === 'cancelled') throw new OrderLocked();
    const fulfilled = new Map<string, number>();
    for (const line of post.fulfilled ?? []) {
      const id = line.lineId.toLowerCase();
      fulfilled.set(id, (fulfilled.get(id) ?? 0) + Math.max(line.quantity, 0));
    }
    const open = order.lines.filter((line) => line.lineState === 'open');
    const plan = open.map((line) => {
      const posted = Math.min(fulfilled.get(line.id.toLowerCase()) ?? 0, line.quantity);
      return { lineId: line.id, variantId: line.variantId, quantity: line.quantity, posted };
    });
    const differs = plan.some((line) => line.posted !== line.quantity);
    if (fulfilled.size === 0 || !differs || plan.every((line) => line.posted === 0)) {
      throw new NoLinesDiffer();
    }
    await this.writer.requestStockOut(tx, orderId, {
      source: 'shopify_fulfillment',
      at: new Date(),
      lines: plan.map((line) => ({ lineId: line.lineId, quantity: line.posted })),
    });
    const leftOut = plan.filter((line) => line.posted === 0);
    if (leftOut.length > 0) {
      await this.catalogLocks.lockForShare(
        tx,
        leftOut.flatMap((line) => (line.variantId ? [line.variantId] : [])),
      );
      await this.ledger.releaseLines(tx, {
        sourceType: SOURCE_TYPE,
        sourceLineIds: leftOut.map((line) => line.lineId),
      });
      await this.writer.setShortQuantities(
        tx,
        orderId,
        leftOut.map((line) => ({ lineId: line.lineId, shortQuantity: 0 })),
      );
    }
    await this.shipments.enqueuePost(tx, orderId, order.stockOutGeneration);
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();
    const auditActor = auditActorOf(person);
    await this.audit.record(tx, {
      actor: auditActor,
      action: 'order.channel_fulfillment_posted',
      record: {
        type: 'order',
        id: orderId,
        label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
      },
      before: { lines: plan.map((line) => ({ lineId: line.lineId, quantity: line.quantity })) },
      after: {
        lines: plan.map((line) => ({
          lineId: line.lineId,
          postedQuantity: line.posted,
          releasedQuantity: line.quantity - line.posted,
        })),
      },
      reason: post.reasonCode,
      correlationId: this.audit.newCorrelationId(auditActor),
    });
    await this.tasks.closeByKey(tx, attentionTaskKey('fulfilled_lines_differ', orderId), {
      outcome: 'cleared',
      by: { kind: 'system_job' },
    });
  }

  /**
   * The order lines awaiting restock of these variants whose pieces left from `locationId` (spec
   * 0011 AC-28, the `ReturnsAwaitingRestock` provider: a `found` adjustment of such a variant there
   * is a returned parcel, not a found piece), oldest awaiting first, each with its order's label.
   * Reads only.
   */
  async pendingFor(input: {
    variantIds: readonly string[];
    locationId: string;
  }): Promise<PendingRestock[]> {
    if (input.variantIds.length === 0) return [];
    const { rows } = await this.connection.db.execute<{
      id: string;
      order_id: string;
      variant_id: string;
      split_from_line_id: string | null;
      stock_out_generation: number;
      store_id: string;
      order_number: string;
    }>(sql`
      SELECT l.id, l.order_id, l.variant_id, l.split_from_line_id, o.stock_out_generation,
             o.store_id, o.order_number
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.awaiting_restock_quantity > 0
        AND l.variant_id = ANY(${pgArray(input.variantIds)}::uuid[])
      ORDER BY l.awaiting_restock_since, l.id`);
    const stores = new Map(
      (await this.channels.stores([...new Set(rows.map((row) => row.store_id))])).map((store) => [
        store.id,
        store.code,
      ]),
    );
    const pending: PendingRestock[] = [];
    for (const row of rows) {
      const from = await this.postedFrom(
        row.order_id,
        [row.id, row.split_from_line_id],
        row.stock_out_generation,
      );
      if (from?.locationId !== input.locationId) continue;
      pending.push({
        variantId: row.variant_id,
        orderId: row.order_id,
        label: orderLabelOf({
          storeCode: stores.get(row.store_id) ?? '',
          orderNumber: row.order_number,
        }),
      });
    }
    return pending;
  }

  /**
   * Raises `fulfillment_partial_stale` for the warehouse (spec 0013 *Domain events*, spec 0015
   * AC-28): the handler of the connectors' `ChannelFulfillmentPartialStale`, in the publisher's
   * transaction (source the connection). Spec 0015 task 9a publishes the event and registers this
   * handler; until then only tests call it.
   */
  async raiseFulfillmentPartialStale(
    tx: Transaction,
    event: { orderId: string; connectionId: string },
  ): Promise<void> {
    await this.events.publish(
      tx,
      new OrderAttentionRaised(
        event.orderId,
        'fulfillment_partial_stale',
        'connection',
        event.connectionId,
      ),
    );
  }

  /**
   * Where the line left from and at what cost (AC-27 e): its movement (by its id, or the line it
   * was split from) in the order's `order_shipment` posting of generation `generation`, the
   * order's current one, only. A line's awaiting pieces can only come from that posting, because
   * every move to a new generation brings the awaiting, restocked, and closed counters to 0; an
   * earlier generation's posting is never read, so a generation booked back with nothing left (no
   * reversal group under its key) can never pass for a standing posting (code re-review N1). Reads
   * only; null when the current generation has no posting yet or it did not move the line.
   */
  private async postedFrom(
    orderId: string,
    lineIds: readonly (string | null)[],
    generation: number,
  ): Promise<PostedFrom | null> {
    const wanted = new Set(lineIds.flatMap((id) => (id === null ? [] : [id.toLowerCase()])));
    const posting = await this.ledger.postingFor(carrierShipmentKey(orderId, generation));
    const movement = posting?.movements.find(
      (m) => m.sourceLineId !== null && m.quantity < 0 && wanted.has(m.sourceLineId.toLowerCase()),
    );
    return movement ? { locationId: movement.locationId, unitCost: movement.unitCost } : null;
  }

  /**
   * The `orders.open_orders_held` gate check (AC-26, spec 0011 AC-19): passes when every open line
   * with a variant of an order in `new`, `confirmed`, or `packed` holds an active reservation at
   * the candidate location or at the current online location (holds there stay there after the
   * move), and a line of a `packed` order counts as held wherever its active reservation is (its
   * pieces are in a box, review N1); `count` is the lines that do not. Reads only, through
   * `executor`, in a few set based statements whatever the number of open orders.
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
   * is reserved there; a line of a `new` or `confirmed` order held at a location that does not feed
   * online stock is released there and reserved here (releasing there cannot oversell); a line held
   * at the current online location, and a held line of a `packed` order wherever it is held, is
   * never touched (review N1). A shortage never refuses: the line waits for stock and counts in
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
    const { rows: holding } = await tx.execute<{ id: string; packed: boolean }>(sql`
      SELECT id, fulfillment_state = 'packed' AS packed FROM orders
      WHERE id = ANY(${pgArray(orderIds)}::uuid[])
        AND fulfillment_state IN ('new', 'confirmed', 'packed')
        AND stock_out_requested_at IS NULL`);
    const holdingIds = new Map(holding.map((row) => [row.id, row.packed]));
    const wanted = new Set(batch.map((line) => line.id));
    const open: StockLine[] = [];
    for (const orderId of orderIds) {
      if (!holdingIds.has(orderId)) continue;
      const packed = holdingIds.get(orderId) === true;
      for (const line of await this.openLines(tx, orderId)) {
        if (wanted.has(line.id)) open.push({ ...line, packed });
      }
    }
    const reservable = await this.reservable(open, tx, tx);
    const active = await this.activeAt([...new Set(reservable.map((line) => line.orderId))], tx);
    const elsewhere: string[] = [];
    const toHold = reservable.filter((line) => {
      const heldAt = active.get(line.id);
      if (heldAt === at || (heldAt !== undefined && heldAt === online)) return false;
      // A packed order's pieces are in a box: its hold never moves, wherever it is (review N1).
      if (heldAt !== undefined && line.packed === true) return false;
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
   * The open reservable lines of holding orders whose stock out is not requested (AC-26, AC-27:
   * the gate check and the hold skip such an order) that hold no active reservation at `locationId`
   * nor at the online location `onlineId` (spec 0011 AC-19), a held line of a `packed` order
   * excepted (it counts as held anywhere, review N1), oldest order first (`placed_at`,
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
      packed: boolean;
    }>(sql`
      SELECT l.id, l.order_id, l.variant_id, l.quantity, l.short_quantity,
             o.fulfillment_state = 'packed' AS packed
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.fulfillment_state IN ('new', 'confirmed', 'packed')
        AND o.stock_out_requested_at IS NULL
        AND l.line_state = 'open' AND l.variant_id IS NOT NULL
      ORDER BY o.placed_at, o.id, l.position, l.id`);
    const candidates = await this.reservable(
      rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        variantId: row.variant_id,
        quantity: row.quantity,
        shortQuantity: row.short_quantity,
        packed: row.packed,
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
      if (heldAt === undefined) return true;
      // A packed order held anywhere counts as held: its pieces are in a box (review N1).
      return !line.packed && heldAt !== at && heldAt !== online;
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
