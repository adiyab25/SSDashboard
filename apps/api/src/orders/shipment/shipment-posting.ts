import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  carrierShipmentKey,
  type FulfillmentState,
  type StockOutSource,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import type { Job } from 'pg-boss';
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
import {
  POST_SHIPMENT_RETRY,
  PostShipmentJobData,
  cancelReversalKey,
  fulfillmentReversalKey,
} from './post-shipment.queue.js';
import {
  decideAfterCancel,
  planShipment,
  unitCostsOf,
  type ShipmentPlan,
} from './shipment-plan.js';

/** The reason code of the after cancel reversal (the *After a cancel* table, row 4). */
export const CANCELLED_BEFORE_PICKUP_REASON = 'order_cancelled_before_pickup';

/** The `source_type` of a `shipment_not_posted` attention raised by a failed job. */
const JOB_SOURCE = 'order_shipment_job';

/** Which attempt of a job is running: the pg-boss job id and its retry count (0 first). */
export interface JobAttempt {
  jobId: string;
  retryCount: number;
}

/** What one job did, as its pg-boss output: ids and codes only. */
export type ShipmentJobOutcome =
  | { posted: true; groupId: string; lines: number }
  | { posted: false; why: string }
  | { afterCancel: string; row: number };

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
 * writes each line's `unit_cost` (and its split rows') and raises `shipped_with_unmapped_lines` and
 * `shipment_not_posted` for lines it left out. A short line posts all the same (the ledger never
 * refuses for stock). `IdempotencyConflict` (a real race on the key) posts nothing and raises
 * `shipment_not_posted`; any other failure is thrown for pg-boss to retry, and the last attempt
 * raises `shipment_not_posted` instead.
 *
 * `afterCancel` decides by the ordered *After a cancel* table (`decideAfterCancel`): nothing, a
 * reversal under `order_shipment_reversal:<orderId>:<n>` (reason `order_cancelled_before_pickup`)
 * that moves the order to generation `n + 1` in its `within`, or the posted quantities put on the
 * awaiting restock list with `returned_pieces_to_receive`.
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
    if (!data.success) return { skipped: 'INVALID_JOB_DATA' };
    const attempt = { jobId: job.id, retryCount: job.retryCount };
    switch (data.data.kind) {
      case 'post':
        return this.post(data.data, attempt);
      case 'after_cancel':
        return this.afterCancel(data.data);
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
            await this.writer.setUnitCosts(tx, orderId, unitCostsOf(result.movements));
            await this.raiseLeftOut(tx, orderId, plan);
          },
        },
      );
      return { posted: true, groupId: outcome.groupId, lines: plan.post.length };
    } catch (error) {
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
        try {
          await this.ledger.reverse(
            {
              groupId: posting.groupId,
              idempotencyKey: cancelReversalKey(orderId, generation),
              postedBy: null,
              reasonCode: CANCELLED_BEFORE_PICKUP_REASON,
            },
            {
              within: async (stockTx) => {
                await this.writer.advanceStockOutGeneration(
                  orderTransactionFromLedger(stockTx),
                  orderId,
                  generation,
                );
              },
            },
          );
        } catch (error) {
          if (error instanceof LedgerError && error.code === 'AlreadyReversed') {
            return { afterCancel: 'nothing', row: 2 };
          }
          throw error;
        }
        return { afterCancel: 'reversed', row: decision.row };
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

  /** The stock out lines, reservations, SKU kinds, and online location, planned into a posting. */
  private async planOf(orderId: string): Promise<ShipmentPlan> {
    const { rows } = await this.connection.db.execute<{
      id: string;
      variant_id: string | null;
      stock_out_quantity: number;
    }>(sql`
      SELECT id, variant_id, stock_out_quantity FROM order_lines
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

  /** The order's state and stock out columns, read without a lock (or in `tx`). */
  private async orderOf(orderId: string, tx?: OrderTransaction): Promise<OrderStockOut | null> {
    const executor = tx ?? this.connection.db;
    const { rows } = await executor.execute<OrderStockOut>(sql`
      SELECT fulfillment_state, stock_out_generation, stock_out_source, stock_out_requested_at
      FROM orders WHERE id = ${orderId}::uuid`);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      stock_out_requested_at:
        row.stock_out_requested_at === null ? null : new Date(row.stock_out_requested_at),
    };
  }
}
