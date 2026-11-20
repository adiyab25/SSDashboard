import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  InvalidTransition,
  Money,
  ORDER_COLLECTION_REASONS,
  ORDER_PARTIAL_DELIVERY_REASONS,
  codDue,
  nextState,
  orderLabelOf,
  systemJobActor,
  type CashState,
  type OrderTaskKind,
} from '@ssdashboard/contracts';
import { AuditService, type JsonObject } from '../../audit/audit.service.js';
import { ChannelsService } from '../../channels/channels.service.js';
import { ConnectorsService } from '../../connectors/connectors.service.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { actorTypeOf, auditActorOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import {
  CancelInShopify,
  DuplicateTargetRequired,
  InvalidOrderInput,
  OrderLocked,
  OrderStoreMissing,
  WriteBackOpen,
} from '../orders.errors.js';
import { LinesReturnedToOrigin, OrderAttentionRaised, OrderCancelled } from '../orders.events.js';
import { ShipmentJobs } from '../shipment/shipment-jobs.js';
import {
  carrierShippedFactExists,
  fulfilledLinesDiffer,
  type ChannelFulfilledLine,
} from '../stock/channel-fulfillment.js';
import { OrderStock } from '../stock/order-stock.js';
import { TasksService } from '../../tasks/tasks.service.js';
import { lockLinkTarget, lockOrderForChange, type LockedOrder } from '../writer/locked-order.js';
import { OrderWriter, type NewEventRow, type OrderColumnChanges } from '../writer/order-writer.js';
import {
  assertWellFormedFact,
  leavesNothingToCollect,
  lineMoveOf,
  linesAfterMoves,
  moneyAfter,
  planLineMoves,
  planPartialDelivery,
  type DeliveredQuantity,
  type ShipmentFactState,
} from './carrier-moves.js';

/** A person moving an order by hand. */
type PersonActor = Extract<OrderActor, { type: 'person' }>;

/** What a cancel needs (spec 0013 AC-7). */
export interface CancelInput {
  /** A cancel reason code; `channel.` codes for a channel, `carrier.` codes for the carrier. */
  reasonCode: string;
  /** The order this one duplicates; required with the `duplicate` reason, refused otherwise. */
  duplicateOfOrderId?: string | null;
}

/** Where a carrier delivery fact came from (spec 0013 AC-15). */
export interface CarrierDeliveryFact {
  /** When the delivery was created at the carrier, or the Shopify fulfillment was made. */
  at: Date;
  source: { type: 'carrier_delivery' | 'shopify_fulfillment'; id: string };
}

/** Where a carrier, settlement, or exchange fact came from: recorded on its event row. */
export interface FactSource {
  /** What reported it, for example `carrier_delivery_event` or `settlement_match`. */
  type: string;
  id: string;
}

/** A carrier fact for `recordShipmentFact` (AC-15). */
export interface ShipmentFact {
  to: ShipmentFactState;
  /** When the carrier says it happened. */
  occurredAt: Date;
  /** A `RefusedReasonCode` for `refused`, a `carrier.` code for `cancelled`, a reason for a person's `lost`. */
  reasonCode?: string | null;
  source: FactSource;
}

/** A partial delivery for `recordPartialDelivery` (AC-16). */
export interface PartialDelivery {
  /** The named lines and how many of each were delivered; every other open line is delivered whole. */
  lines: readonly DeliveredQuantity[];
  occurredAt: Date;
  source: FactSource;
  /**
   * The `order.partial_delivery_split` reason (`carrier_report`, `courier_note`, `other`); a
   * carrier's split defaults to `carrier_report`.
   */
  reasonCode?: string | null;
}

/** A cash collection for `recordCollection` (AC-17). */
export interface CollectionFact {
  /** The collected total after this report (a later call corrects it), a money string above 0. */
  amount: string;
  occurredAt: Date;
  source: FactSource;
  /** Required for a person (`courier_note`, `carrier_missing_report`, `correction`). */
  reasonCode?: string | null;
}

/** A collection reversal for `reverseCollection` (AC-17). */
export interface CollectionReversal {
  occurredAt: Date;
  source: FactSource;
  /** Required for a person (the collection reasons). */
  reasonCode?: string | null;
}

/** A settlement move for `recordSettlement` (AC-17). */
export interface SettlementChange {
  /**
   * `remitted` (from `collected_by_carrier`, or the revoke from `reconciled`), `reconciled` (from
   * `remitted` or `prepaid`), or `collected_by_carrier` (the revoke from `remitted`).
   */
  to: Extract<CashState, 'remitted' | 'reconciled' | 'collected_by_carrier'>;
  /** The deposited amount of the matched lines; required for a remittance. */
  remittedAmount?: string;
  /** The statement's deposit date (`YYYY-MM-DD`); required for a remittance. */
  depositedOn?: string;
  /** True once every settlement line of the order is matched or accounted; required for `reconciled` from `remitted`. */
  fullySettled?: boolean;
  /** Required for the two revokes. */
  reasonCode?: string | null;
  /** The settlement match that caused the move. */
  sourceId: string;
}

/** A Shopify fulfillment's stock out for `recordChannelStockOut` (spec 0013 AC-15, AC-27 a). */
export interface ChannelStockOut {
  /** When Shopify fulfilled the order: the stock out request's time. */
  at: Date;
  source: { type: 'shopify_fulfillment'; id: string };
  /** The quantity Shopify fulfilled, per Shopify line item. */
  fulfilledLines: readonly ChannelFulfilledLine[];
}

/** What `recordChannelStockOut` answers. */
export type ChannelStockOutResult =
  | { requested: true }
  | { requested: false; why: 'lines_differ' | 'already_requested' | 'cancelled' };

/** Every Shopify fulfillment of the order was cancelled (spec 0013 AC-27 c). */
export interface ChannelFulfillmentCancelled {
  at: Date;
  source: { type: string; id: string };
}

