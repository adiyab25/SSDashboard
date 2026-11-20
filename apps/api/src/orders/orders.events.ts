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

/**
 * An edit was applied (spec 0013 AC-10): by a person (`origin: 'person'`, which feature 13 turns
 * into an outbound command in the same transaction) or from the channel. Field names only, never
 * their values.
 */
export class OrderEdited {
  /** Takes the order, who edited it, and what changed. */
  constructor(
    readonly orderId: string,
    readonly storeId: string,
    readonly origin: 'person' | 'channel',
    readonly addedLineIds: readonly string[],
    readonly cancelledLineIds: readonly string[],
    /** The names of the ship to fields that changed (`address`, `phone`), never their values. */
    readonly changedShipToFields: readonly string[],
    readonly shippingChanged: boolean,
    /**
     * The correlation id of the edit's `order.edited` audit entry (spec 0010), which finds the
     * entry; `AuditService.record` does not hand back the entry id itself.
     */
    readonly auditCorrelationId: string,
  ) {}
}

/** An order was cancelled (spec 0013 AC-7): ids and codes only. */
export class OrderCancelled {
  /** Takes the order, who cancelled it, why, and whether a carrier delivery already existed. */
  constructor(
    readonly orderId: string,
    readonly storeId: string,
    readonly origin: 'person' | 'channel' | 'carrier',
    readonly reasonCode: string,
    readonly duplicateOfOrderId: string | null,
    readonly carrierDeliveryExisted: boolean,
  ) {}
}

/**
 * Lines came back to the brand or were lost on the way (spec 0013 AC-15, AC-16): a carrier
 * `returned_to_origin` or `lost` fact, or the returned rows of a partial delivery. Feature 21
 * restocks by scan from it and feature 28 releases the credit of those lines. Ids only.
 */
export class LinesReturnedToOrigin {
  /** Takes the order, the lines that moved, and the state they moved to. */
  constructor(
    readonly orderId: string,
    readonly lineIds: readonly string[],
    readonly to: 'returned_to_origin' | 'lost',
  ) {}
}
