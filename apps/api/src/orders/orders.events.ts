import type {
  OrderAttentionKind,
  OrderMachine,
  OrderRelation,
  OrderType,
  RelatedOrderRelation,
} from '@ssdashboard/contracts';

/**
 * The public domain events of the orders module (spec 0013, Domain events), published with
 * `DomainEvents.publish(tx, event)` inside the write that causes them. Payloads carry ids, codes,
 * and amounts only: never a phone, name, address, or note (Law 151). Other modules import these
 * classes to register handlers.
 */

/** An order was created. */
export class OrderPlaced {
  /** Takes the ids and codes of the new order. */
  constructor(
    readonly orderId: string,
    readonly storeId: string,
    readonly channelId: string,
    readonly type: OrderType,
    /** ISO 8601 instant. */
    readonly placedAt: string,
    readonly customerId: string | null,
    readonly relatedOrderId: string | null,
    /** The relation asked for (`replacement_for` included), or null. */
    readonly relation: OrderRelation | RelatedOrderRelation | null,
  ) {}
}

/** One row was written to `order_events`: a move of either state machine. */
export class OrderStateChanged {
  /** Takes the event row's id and the move. */
  constructor(
    readonly orderId: string,
    readonly eventId: string,
    readonly machine: OrderMachine,
    readonly from: string | null,
    readonly to: string,
    readonly actorType: string,
    /** ISO 8601 instant. */
    readonly occurredAt: string,
  ) {}
}

/** The orders module asks someone to look at an order (feature 17 opens one task per kind and order). */
export class OrderAttentionRaised {
  /** Takes the order, the kind, and where it came from. */
  constructor(
    readonly orderId: string,
    readonly kind: OrderAttentionKind,
    readonly sourceType: string,
    readonly sourceId: string | null,
  ) {}
}
