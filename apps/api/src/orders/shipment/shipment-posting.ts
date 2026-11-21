import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  carrierShipmentKey,
  type FulfillmentState,
  type PostingResult,
  type StockOutSource,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { CatalogService } from '../../catalog/catalog.service.js';
import { DATABASE } from '../../database/database.module.js';
import { LedgerError } from '../../inventory/ledger/ledger.errors.js';
import { LedgerService } from '../../inventory/ledger/ledger.service.js';
import { OnlineStockService } from '../../inventory/online-stock/online-stock.service.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import {
  OrderTransactions,
  orderTransactionFromLedger,
  type OrderTransaction,
} from '../order-transactions.js';
import { OrderAttentionRaised } from '../orders.events.js';
import { OrderWriter } from '../writer/order-writer.js';
import { handledQuantitiesOf, type HandledPieces } from './handled-pieces.js';
import {
  AWAITING_RESTOCK_OVERDUE_DAYS,
  POST_SHIPMENT_RETRY,
  PostShipmentJobData,
  cancelReversalKey,
  fulfillmentReversalKey,
} from './post-shipment.queue.js';
import {
  counterPostingLines,
  decideAfterCancel,
  planShipment,
  unitCostsOf,
  type ShipmentPlan,
} from './shipment-plan.js';

/** The reason code of the after cancel reversal (the *After a cancel* table, row 4). */
export const CANCELLED_BEFORE_PICKUP_REASON = 'order_cancelled_before_pickup';

/** The reason code of the fulfillment reversal (spec 0013 AC-27 c). */
export const FULFILLMENT_CANCELLED_REASON = 'channel_fulfillment_cancelled';

/** The `source_type` of a `shipment_not_posted` attention raised by a failed job. */
const JOB_SOURCE = 'order_shipment_job';

/** The order a job names, read from data that failed `PostShipmentJobData`. */
const OrderOfJob = z.object({ orderId: z.uuid() });

/** What `bookBack` did: booked, nothing left to book, or the generation was already booked back. */
type BookBack = 'booked' | 'nothing_left' | 'already_reversed';

/** Which attempt of a job is running: the pg-boss job id and its retry count (0 first). */
export interface JobAttempt {
  jobId: string;
  retryCount: number;
}

/** What one job did, as its pg-boss output: ids and codes only. */
export type ShipmentJobOutcome =
  | { posted: true; groupId: string; lines: number }
  | { posted: false; why: string }
  | { afterCancel: string; row: number }
  | { reversed: boolean; why?: string }
  | { overdue: number };

/**
 * Stops a posting from inside its `within` when the order moved on while the job ran (code review
 * major 3, minor 1): the throw rolls the posting back and the job answers `why`. Never leaves this
 * file.
 */
class PostingAborted extends Error {
  constructor(readonly why: string) {
    super(`The posting was stopped: ${why}`);
  }
}

/** The order facts a job reads as it starts, without a lock. */
interface OrderStockOut extends Record<string, unknown> {
  fulfillment_state: FulfillmentState;
  stock_out_generation: number;
  stock_out_source: StockOutSource | null;
  stock_out_requested_at: Date | null;
}