/** The dedupe key of an order attention's task (spec 0016 AC-9), which orders closes as `cleared`. */
export function attentionTaskKey(kind: string, orderId: string): string {
  return `order_attention:${kind}:${orderId}`;
}

/** The system job named on the automatic `unpaid` to `nothing_to_collect` move after a cancel. */
const NOTHING_TO_COLLECT_JOB = 'orders.nothing_to_collect';

/** The `source_type` of a settlement move's event row. */
const SETTLEMENT_SOURCE = 'settlement_match';

/** The `source_type` of an exchange's event row. */
const EXCHANGE_SOURCE = 'exchange';

/** A deposit date as a settlement statement carries it. */
const DEPOSIT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The named moves of the order state machines (spec 0013 AC-7, AC-8, AC-15 to AC-17): `confirm`,
 * `cancel`, `markPacked`, `unpack`, and `recordCarrierDelivery` (milestone 2), and the carrier and
 * cash moves of milestone 5 task 14: `recordShipmentFact`, `recordPartialDelivery`,
 * `recordCollection`, `reverseCollection`, `recordSettlement`, and `markExchanged`. Each takes the
 * order row lock first, checks the concurrency token when the caller passes one, checks the move
 * with `nextState` and the guards it leaves to the service, writes the row and its event rows
 * through `OrderWriter`, and publishes its events, all in the caller's order transaction. It never
 * writes an order table itself, never opens or commits a transaction, and never moves a state
 * outside the transition tables. Stock calls go through `OrderStock` (reserve, release, top up).
 */
@Injectable()
export class OrderTransitions {
  /** Takes the services the moves call: never another module's tables. */
  constructor(
    private readonly writer: OrderWriter,
    private readonly channels: ChannelsService,
    private readonly connectors: ConnectorsService,
    private readonly events: DomainEvents,
    private readonly stock: OrderStock,
    private readonly audit: AuditService,
    private readonly shipments: ShipmentJobs,
    private readonly tasks: TasksService,
  ) {}

