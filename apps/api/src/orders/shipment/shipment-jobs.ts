import { Inject, Injectable } from '@nestjs/common';
import { JobSender } from '../../platform/jobs/job-sender.js';
import type { OrderTransaction } from '../order-transactions.js';
import type { HandledPieces } from './handled-pieces.js';
import {
  POST_SHIPMENT_QUEUE,
  orderGroup,
  type CancelOrigin,
  type PostShipmentJobData,
} from './post-shipment.queue.js';

/**
 * Puts the order's stock out jobs on `orders.post_shipment` inside the order transaction (spec
 * 0013 AC-15, AC-24, AC-27 b), so a job exists if and only if the move that asked for it commits,
 * and a deadlock rerun of the unit sends it once. Every job is sent in its order's group with the
 * order's stock out generation. It never posts stock and never reads an order itself.
 */
@Injectable()
export class ShipmentJobs {
  /** Takes the process's job sender (the api's send only client, or the worker's). */
  constructor(@Inject(JobSender) private readonly jobs: JobSender) {}

  /** Asks for generation `generation`'s shipment posting of the order (AC-24). */
  async enqueuePost(tx: OrderTransaction, orderId: string, generation: number): Promise<void> {
    const data: PostShipmentJobData = { kind: 'post', orderId, generation };
    await this.jobs.sendIn(tx, POST_SHIPMENT_QUEUE, data, orderGroup(orderId));
  }

  /** Asks the after cancel job to decide what this cancel does to generation `generation` (AC-27 b). */
  async enqueueAfterCancel(
    tx: OrderTransaction,
    orderId: string,
    generation: number,
    cancel: { origin: CancelOrigin; reasonCode: string },
  ): Promise<void> {
    const data: PostShipmentJobData = { kind: 'after_cancel', orderId, generation, ...cancel };
    await this.jobs.sendIn(tx, POST_SHIPMENT_QUEUE, data, orderGroup(orderId));
  }

  /**
   * Asks the fulfillment reversal of generation `generation` (AC-27 c: every fulfillment
   * cancelled), with the pieces of each line already restocked or closed in that generation, which
   * the reversal must not book back (owner ruling 2026-11-21).
   */
  async enqueueFulfillmentReversal(
    tx: OrderTransaction,
    orderId: string,
    generation: number,
    handled: readonly HandledPieces[],
  ): Promise<void> {
    const data: PostShipmentJobData = {
      kind: 'fulfillment_reversal',
      orderId,
      generation,
      handled: handled.map((line) => ({ lineId: line.lineId, quantity: line.quantity })),
    };
    await this.jobs.sendIn(tx, POST_SHIPMENT_QUEUE, data, orderGroup(orderId));
  }
}