/**
 * The work of the `orders.post_shipment` jobs (spec 0013 AC-24, AC-27 b), run by the worker's
 * `PostShipmentJob` and callable in process by tests.
 *
 * `post` books the order's one `order_shipment` per stock out generation through spec 0011's
 * `LedgerService.postCarrierShipment` under `order_shipment:<orderId>` (`:<n>` from generation 2):
 * it does nothing for a cancelled order, an old generation, or no request, reads
 * `ledger.postingFor(key)` first and stops when a posting exists (a retry never posts twice), and
 * builds the posting from the order's lines: each mapped line's `stock_out_quantity` at its
 * reservation's location (fulfilling it) or else the online location. In the posting's `within` it
 * writes each line's `unit_cost` (and its split rows'), brings each posted line's
 * `short_quantity` to 0, and raises `shipped_with_unmapped_lines` and `shipment_not_posted` for
 * lines it left out. A short line posts all the same (the ledger never
 * refuses for stock). `IdempotencyConflict` (a real race on the key) posts nothing and raises
 * `shipment_not_posted`; any other failure is thrown for pg-boss to retry, and the last attempt
 * raises `shipment_not_posted` instead.
 *
 * The posting's `within` first locks the order row (`FOR SHARE`) and checks again that the order
 * is not cancelled, still on `generation`, and still requested; when it moved on the posting rolls
 * back and the job answers why (code review minor 1).
 *
 * `afterCancel` decides by the ordered *After a cancel* table (`decideAfterCancel`): nothing, a
 * counter posting under `order_shipment_reversal:<orderId>:<n>` (reason
 * `order_cancelled_before_pickup`, row 4) whose `within` locks the order, checks that it is still
 * `cancelled` on generation `n` (else the posting rolls back and the job answers row 3's nothing,
 * code review major 3), and moves it to `n + 1`, or the posted pieces not yet restocked, closed, or
 * awaiting put on the awaiting restock list with `returned_pieces_to_receive` (row 5; a rerun adds
 * nothing).
 *
 * `fulfillmentReversal` books back generation `n`'s posting under
 * `order_shipment_fulfillment_reversal:<orderId>:<n>` (reason `channel_fulfillment_cancelled`,
 * AC-27 c) and changes nothing on the order (`recordChannelFulfillmentCancelled` already moved it
 * to `n + 1`); it skips unless the order is past `n`, and nothing posted, or already reversed by
 * either key, does nothing. Both reversals book back only the pieces not yet restocked or closed
 * (owner ruling 2026-11-21): with none handled they reverse the whole group (`ledger.reverse`),
 * else they post the rest through `ledger.post` (source `order_shipment`, inbound at each
 * movement's own location and unit cost) and raise `reversal_after_restock` for the warehouse in
 * the same transaction. When nothing is left to book back nothing is posted: the fulfillment
 * reversal answers `NOTHING_LEFT` (its attention was raised once by
 * `recordChannelFulfillmentCancelled`) and row 4 raises it with its generation move. Data that
 * does not parse raises `shipment_not_posted` for the order it names. `awaitingRestockOverdue` (the
 * daily schedule) raises `awaiting_restock_overdue` once per awaiting spell for each line awaiting
 * restock for 10 operating days or more (AC-27 g), so a missed day is caught up.
 *
 * It writes order rows only through `OrderWriter`, movements only through `LedgerService`, opens
 * order units only with `OrderTransactions.run`, and logs by order id only.
 */
@Injectable()
export class ShipmentPosting {
  private readonly logger = new Logger('OrderShipmentPosting');

  /** Takes the reads, the ledger, the online location, the writer, the runner, and the events. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(OnlineStockService) private readonly onlineStock: OnlineStockService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(OrderWriter) private readonly writer: OrderWriter,
    @Inject(OrderTransactions) private readonly transactions: OrderTransactions,
    @Inject(DomainEvents) private readonly events: DomainEvents,
  ) {}

  /** Runs one job of the queue by its kind; data that does not parse completes skipped. */
  async run(job: Pick<Job<object>, 'id' | 'data' | 'retryCount'>): Promise<object> {
    const data = PostShipmentJobData.safeParse(job.data);
    if (!data.success) {
      // Ids and codes only: the job's data is never printed (security review low).
      this.logger.warn(`Skipped an orders.post_shipment job with invalid data: job=${job.id}`);
      // Never silent (code re-review N4): an order job that cannot run asks someone to look.
      const order = OrderOfJob.safeParse(job.data);
      if (order.success) await this.raise(order.data.orderId, JOB_SOURCE, job.id);
      return { skipped: 'INVALID_JOB_DATA' };
    }
    const attempt = { jobId: job.id, retryCount: job.retryCount };
    switch (data.data.kind) {
      case 'post':
        return this.post(data.data, attempt);
      case 'after_cancel':
        return this.afterCancel(data.data);
      case 'fulfillment_reversal':
        return this.fulfillmentReversal(data.data);
      case 'awaiting_restock_overdue':
        return this.awaitingRestockOverdue();
    }
  }