  /**
   * `new` to `confirmed` by a person (AC-7): sets `confirmed_at` and `confirmed_by`, writes one
   * event, and tops the order's short lines up (AC-13, a shortage never refuses a confirm).
   * Throws `OrderNotFound`, `OrderStale` when `expectedUpdatedAt` is given and differs, or
   * `InvalidTransition` from any other state.
   */
  async confirm(
    tx: OrderTransaction,
    orderId: string,
    actor: PersonActor,
    expectedUpdatedAt?: string,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId, expectedUpdatedAt);
    nextState({
      machine: 'fulfillment',
      from: order.fulfillmentState,
      to: 'confirmed',
      actor: 'person',
    });
    await this.writer.applyChange(tx, orderId, {
      columns: { fulfillmentState: 'confirmed', confirmedAt: 'now', confirmedBy: actor.userId },
      events: [fulfillmentEvent(order, 'confirmed', actor, null)],
    });
    // Once a stock out is requested no path reserves the order's lines again (AC-13, AC-27).
    if (order.stockOutSource === null) await this.stock.topUp(tx, orderId, false);
  }

  /**
   * Cancels an order until the courier picks it up (AC-7, AC-8, review X1): `new`, `confirmed`, or
   * `packed`, a carrier delivery or not. Lines and totals stay as they were; `cancelled_at` and
   * `cancel_reason_code` are set, `cod_due_amount` becomes 0, and cash `unpaid` moves to
   * `nothing_to_collect` (actor `system_job`) in the same transaction. A `duplicate` cancel links
   * the order it duplicates (`duplicate_of`), locking both orders in ascending id. A cancel from
   * `packed` raises `unpack_cancelled_order`; a person's or the channel's cancel of an order whose
   * carrier delivery exists raises `terminate_carrier_delivery`. Publishes `OrderCancelled`.
   *
   * Throws `OrderNotFound`, `OrderStale`, `DuplicateTargetRequired` (a `duplicate` with no, an
   * unknown, or its own target), `InvalidOrderInput` (a target with another reason, a cancelled
   * target, a target that is already a duplicate of this order, or an order already linked to
   * another), `CancelInShopify` for a person's cancel of a Shopify store order
   * while `writeBackAvailable(orderId, 'shopify.order_cancel')` is false, and `InvalidTransition`
   * from `shipped` on or for a reason code the actor may not use.
   */
  async cancel(
    tx: OrderTransaction,
    orderId: string,
    input: CancelInput,
    actor: OrderActor,
    expectedUpdatedAt?: string,
  ): Promise<void> {
    await this.cancelOrder(tx, orderId, input, actor, expectedUpdatedAt, null);
  }

  /**
   * The cancel itself, shared by `cancel` and the carrier's `cancelled` fact of
   * `recordShipmentFact`, which passes its fact so the event row carries the fact's time and
   * source and the first carrier fact sets `carrier_delivery_created_at` in the same change.
   */
  private async cancelOrder(
    tx: OrderTransaction,
    orderId: string,
    input: CancelInput,
    actor: OrderActor,
    expectedUpdatedAt: string | undefined,
    fact: { occurredAt: Date; source: FactSource } | null,
  ): Promise<void> {
    // Uuids compare as PostgreSQL orders them only in one case (review low 3).
    const self = orderId.toLowerCase();
    const target = input.duplicateOfOrderId?.toLowerCase() ?? null;
    if (input.reasonCode === 'duplicate' && (target === null || target === self)) {
      throw new DuplicateTargetRequired();
    }
    if (input.reasonCode !== 'duplicate' && target !== null) {
      throw new InvalidOrderInput('Only a duplicate names the order it duplicates');
    }
    // Two orders are locked only in ascending id (spec 0013 Key invariants).
    const targetFirst = target !== null && target < self ? await lockLinkTarget(tx, target) : null;
    const order = await lockOrderForChange(tx, orderId, expectedUpdatedAt);
    const duplicateOf =
      target === null ? null : (targetFirst ?? (await lockLinkTarget(tx, target)));
    if (target !== null) {
      if (duplicateOf === null) throw new DuplicateTargetRequired();
      // Security L1: never a duplicate of a cancelled order, nor a cycle of two duplicates.
      if (duplicateOf.fulfillmentState === 'cancelled') {
        throw new InvalidOrderInput('The order it duplicates is already cancelled');
      }
      if (
        duplicateOf.relatedOrderRelation === 'duplicate_of' &&
        duplicateOf.relatedOrderId?.toLowerCase() === self
      ) {
        throw new InvalidOrderInput('That order is already a duplicate of this one');
      }
      if (order.relatedOrderId !== null) {
        throw new InvalidOrderInput('This order already links to another order');
      }
    }
    nextState({
      machine: 'fulfillment',
      from: order.fulfillmentState,
      to: 'cancelled',
      actor: actorTypeOf(actor),
      reasonCode: input.reasonCode,
    });
    if (actor.type === 'person') {
      const [store] = await this.channels.stores([order.storeId], tx);
      if (
        store?.kind === 'shopify' &&
        !(await this.connectors.writeBackAvailable(orderId, 'shopify.order_cancel'))
      ) {
        throw new CancelInShopify();
      }
    }

    const due = codDue({
      lines: order.lines,
      shippingChargedAmount: order.shippingChargedAmount,
      shippingPrepaidAmount: order.shippingPrepaidAmount,
      shippingCreditAppliedAmount: order.shippingCreditAppliedAmount,
      fulfillmentState: 'cancelled',
    });
    const events: NewEventRow[] = [
      fulfillmentEvent(order, 'cancelled', actor, input.reasonCode, fact),
    ];
    // The guard nextState leaves to the service: nothing due and nothing collected.
    const nothingToCollect =
      order.cashState === 'unpaid' &&
      Money.of(due).isZero() &&
      Money.of(order.codCollectedAmount).isZero();
    if (nothingToCollect) {
      nextState({ machine: 'cash', from: 'unpaid', to: 'nothing_to_collect', actor: 'system_job' });
      events.push(nothingToCollectEvent(orderId, fact?.occurredAt ?? new Date()));
    }
    await this.writer.applyChange(tx, orderId, {
      columns: {
        fulfillmentState: 'cancelled',
        cancelledAt: 'now',
        cancelReasonCode: input.reasonCode,
        codDueAmount: due,
        ...(nothingToCollect ? { cashState: 'nothing_to_collect' as const } : {}),
        ...(fact !== null && !order.carrierDeliveryCreated
          ? { carrierDeliveryCreatedAt: fact.occurredAt }
          : {}),
        ...(target !== null
          ? {
              relatedOrderId: duplicateOf?.id ?? target,
              relatedOrderRelation: 'duplicate_of' as const,
            }
          : {}),
      },
      events,
    });
    await this.stock.afterCancel(tx, orderId);
    // Every cancel before a carrier `shipped` fact (a cancel is only ever before one) asks the
    // after cancel job about the current generation, unconditionally (AC-27 b).
    await this.shipments.enqueueAfterCancel(tx, orderId, order.stockOutGeneration, {
      origin: originOf(actor),
      reasonCode: input.reasonCode,
    });

    if (order.fulfillmentState === 'packed') {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'unpack_cancelled_order', 'order', orderId),
      );
    }
    if (order.carrierDeliveryCreated && actor.type !== 'carrier') {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'terminate_carrier_delivery', 'order', orderId),
      );
    }
    await this.events.publish(
      tx,
      new OrderCancelled(
        orderId,
        order.storeId,
        originOf(actor),
        input.reasonCode,
        target,
        order.carrierDeliveryCreated,
      ),
    );
  }

  /**
   * `confirmed` to `packed` by a person with `fulfillment.work` (AC-7). Refused with
   * `WriteBackOpen` while `ConnectorsService.openCommandsFor('order', id, tx)` answers any command,
   * whatever `write_back_state` says (carried B2), and with `LineShort` (409 `LINE_SHORT`) when an
   * open line is still short after the top up (AC-13, Q-16.5), which rolls the pack back. Throws
   * `OrderNotFound`, `OrderStale`, or `InvalidTransition` from any other state.
   */
  async markPacked(
    tx: OrderTransaction,
    orderId: string,
    actor: PersonActor,
    expectedUpdatedAt?: string,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId, expectedUpdatedAt);
    const open = await this.connectors.openCommandsFor('order', orderId, tx);
    nextState({
      machine: 'fulfillment',
      from: order.fulfillmentState,
      to: 'packed',
      actor: 'person',
    });
    if (open.length > 0) throw new WriteBackOpen();
    // Once a stock out is requested: no top up and no `LINE_SHORT` (AC-13, AC-27).
    if (order.stockOutSource === null) await this.stock.topUp(tx, orderId, true);
    await this.writer.applyChange(tx, orderId, {
      columns: { fulfillmentState: 'packed' },
      events: [fulfillmentEvent(order, 'packed', actor, null)],
    });
  }

  /**
   * `packed` back to `confirmed` by a person (AC-7). Refused with `OrderLocked` once the carrier
   * delivery exists (the transition table's own refusal), and with `InvalidTransition` from any
   * state other than `packed`. Throws `OrderNotFound` or `OrderStale`.
   */
  async unpack(
    tx: OrderTransaction,
    orderId: string,
    actor: PersonActor,
    expectedUpdatedAt?: string,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId, expectedUpdatedAt);
    // The table's `confirmed` row also holds `new` to `confirmed` (a confirm): an unpack is only
    // ever the move back from `packed`.
    if (order.fulfillmentState !== 'packed') {
      throw new InvalidTransition(
        'fulfillment',
        order.fulfillmentState,
        'confirmed',
        'person',
        'only a packed order is unpacked',
      );
    }
    if (order.carrierDeliveryCreated) throw new OrderLocked();
    nextState({
      machine: 'fulfillment',
      from: order.fulfillmentState,
      to: 'confirmed',
      actor: 'person',
      carrierDeliveryCreated: order.carrierDeliveryCreated,
    });
    await this.writer.applyChange(tx, orderId, {
      columns: { fulfillmentState: 'confirmed' },
      events: [fulfillmentEvent(order, 'confirmed', actor, null)],
    });
  }

  /**
   * Records that the carrier delivery exists (AC-15: feature 19's delivery, or feature 13's first
   * Shopify fulfillment): sets `carrier_delivery_created_at` once, the money freeze and the edit
   * lock (AC-8); a repeat changes nothing. Raises `delivery_created_before_edit_synced` when an
   * outbound command on the order is still open. Moves no state and writes no event. Built in
   * milestone 2 in its minimal form, because the freeze it sets is what the edit and cancel rules
   * read; milestone 3 adds its callers.
   */
  async recordCarrierDelivery(
    tx: OrderTransaction,
    orderId: string,
    fact: CarrierDeliveryFact,
    _actor: OrderActor,
  ): Promise<{ applied: boolean }> {
    const order = await lockOrderForChange(tx, orderId);
    if (order.carrierDeliveryCreated) return { applied: false };
    await this.writer.applyChange(tx, orderId, {
      columns: { carrierDeliveryCreatedAt: fact.at },
    });
    const open = await this.connectors.openCommandsFor('order', orderId, tx);
    if (open.length > 0) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(
          orderId,
          'delivery_created_before_edit_synced',
          fact.source.type,
          fact.source.id,
        ),
      );
    }
    return { applied: true };
  }

  /**
   * A Shopify fulfillment took the order's pieces (spec 0013 AC-15, AC-27 a, spec 0015 AC-28),
   * called by feature 13 inside its unit of work. Moves no state and writes no event. Under the
   * order row lock: a cancelled order answers `cancelled` and a recorded request (any source,
   * the carrier's included) answers `already_requested`, each changing nothing. When Shopify's
   * fulfilled quantities differ from the order's open lines it requests nothing, raises
   * `fulfilled_lines_differ` for the warehouse (source the fulfillment), and answers
   * `lines_differ`; else it records the request (`shopify_fulfillment`, each open line's quantity,
   * at the fulfillment's time) and enqueues the shipment posting job of the current generation.
   */
  async recordChannelStockOut(
    tx: OrderTransaction,
    orderId: string,
    stockOut: ChannelStockOut,
    _actor: OrderActor,
  ): Promise<ChannelStockOutResult> {
    const order = await lockOrderForChange(tx, orderId);
    if (order.fulfillmentState === 'cancelled') return { requested: false, why: 'cancelled' };
    if (order.stockOutSource !== null) return { requested: false, why: 'already_requested' };
    if (fulfilledLinesDiffer(order.lines, stockOut.fulfilledLines)) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(
          orderId,
          'fulfilled_lines_differ',
          stockOut.source.type,
          stockOut.source.id,
        ),
      );
      return { requested: false, why: 'lines_differ' };
    }
    const requested = await this.writer.requestStockOut(tx, orderId, {
      source: 'shopify_fulfillment',
      at: stockOut.at,
      lines: order.lines
        .filter((line) => line.lineState === 'open')
        .map((line) => ({ lineId: line.id, quantity: line.quantity })),
    });
    if (!requested) return { requested: false, why: 'already_requested' };
    await this.shipments.enqueuePost(tx, orderId, order.stockOutGeneration);
    return { requested: true };
  }

  /**
   * Every Shopify fulfillment of the order was cancelled before any carrier `shipped` fact (spec
   * 0013 AC-27 c), called by feature 13 inside its unit of work. Moves no state. Under the order
   * row lock: a carrier `shipped` fact answers `{ applied: false, why: 'after_pickup' }`. Else, when
   * the order has no carrier delivery from feature 19 (no `shipments` row; that table arrives with
   * feature 19, so today none has one) and the freeze is set, it clears `carrier_delivery_created_at`
   * with `order.carrier_delivery_cleared` (actor `system_job`, reason
   * `channel_fulfillment_cancelled`), so a size swap arrives as a normal edit. When a stock out is
   * requested for generation `n`, it enqueues the fulfillment reversal job for `n`, closes any
   * awaiting restock quantities (the reversal brings those pieces back, so none comes back twice),
   * moves the order to generation `n + 1` with the request and the lines' `stock_out_quantity`
   * cleared, and reserves the open lines again while the order is `new`, `confirmed`, or `packed`
   * (they read short until the reversal posts and fills waiting demand).
   */
  async recordChannelFulfillmentCancelled(
    tx: OrderTransaction,
    orderId: string,
    cancelled: ChannelFulfillmentCancelled,
    actor: OrderActor,
  ): Promise<{ applied: true } | { applied: false; why: 'after_pickup' }> {
    const order = await lockOrderForChange(tx, orderId);
    if (carrierShippedFactExists(order)) return { applied: false, why: 'after_pickup' };
    if (order.carrierDeliveryCreated && (await this.writer.clearCarrierDelivery(tx, orderId))) {
      const [store] = await this.channels.stores([order.storeId], tx);
      if (!store) throw new OrderStoreMissing();
      const auditActor =
        actor.type === 'system_job'
          ? auditActorOf(actor)
          : systemJobActor('orders.channel_fulfillment_cancelled', randomUUID());
      await this.audit.record(tx, {
        actor: auditActor,
        action: 'order.carrier_delivery_cleared',
        record: {
          type: 'order',
          id: orderId,
          label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
        },
        before: { carrierDeliveryCreated: true, source: cancelled.source.type },
        after: { carrierDeliveryCreated: false },
        reason: 'channel_fulfillment_cancelled',
        correlationId: this.audit.newCorrelationId(auditActor),
      });
    }
    if (order.stockOutSource !== null) {
      const generation = order.stockOutGeneration;
      await this.shipments.enqueueFulfillmentReversal(tx, orderId, generation);
      await this.writer.closeAwaitingRestock(tx, orderId);
      await this.writer.advanceStockOutGeneration(tx, orderId, generation);
      if (order.fulfillmentState !== 'cancelled') await this.stock.topUp(tx, orderId, false);
    }
    return { applied: true };
  }

  /**
   * Applies one carrier fact (AC-15, spec 0002 fulfillment table): `shipped`, `failed_attempt`,
   * `delivered`, `refused` (with a `RefusedReasonCode`, stored as `refused_reason_code`),
   * `returned_to_origin`, `lost`, and `cancelled` (a delivery the carrier cancelled or terminated
   * before any pickup, a `carrier.` reason code, applied as a cancel: reservations released, cash
   * `nothing_to_collect`, `OrderCancelled` with origin `carrier`, Q-16.4). In one change it writes
   * the state with its event row (the fact's time and source), moves every open line to
   * `delivered`, `returned_to_origin`, or `lost` as the fact says, recomputes `cod_due_amount` and
   * `delivered_amount`, sets `carrier_delivery_created_at` from the fact when it was unset, and
   * moves cash `unpaid` to `nothing_to_collect` (actor `system_job`) when nothing is left due and
   * nothing was collected. It then raises each task the table returns as an attention and
   * publishes `LinesReturnedToOrigin` for lines that came back or were lost.
   *
   * For the `carrier` actor a pair the table does not list applies nothing, raises
   * `carrier_fact_contradicts_state` (source type the fact's state, source id the fact's source),
   * and answers `{ applied: false }`, so the caller's unit commits (review M3). Any other actor
   * gets the table's `InvalidTransition` (a person may record `lost` with a reason). A malformed
   * fact throws `InvalidOrderInput` for every actor; a `cancelled` fact from anyone but the
   * carrier throws `InvalidTransition` (a person cancels with `cancel`). Never refused for stock:
   * on `shipped` it records the stock out request and enqueues the `orders.post_shipment` job in
   * the same transaction (task 15, AC-24), which books the posting after the move commits; the
   * carrier's `cancelled` enqueues the after cancel job like every cancel (AC-27 b).
   */
  async recordShipmentFact(
    tx: OrderTransaction,
    orderId: string,
    fact: ShipmentFact,
    actor: OrderActor,
  ): Promise<{ applied: boolean }> {
    assertWellFormedFact(fact);
    const order = await lockOrderForChange(tx, orderId);
    const actorType = actorTypeOf(actor);
    const reasonCode = fact.reasonCode ?? null;
    if (fact.to === 'cancelled' && actor.type !== 'carrier') {
      throw new InvalidTransition(
        'fulfillment',
        order.fulfillmentState,
        'cancelled',
        actorType,
        'only the carrier reports a delivery cancelled before pickup; a person cancels the order',
      );
    }
    const writeBackOpen =
      fact.to === 'shipped' &&
      (order.writeBackState !== 'none' ||
        (await this.connectors.openCommandsFor('order', orderId, tx)).length > 0);
    let tasks: OrderTaskKind[];
    try {
      ({ tasks } = nextState({
        machine: 'fulfillment',
        from: order.fulfillmentState,
        to: fact.to,
        actor: actorType,
        reasonCode,
        writeBackOpen,
        carrierDeliveryCreated: order.carrierDeliveryCreated,
      }));
    } catch (error) {
      if (!(error instanceof InvalidTransition) || actor.type !== 'carrier') throw error;
      await this.events.publish(
        tx,
        new OrderAttentionRaised(
          orderId,
          'carrier_fact_contradicts_state',
          fact.to,
          fact.source.id,
        ),
      );
      return { applied: false };
    }

    if (fact.to === 'cancelled') {
      // The row checked above; the cancel takes the same lock again in this transaction.
      await this.cancelOrder(tx, orderId, { reasonCode: reasonCode ?? '' }, actor, undefined, {
        occurredAt: fact.occurredAt,
        source: fact.source,
      });
      return { applied: true };
    }

    const lineState = lineMoveOf(fact.to);
    const moves = lineState === null ? [] : planLineMoves(order.lines, lineState);
    const money = moneyAfter(order, linesAfterMoves(order.lines, moves), fact.to);
    const events: NewEventRow[] = [fulfillmentEvent(order, fact.to, actor, reasonCode, fact)];
    const nothingToCollect = leavesNothingToCollect({
      cashState: order.cashState,
      fulfillmentState: fact.to,
      codDueAmount: money.codDueAmount,
      codCollectedAmount: order.codCollectedAmount,
    });
    if (nothingToCollect) {
      nextState({ machine: 'cash', from: 'unpaid', to: 'nothing_to_collect', actor: 'system_job' });
      events.push(nothingToCollectEvent(orderId, fact.occurredAt));
    }
    const columns: OrderColumnChanges = {
      fulfillmentState: fact.to,
      codDueAmount: money.codDueAmount,
      deliveredAmount: money.deliveredAmount,
      ...(fact.to === 'refused' && reasonCode !== null ? { refusedReasonCode: reasonCode } : {}),
      ...(nothingToCollect ? { cashState: 'nothing_to_collect' as const } : {}),
      ...(order.carrierDeliveryCreated ? {} : { carrierDeliveryCreatedAt: fact.occurredAt }),
    };
    await this.writer.applyChange(tx, orderId, { columns, moveLines: moves, events });
    if (fact.to === 'shipped') await this.afterShipped(tx, order, fact);

    for (const task of tasks) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, task, fact.source.type, fact.source.id),
      );
    }
    if ((lineState === 'returned_to_origin' || lineState === 'lost') && moves.length > 0) {
      await this.events.publish(
        tx,
        new LinesReturnedToOrigin(
          orderId,
          moves.map((move) => move.lineId),
          lineState,
        ),
      );
    }
    return { applied: true };
  }

  /**
   * Records a partial delivery (AC-16, spec 0002 "Partial delivery splits lines"): from `shipped`
   * or `failed_attempt`, by the carrier or a person. Each named open line is delivered whole,
   * returned whole (`deliveredQuantity` 0), or split with `splitLine` into a delivered row (the
   * original) and a new `returned_to_origin` row; every other open line is delivered whole. It
   * needs at least one delivered and one returned unit (else `InvalidTransition`, the row's
   * guard), moves fulfillment to `partially_delivered`, lowers `cod_due_amount` by the returned
   * rows only (shipping stays charged in full), leaves `lines_gross_amount`, `total_amount`, and
   * the frozen money unchanged (the split keeps each line's share sum), writes
   * `order.partial_delivery_split` (reason `carrier_report` by default for the carrier), and
   * publishes `LinesReturnedToOrigin` for the returned rows.
   *
   * Throws `OrderNotFound`, `InvalidTransition` from any other state or actor, and
   * `InvalidOrderInput` for a line named twice, a line that is not open, a quantity outside 0 to
   * the line's quantity, or a reason outside the list.
   */
  async recordPartialDelivery(
    tx: OrderTransaction,
    orderId: string,
    input: PartialDelivery,
    actor: OrderActor,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId);
    const actorType = actorTypeOf(actor);
    nextState({
      machine: 'fulfillment',
      from: order.fulfillmentState,
      to: 'partially_delivered',
      actor: actorType,
    });
    const reason = input.reasonCode ?? (actor.type === 'carrier' ? 'carrier_report' : null);
    if (
      reason !== null &&
      !(ORDER_PARTIAL_DELIVERY_REASONS as readonly string[]).includes(reason)
    ) {
      throw new InvalidOrderInput('A partial delivery reason is not one of the listed reasons');
    }
    const plan = planPartialDelivery(order.lines, input.lines);
    if (plan.deliveredUnits === 0 || plan.returnedUnits === 0) {
      throw new InvalidTransition(
        'fulfillment',
        order.fulfillmentState,
        'partially_delivered',
        actorType,
        'a partial delivery needs at least one delivered and one returned piece',
      );
    }
    const money = moneyAfter(order, plan.after, 'partially_delivered');
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();

    const applied = await this.writer.applyChange(tx, orderId, {
      columns: {
        fulfillmentState: 'partially_delivered',
        codDueAmount: money.codDueAmount,
        deliveredAmount: money.deliveredAmount,
        ...(order.carrierDeliveryCreated ? {} : { carrierDeliveryCreatedAt: input.occurredAt }),
      },
      moveLines: plan.moves,
      splitLines: plan.splits,
      events: [fulfillmentEvent(order, 'partially_delivered', actor, null, input)],
      freezeAllowance: 'partial_delivery_split',
    });

    const lineOf = new Map(order.lines.map((line) => [line.id, line]));
    const touched = [...plan.moves.map((move) => move.lineId), ...plan.splits.map((s) => s.lineId)];
    const returnedWhole = plan.moves.filter((move) => move.to === 'returned_to_origin');
    const before: JsonObject = {
      codDueAmount: Money.of(order.codDueAmount).toString(),
      lines: touched.map((lineId) => {
        const line = lineOf.get(lineId);
        return {
          lineId,
          quantity: line?.quantity ?? 0,
          grossAmount: line?.grossAmount ?? '0.00',
          lineState: 'open',
        };
      }),
    };
    const after: JsonObject = {
      codDueAmount: money.codDueAmount,
      deliveredAmount: money.deliveredAmount,
      lines: [
        ...plan.moves.map((move): JsonObject => {
          const line = lineOf.get(move.lineId);
          return {
            lineId: move.lineId,
            quantity: line?.quantity ?? 0,
            grossAmount: line?.grossAmount ?? '0.00',
            lineState: move.to,
          };
        }),
        ...plan.splits.flatMap((split, index): JsonObject[] => [
          {
            lineId: split.lineId,
            quantity: split.delivered.quantity,
            grossAmount: split.delivered.grossAmount,
            lineState: 'delivered',
          },
          {
            lineId: applied.splitLineIds[index] ?? null,
            splitFromLineId: split.lineId,
            quantity: split.returned.quantity,
            grossAmount: split.returned.grossAmount,
            lineState: 'returned_to_origin',
          },
        ]),
      ],
    };
    const auditActor = auditActorOf(actor);
    await this.audit.record(tx, {
      actor: auditActor,
      action: 'order.partial_delivery_split',
      record: {
        type: 'order',
        id: orderId,
        label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
      },
      before,
      after,
      ...(reason !== null ? { reason } : {}),
      correlationId: this.audit.newCorrelationId(auditActor),
    });
    await this.events.publish(
      tx,
      new LinesReturnedToOrigin(
        orderId,
        [...returnedWhole.map((move) => move.lineId), ...applied.splitLineIds],
        'returned_to_origin',
      ),
    );
  }

  /**
   * Records cash the courier collected (AC-17, spec 0002 cash table): `unpaid` to
   * `collected_by_carrier`, a further collection or a corrected total on `collected_by_carrier`
   * (one event per change, `amount` the new total), or a late report on `nothing_to_collect` by
   * the carrier (the `late_cash_on_nothing_to_collect` attention). Sets `cod_collected_amount`
   * to `amount`. A person needs a reason from the collection list and writes
   * `order.collection_recorded_manually` (AC-11). A report of the total already recorded on
   * `collected_by_carrier` is no change: it writes nothing and answers `{ applied: false }`.
   *
   * Throws `OrderNotFound`, `InvalidOrderInput` for an amount that is not above 0 or a person's
   * reason outside the list, `InvalidAmountError` for a malformed amount, and `InvalidTransition`
   * from any other cash state or without a person's reason.
   */
  async recordCollection(
    tx: OrderTransaction,
    orderId: string,
    fact: CollectionFact,
    actor: OrderActor,
  ): Promise<{ applied: boolean }> {
    const amount = Money.of(fact.amount);
    if (amount.sign() <= 0) throw new InvalidOrderInput('A collection must be above 0');
    const order = await lockOrderForChange(tx, orderId);
    const reasonCode = fact.reasonCode ?? null;
    const { tasks } = nextState({
      machine: 'cash',
      from: order.cashState,
      to: 'collected_by_carrier',
      actor: actorTypeOf(actor),
      reasonCode,
    });
    assertCollectionReason(actor, reasonCode);
    const total = amount.toString();
    if (
      order.cashState === 'collected_by_carrier' &&
      Money.of(order.codCollectedAmount).cents === amount.cents
    ) {
      return { applied: false };
    }
    await this.writer.applyChange(tx, orderId, {
      columns: { cashState: 'collected_by_carrier', codCollectedAmount: total },
      events: [
        cashEvent(
          order,
          'collected_by_carrier',
          total,
          actor,
          reasonCode,
          fact.occurredAt,
          fact.source,
        ),
      ],
    });
    for (const task of tasks) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, task, fact.source.type, fact.source.id),
      );
    }
    await this.auditCashEntry(tx, order, actor, reasonCode, 'collected_by_carrier', total);
    return { applied: true };
  }

  /**
   * Reverses a collection (AC-17): `collected_by_carrier` back to `unpaid`, by the carrier or a
   * person with a reason from the collection list (who writes `order.collection_recorded_manually`).
   * `cod_collected_amount` returns to 0, the event's amount is 0.00. Throws `OrderNotFound`,
   * `InvalidOrderInput` for a person's reason outside the list, and `InvalidTransition` from any
   * other cash state or without a person's reason.
   */
  async reverseCollection(
    tx: OrderTransaction,
    orderId: string,
    fact: CollectionReversal,
    actor: OrderActor,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId);
    const reasonCode = fact.reasonCode ?? null;
    nextState({
      machine: 'cash',
      from: order.cashState,
      to: 'unpaid',
      actor: actorTypeOf(actor),
      reasonCode,
    });
    assertCollectionReason(actor, reasonCode);
    const zero = Money.zero.toString();
    await this.writer.applyChange(tx, orderId, {
      columns: { cashState: 'unpaid', codCollectedAmount: zero },
      events: [cashEvent(order, 'unpaid', zero, actor, reasonCode, fact.occurredAt, fact.source)],
    });
    await this.auditCashEntry(tx, order, actor, reasonCode, 'unpaid', zero);
  }

  /**
   * Moves the cash through settlement (AC-17, feature 22's matching unit of work):
   * `collected_by_carrier` to `remitted` (needs `depositedOn` and `remittedAmount`, which sets
   * `remitted_amount`), `remitted` to `reconciled` (needs `fullySettled: true`), `prepaid` to
   * `reconciled`, and the two revokes with a reason: `reconciled` back to `remitted` (keeps
   * `remitted_amount`) and `remitted` back to `collected_by_carrier` (the deposit match revoked,
   * `remitted_amount` back to 0). The event row's source is the settlement match. Throws
   * `OrderNotFound`, `InvalidTransition` for a move the table refuses for the actor, a revoke
   * without a reason, a remittance without its deposit date, or a reconcile not fully settled,
   * and `InvalidOrderInput` for a remittance without a valid amount.
   */
  async recordSettlement(
    tx: OrderTransaction,
    orderId: string,
    change: SettlementChange,
    actor: OrderActor,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId);
    const actorType = actorTypeOf(actor);
    const reasonCode = change.reasonCode ?? null;
    nextState({
      machine: 'cash',
      from: order.cashState,
      to: change.to,
      actor: actorType,
      reasonCode,
    });
    const refuse = (why: string): never => {
      throw new InvalidTransition('cash', order.cashState, change.to, actorType, why);
    };
    const columns: OrderColumnChanges = { cashState: change.to };
    let amount: string | null = null;
    if (order.cashState === 'collected_by_carrier' && change.to === 'remitted') {
      if (!change.depositedOn || !DEPOSIT_DATE.test(change.depositedOn)) {
        refuse('a remittance needs the deposit date of its statement');
      }
      if (change.remittedAmount === undefined) {
        throw new InvalidOrderInput('A remittance needs the remitted amount');
      }
      const remitted = Money.of(change.remittedAmount);
      if (remitted.sign() < 0) throw new InvalidOrderInput('A remitted amount is never below 0');
      amount = remitted.toString();
      columns.remittedAmount = amount;
    }
    if (
      order.cashState === 'remitted' &&
      change.to === 'reconciled' &&
      change.fullySettled !== true
    ) {
      refuse('a reconcile needs every settlement line of the order matched or accounted');
    }
    if (order.cashState === 'remitted' && change.to === 'collected_by_carrier') {
      columns.remittedAmount = Money.zero.toString();
    }
    await this.writer.applyChange(tx, orderId, {
      columns,
      events: [
        cashEvent(order, change.to, amount, actor, reasonCode, new Date(), {
          type: SETTLEMENT_SOURCE,
          id: change.sourceId,
        }),
      ],
    });
  }

  /**
   * `delivered` or `partially_delivered` to `exchanged` (AC-17, feature 34): an exchange on this
   * order completed. Only a `system_job` may move it (the transition table). The event row names
   * the exchange (`source_type` `exchange`); `orders.exchange_id` is feature 34's and is not
   * written here. Throws `OrderNotFound` or `InvalidTransition` (a repeat included).
   */
  async markExchanged(
    tx: OrderTransaction,
    orderId: string,
    input: { exchangeId: string },
    actor: OrderActor,
  ): Promise<void> {
    const order = await lockOrderForChange(tx, orderId);
    nextState({
      machine: 'fulfillment',
      from: order.fulfillmentState,
      to: 'exchanged',
      actor: actorTypeOf(actor),
    });
    await this.writer.applyChange(tx, orderId, {
      columns: { fulfillmentState: 'exchanged' },
      events: [
        fulfillmentEvent(order, 'exchanged', actor, null, {
          occurredAt: new Date(),
          source: { type: EXCHANGE_SOURCE, id: input.exchangeId },
        }),
      ],
    });
  }

  /**
   * The stock side of a carrier `shipped` fact (AC-15, AC-24), in the fact's transaction: when no
   * stock out is requested yet, records the request (`carrier_shipped`, each open line's full
   * quantity, at the fact's time) and enqueues the shipment posting job for the current
   * generation; when one is recorded (a Shopify fulfillment came first) it enqueues nothing new.
   * A late `shipped` on a cancelled order (`cancelled` to `shipped`) also closes the order's
   * awaiting restock quantities with no movement: the posting stands and the courier has the
   * pieces. A request it records closes the `fulfilled_lines_differ` attention's task. Never
   * refused for stock: the posting runs in the job after the move commits.
   */
  private async afterShipped(
    tx: OrderTransaction,
    order: LockedOrder,
    fact: ShipmentFact,
  ): Promise<void> {
    if (order.fulfillmentState === 'cancelled') {
      await this.writer.closeAwaitingRestock(tx, order.id);
    }
    if (order.stockOutSource !== null) return;
    const requested = await this.writer.requestStockOut(tx, order.id, {
      source: 'carrier_shipped',
      at: fact.occurredAt,
      lines: order.lines
        .filter((line) => line.lineState === 'open')
        .map((line) => ({ lineId: line.id, quantity: line.quantity })),
    });
    if (!requested) return;
    await this.shipments.enqueuePost(tx, order.id, order.stockOutGeneration);
    // The courier's pickup is the truth: a `fulfilled_lines_differ` attention is closed in the
    // same transaction (AC-15, decided 2026-11-08; spec 0016's `cleared` outcome).
    await this.closeAttention(tx, 'fulfilled_lines_differ', order.id);
  }

  /** Closes the open task of an order attention as `cleared` (spec 0016 AC-9); none open is fine. */
  private async closeAttention(tx: OrderTransaction, kind: string, orderId: string): Promise<void> {
    await this.tasks.closeByKey(tx, attentionTaskKey(kind, orderId), {
      outcome: 'cleared',
      by: { kind: 'system_job' },
    });
  }

  /** Writes `order.collection_recorded_manually` for a person's cash entry (AC-11); others write none. */
  private async auditCashEntry(
    tx: OrderTransaction,
    order: LockedOrder,
    actor: OrderActor,
    reasonCode: string | null,
    cashAfter: CashState,
    collectedAfter: string,
  ): Promise<void> {
    if (actor.type !== 'person') return;
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();
    const auditActor = auditActorOf(actor);
    await this.audit.record(tx, {
      actor: auditActor,
      action: 'order.collection_recorded_manually',
      record: {
        type: 'order',
        id: order.id,
        label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
      },
      before: {
        cashState: order.cashState,
        codCollectedAmount: Money.of(order.codCollectedAmount).toString(),
      },
      after: {
        cashState: cashAfter,
        codCollectedAmount: collectedAfter,
      },
      ...(reasonCode !== null ? { reason: reasonCode } : {}),
      correlationId: this.audit.newCorrelationId(auditActor),
    });
  }
}

