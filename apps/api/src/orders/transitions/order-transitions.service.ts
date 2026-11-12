import { Injectable } from '@nestjs/common';
import { InvalidTransition, Money, codDue, nextState } from '@ssdashboard/contracts';
import { ChannelsService } from '../../channels/channels.service.js';
import { ConnectorsService } from '../../connectors/connectors.service.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { actorTypeOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import {
  CancelInShopify,
  DuplicateTargetRequired,
  InvalidOrderInput,
  OrderLocked,
  WriteBackOpen,
} from '../orders.errors.js';
import { OrderAttentionRaised, OrderCancelled } from '../orders.events.js';
import { OrderStock } from '../stock/order-stock.js';
import { lockLinkTarget, lockOrderForChange, type LockedOrder } from '../writer/locked-order.js';
import { OrderWriter, type NewEventRow } from '../writer/order-writer.js';

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

/** The system job named on the automatic `unpaid` to `nothing_to_collect` move after a cancel. */
const NOTHING_TO_COLLECT_JOB = 'orders.nothing_to_collect';

/**
 * The named moves of the order state machines that milestone 2 builds (spec 0013 AC-7, AC-8,
 * AC-15): `confirm`, `cancel`, `markPacked`, `unpack`, and `recordCarrierDelivery`. Each takes the
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
    await this.stock.topUp(tx, orderId, false);
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
    const events: NewEventRow[] = [fulfillmentEvent(order, 'cancelled', actor, input.reasonCode)];
    // The guard nextState leaves to the service: nothing due and nothing collected.
    const nothingToCollect =
      order.cashState === 'unpaid' &&
      Money.of(due).isZero() &&
      Money.of(order.codCollectedAmount).isZero();
    if (nothingToCollect) {
      nextState({ machine: 'cash', from: 'unpaid', to: 'nothing_to_collect', actor: 'system_job' });
      events.push({
        machine: 'cash',
        fromState: 'unpaid',
        toState: 'nothing_to_collect',
        amount: null,
        actor: { type: 'system_job', job: NOTHING_TO_COLLECT_JOB, jobId: orderId },
        reasonCode: null,
        sourceType: null,
        sourceId: null,
        occurredAt: new Date(),
        sourceIsPreviousEvent: true,
      });
    }
    await this.writer.applyChange(tx, orderId, {
      columns: {
        fulfillmentState: 'cancelled',
        cancelledAt: 'now',
        cancelReasonCode: input.reasonCode,
        codDueAmount: due,
        ...(nothingToCollect ? { cashState: 'nothing_to_collect' as const } : {}),
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
    await this.stock.topUp(tx, orderId, true);
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
}

/** One fulfillment event row of a move from the order's current state. */
function fulfillmentEvent(
  order: LockedOrder,
  to: NewEventRow['toState'],
  actor: OrderActor,
  reasonCode: string | null,
): NewEventRow {
  return {
    machine: 'fulfillment',
    fromState: order.fulfillmentState,
    toState: to,
    amount: null,
    actor,
    reasonCode,
    sourceType: null,
    sourceId: null,
    occurredAt: new Date(),
  };
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