  /** Books generation `generation`'s shipment posting of the order (see the class). */
  async post(
    data: { orderId: string; generation: number },
    attempt: JobAttempt,
  ): Promise<ShipmentJobOutcome> {
    const { orderId, generation } = data;
    const order = await this.orderOf(orderId);
    if (!order) return { posted: false, why: 'ORDER_NOT_FOUND' };
    if (order.fulfillment_state === 'cancelled') return { posted: false, why: 'CANCELLED' };
    if (order.stock_out_generation !== generation) {
      return { posted: false, why: 'OLD_GENERATION' };
    }
    if (order.stock_out_requested_at === null) return { posted: false, why: 'NOT_REQUESTED' };
    const key = carrierShipmentKey(orderId, generation);
    if (await this.ledger.postingFor(key)) return { posted: false, why: 'ALREADY_POSTED' };

    try {
      const plan = await this.planOf(orderId);
      if (plan.post.length === 0) {
        await this.transactions.run((tx) => this.raiseLeftOut(tx, orderId, plan));
        return { posted: false, why: 'NOTHING_TO_POST' };
      }
      const outcome = await this.ledger.postCarrierShipment(
        {
          orderId,
          generation,
          effectiveAt: order.stock_out_requested_at,
          postedBy: null,
          lines: plan.post,
        },
        {
          within: async (stockTx, result) => {
            const tx = orderTransactionFromLedger(stockTx);
            // Again under the order lock: a fulfillment cancel or a cancel may have committed
            // while the job planned (code review minor 1); the throw rolls the posting back.
            const current = await this.orderOf(orderId, tx, 'share');
            if (!current) throw new PostingAborted('ORDER_NOT_FOUND');
            if (current.fulfillment_state === 'cancelled') throw new PostingAborted('CANCELLED');
            if (current.stock_out_generation !== generation) {
              throw new PostingAborted('OLD_GENERATION');
            }
            if (current.stock_out_requested_at === null) throw new PostingAborted('NOT_REQUESTED');
            await this.writer.setUnitCosts(tx, orderId, unitCostsOf(result.movements));
            // The posting consumed each posted line's reservation, waiting demand included, and
            // the ledger publishes no `ReservationFilled` for that: its stock has left, so the
            // line is no longer short (AC-13: `short_quantity` copies `unfilled_quantity`, now 0).
            await this.writer.setShortQuantities(
              tx,
              orderId,
              plan.post.map((line) => ({ lineId: line.sourceLineId, shortQuantity: 0 })),
            );
            // A line posted for less than its quantity ("Post what Shopify fulfilled", AC-27 a)
            // keeps the rest of its reservation open: release it, on the posting's own keys.
            if (plan.partial.length > 0) {
              await this.ledger.releaseLines(stockTx, {
                sourceType: 'order',
                sourceLineIds: plan.partial,
              });
            }
            await this.raiseLeftOut(tx, orderId, plan);
          },
        },
      );
      return { posted: true, groupId: outcome.groupId, lines: plan.post.length };
    } catch (error) {
      if (error instanceof PostingAborted) return { posted: false, why: error.why };
      if (error instanceof LedgerError && error.code === 'IdempotencyConflict') {
        await this.raise(orderId, 'idempotency_conflict', attempt.jobId);
        return { posted: false, why: 'IDEMPOTENCY_CONFLICT' };
      }
      if (attempt.retryCount < POST_SHIPMENT_RETRY.retryLimit) throw error;
      const code = error instanceof LedgerError ? error.code : 'job_failed';
      this.logger.warn(`Shipment posting failed for order=${orderId}: ${code}`);
      await this.raise(orderId, JOB_SOURCE, attempt.jobId);
      return { posted: false, why: 'FAILED_AFTER_RETRIES' };
    }
  }