/** One fulfillment event row of a move from the order's current state. */
function fulfillmentEvent(
  order: LockedOrder,
  to: NewEventRow['toState'],
  actor: OrderActor,
  reasonCode: string | null,
  fact: { occurredAt: Date; source: FactSource } | null = null,
): NewEventRow {
  return {
    machine: 'fulfillment',
    fromState: order.fulfillmentState,
    toState: to,
    amount: null,
    actor,
    reasonCode,
    sourceType: fact?.source.type ?? null,
    sourceId: fact?.source.id ?? null,
    occurredAt: fact?.occurredAt ?? new Date(),
  };
}

/** The automatic `unpaid` to `nothing_to_collect` event, sourced from the event just before it. */
function nothingToCollectEvent(orderId: string, occurredAt: Date): NewEventRow {
  return {
    machine: 'cash',
    fromState: 'unpaid',
    toState: 'nothing_to_collect',
    amount: null,
    actor: { type: 'system_job', job: NOTHING_TO_COLLECT_JOB, jobId: orderId },
    reasonCode: null,
    sourceType: null,
    sourceId: null,
    occurredAt,
    sourceIsPreviousEvent: true,
  };
}

/** One cash event row of a move from the order's current cash state. */
function cashEvent(
  order: LockedOrder,
  to: CashState,
  amount: string | null,
  actor: OrderActor,
  reasonCode: string | null,
  occurredAt: Date,
  source: FactSource,
): NewEventRow {
  return {
    machine: 'cash',
    fromState: order.cashState,
    toState: to,
    amount,
    actor,
    reasonCode,
    sourceType: source.type,
    sourceId: source.id,
    occurredAt,
  };
}

/** The reason of a person's cash entry: required (by the table) and from the collection list. */
function assertCollectionReason(actor: OrderActor, reasonCode: string | null | undefined): void {
  if (actor.type !== 'person') return;
  if (!(ORDER_COLLECTION_REASONS as readonly string[]).includes(reasonCode ?? '')) {
    throw new InvalidOrderInput('A cash entry by hand needs a reason from the collection list');
  }
}

/** The `OrderCancelled` origin of an actor: an import never cancels, so it counts as the channel. */
function originOf(actor: OrderActor): 'person' | 'channel' | 'carrier' {
  switch (actor.type) {
    case 'person':
      return 'person';
    case 'carrier':
      return 'carrier';
    case 'system_job':
    case 'import':
      return 'channel';
  }
}