  /** Decides what a cancel does to generation `generation`'s posting (see the class). */
  async afterCancel(data: {
    orderId: string;
    generation: number;
    origin: 'person' | 'channel' | 'carrier';
    reasonCode: string;
  }): Promise<ShipmentJobOutcome> {
    const { orderId, generation } = data;
    const order = await this.orderOf(orderId);
    if (!order) return { afterCancel: 'ORDER_NOT_FOUND', row: 0 };
    const posting = await this.ledger.postingFor(carrierShipmentKey(orderId, generation));
    const reversed =
      posting !== null &&
      ((await this.ledger.postingFor(cancelReversalKey(orderId, generation))) !== null ||
        (await this.ledger.postingFor(fulfillmentReversalKey(orderId, generation))) !== null);
    const decision = decideAfterCancel({
      jobGeneration: generation,
      orderGeneration: order.stock_out_generation,
      posted: posting !== null,
      reversed,
      fulfillmentState: order.fulfillment_state,
      origin: data.origin,
      reasonCode: data.reasonCode,
      stockOutSource: order.stock_out_source,
    });
    switch (decision.then) {
      case 'nothing':
        return { afterCancel: 'nothing', row: decision.row };
      case 'fault':
        this.logger.error(`After cancel found a carrier shipped stock out on order=${orderId}`);
        return { afterCancel: 'fault', row: decision.row };
      case 'reverse': {
        if (!posting) return { afterCancel: 'nothing', row: 1 };
        const planned = await handledQuantitiesOf(this.connection.db, orderId, false);
        let booked: BookBack;
        try {
          booked = await this.bookBack(orderId, generation, posting, {
            idempotencyKey: cancelReversalKey(orderId, generation),
            reasonCode: CANCELLED_BEFORE_PICKUP_REASON,
            handled: planned,
            within: async (tx) => {
              // Again under the order lock: a carrier `shipped` (or any move) may have committed
              // since the decision (code review major 3); then this is row 3's nothing.
              if (!(await this.writer.lockOrder(tx, orderId))) {
                throw new PostingAborted('ORDER_NOT_FOUND');
              }
              const current = await this.orderOf(orderId, tx);
              if (
                current?.fulfillment_state !== 'cancelled' ||
                current.stock_out_generation !== generation
              ) {
                throw new PostingAborted('MOVED_ON');
              }
              // The counter posting was planned from these counts: a restock or close since then
              // needs a fresh plan, so the job fails and is retried.
              if (!sameHandled(await handledQuantitiesOf(tx, orderId, true), planned)) {
                throw new Error('The restocked or closed pieces changed while the job planned');
              }
              if (!(await this.writer.advanceStockOutGeneration(tx, orderId, generation))) {
                throw new PostingAborted('MOVED_ON');
              }
            },
            // The generation moves in the same unit, so a rerun meets row 1 and raises nothing.
            raiseWhenNothingLeft: true,
          });
        } catch (error) {
          if (error instanceof PostingAborted) return { afterCancel: 'nothing', row: 3 };
          if (error instanceof LedgerError && error.code === 'AlreadyReversed') {
            return { afterCancel: 'nothing', row: 2 };
          }
          throw error;
        }
        if (booked === 'already_reversed') return { afterCancel: 'nothing', row: 2 };
        return {
          afterCancel: booked === 'booked' ? 'reversed' : 'nothing_left',
          row: decision.row,
        };
      }
      case 'await_restock': {
        const posted = [
          ...new Set(
            (posting?.movements ?? []).flatMap((movement) =>
              movement.sourceLineId === null ? [] : [movement.sourceLineId],
            ),
          ),
        ];
        const awaiting = await this.transactions.run(async (tx) => {
          if (!(await this.writer.lockOrder(tx, orderId))) return [];
          // Read again under the lock: the order may have moved on since the job started.
          const current = await this.orderOf(orderId, tx);
          if (
            current?.fulfillment_state !== 'cancelled' ||
            current.stock_out_generation !== generation
          ) {
            return [];
          }
          const lines = await this.writer.awaitRestock(tx, orderId, posted);
          if (lines.length > 0) {
            await this.events.publish(
              tx,
              new OrderAttentionRaised(orderId, 'returned_pieces_to_receive', 'order', orderId),
            );
          }
          return lines;
        });
        return { afterCancel: awaiting.length > 0 ? 'awaiting_restock' : 'nothing', row: 5 };
      }
    }
  }

  /**
   * Books generation `generation`'s posting back because every Shopify fulfillment of the order
   * was cancelled (AC-27 c), under its own key and reason, less the pieces already restocked or
   * closed (`handled`). It changes nothing on the order: `recordChannelFulfillmentCancelled`
   * already moved it to the next generation. The after cancel book back of the same generation
   * cannot also run: that one acts only while the order is still on `generation` under the order
   * lock, this one only once it is past it, and `bookBack` refuses when either reversal key of the
   * generation is already used (a partial `ledger.post` never marks the group reversed, so the
   * ledger's `AlreadyReversed` alone would not stop a second one). When every piece was restocked
   * or closed nothing is booked and it answers `NOTHING_LEFT`; `recordChannelFulfillmentCancelled`
   * already raised `reversal_after_restock` for that case in its own transaction, once.
   */
  async fulfillmentReversal(data: {
    orderId: string;
    generation: number;
    handled?: readonly HandledPieces[];
  }): Promise<ShipmentJobOutcome> {
    const { orderId, generation } = data;
    // Only `recordChannelFulfillmentCancelled` moves the order past `n` before sending this job
    // (security review low): an order still on `n` was never cancelled in Shopify.
    const order = await this.orderOf(orderId);
    if (!order) return { reversed: false, why: 'ORDER_NOT_FOUND' };
    if (order.stock_out_generation <= generation) return { reversed: false, why: 'NOT_MOVED_ON' };
    const posting = await this.ledger.postingFor(carrierShipmentKey(orderId, generation));
    if (!posting) return { reversed: false, why: 'NOTHING_POSTED' };
    let booked: BookBack;
    try {
      booked = await this.bookBack(orderId, generation, posting, {
        idempotencyKey: fulfillmentReversalKey(orderId, generation),
        reasonCode: FULFILLMENT_CANCELLED_REASON,
        handled: data.handled ?? [],
        within: () => Promise.resolve(),
        // Raised by `recordChannelFulfillmentCancelled`, in the transaction that read the counts.
        raiseWhenNothingLeft: false,
      });
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'AlreadyReversed') {
        return { reversed: false, why: 'ALREADY_REVERSED' };
      }
      throw error;
    }
    switch (booked) {
      case 'booked':
        return { reversed: true };
      case 'nothing_left':
        return { reversed: false, why: 'NOTHING_LEFT' };
      case 'already_reversed':
        return { reversed: false, why: 'ALREADY_REVERSED' };
    }
  }

  /**
   * Books generation `generation`'s shipment posting back, less the pieces already restocked or
   * closed (owner ruling 2026-11-21), under `idempotencyKey`, running `within` in the same
   * transaction. It answers `already_reversed` and books nothing when either reversal key of the
   * generation (`order_shipment_reversal`, `order_shipment_fulfillment_reversal`) is already used:
   * the one place the rule "a generation is booked back at most once" lives, because a partial
   * `ledger.post` never marks the group reversed (code re-review N2). Exclusion under concurrency
   * comes from the callers' generation checks under the order lock (row 4 acts only while the
   * order is on the generation, the fulfillment reversal only once it is past it). With nothing
   * handled it reverses the whole group (`ledger.reverse`). Otherwise it posts the rest
   * (`counterPostingLines`) through `ledger.post` as an inbound `order_shipment` at each
   * movement's own location, bin, lot, and unit cost and raises `reversal_after_restock` (source
   * the order) in that transaction, so the warehouse checks the shelf; when nothing is left it
   * books nothing and answers `nothing_left`, running `within` (and raising the attention when
   * `raiseWhenNothingLeft`) in an order unit of its own.
   */
  private async bookBack(
    orderId: string,
    generation: number,
    posting: PostingResult,
    input: {
      idempotencyKey: string;
      reasonCode: string;
      handled: readonly HandledPieces[];
      within: (tx: OrderTransaction) => Promise<void>;
      raiseWhenNothingLeft: boolean;
    },
  ): Promise<BookBack> {
    if (
      (await this.ledger.postingFor(cancelReversalKey(orderId, generation))) !== null ||
      (await this.ledger.postingFor(fulfillmentReversalKey(orderId, generation))) !== null
    ) {
      return 'already_reversed';
    }
    if (input.handled.length === 0) {
      await this.ledger.reverse(
        {
          groupId: posting.groupId,
          idempotencyKey: input.idempotencyKey,
          postedBy: null,
          reasonCode: input.reasonCode,
        },
        { within: (stockTx) => input.within(orderTransactionFromLedger(stockTx)) },
      );
      return 'booked';
    }
    const raise = async (tx: OrderTransaction): Promise<void> => {
      await input.within(tx);
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'reversal_after_restock', 'order', orderId),
      );
    };
    const lines = counterPostingLines(posting.movements, input.handled, input.reasonCode);
    if (lines.length === 0) {
      await this.transactions.run(input.raiseWhenNothingLeft ? raise : input.within);
      return 'nothing_left';
    }
    await this.ledger.post(
      {
        idempotencyKey: input.idempotencyKey,
        sourceType: 'order_shipment',
        sourceId: orderId,
        postedBy: null,
        lines,
      },
      { within: (stockTx) => raise(orderTransactionFromLedger(stockTx)) },
    );
    return 'booked';
  }

  /**
   * The daily awaiting restock check (AC-27 g, amended 2026-11-21): raises
   * `awaiting_restock_overdue` (source `order_line`, the line id) for each line awaiting restock
   * for 10 operating days or more (`ssd_operating_day`) whose awaiting spell was not raised yet,
   * marking it raised in the same unit, so a day the schedule missed is caught up and a line is
   * raised once per spell (the mark clears when its awaiting quantity reaches 0). Answers how many
   * it raised.
   */
  async awaitingRestockOverdue(): Promise<ShipmentJobOutcome> {
    const raised = await this.transactions.run(async (tx) => {
      const rows = await this.writer.markAwaitingRestockOverdue(tx, AWAITING_RESTOCK_OVERDUE_DAYS);
      for (const row of rows) {
        await this.events.publish(
          tx,
          new OrderAttentionRaised(row.order_id, 'awaiting_restock_overdue', 'order_line', row.id),
        );
      }
      return rows.length;
    });
    return { overdue: raised };
  }

  /** The stock out lines, reservations, SKU kinds, and online location, planned into a posting. */
  private async planOf(orderId: string): Promise<ShipmentPlan> {
    const { rows } = await this.connection.db.execute<{
      id: string;
      variant_id: string | null;
      quantity: number;
      stock_out_quantity: number;
    }>(sql`
      SELECT id, variant_id, quantity, stock_out_quantity FROM order_lines
      WHERE order_id = ${orderId}::uuid AND stock_out_quantity > 0
      ORDER BY position, id`);
    const variantIds = rows.flatMap((row) => (row.variant_id === null ? [] : [row.variant_id]));
    const [reservations, skus, online] = await Promise.all([
      this.ledger.reservationsFor({ sourceType: 'order', sourceId: orderId }),
      this.catalog.getSkus(variantIds),
      this.onlineStock.onlineLocation(),
    ]);
    return planShipment(
      rows.map((row) => ({
        id: row.id,
        variantId: row.variant_id,
        quantity: row.stock_out_quantity,
        lineQuantity: row.quantity,
      })),
      reservations.filter((held) => held.status === 'active'),
      skus,
      online?.id ?? null,
    );
  }

  /** Raises the attentions of the lines a posting left out, in the caller's transaction. */
  private async raiseLeftOut(
    tx: OrderTransaction,
    orderId: string,
    plan: ShipmentPlan,
  ): Promise<void> {
    if (plan.unmapped.length > 0) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'shipped_with_unmapped_lines', 'order', orderId),
      );
    }
    for (const lineId of plan.unlocated) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'shipment_not_posted', 'order_line', lineId),
      );
    }
  }

  /** Raises `shipment_not_posted` in a unit of its own. */
  private async raise(orderId: string, sourceType: string, sourceId: string): Promise<void> {
    await this.transactions.run((tx) =>
      this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'shipment_not_posted', sourceType, sourceId),
      ),
    );
  }

  /**
   * The order's state and stock out columns, read without a lock (or in `tx`, `FOR SHARE` when
   * `lock` asks for it).
   */
  private async orderOf(
    orderId: string,
    tx?: OrderTransaction,
    lock?: 'share',
  ): Promise<OrderStockOut | null> {
    const executor = tx ?? this.connection.db;
    const { rows } = await executor.execute<OrderStockOut>(sql`
      SELECT fulfillment_state, stock_out_generation, stock_out_source, stock_out_requested_at
      FROM orders WHERE id = ${orderId}::uuid ${lock === 'share' ? sql`FOR SHARE` : sql``}`);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      stock_out_requested_at:
        row.stock_out_requested_at === null ? null : new Date(row.stock_out_requested_at),
    };
  }
}

/** Whether two reads of the handled pieces agree, line by line. */
function sameHandled(a: readonly HandledPieces[], b: readonly HandledPieces[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Map(a.map((line) => [line.lineId.toLowerCase(), line.quantity]));
  return b.every((line) => seen.get(line.lineId.toLowerCase()) === line.quantity);
}
