import type { InboundSubject, OutboundLinkedType } from '@ssdashboard/contracts';

/**
 * The public events of the outbound commands (spec 0015 AC-24, its exported service table): one
 * per change of a command's sync state, published with `DomainEvents.publish(tx, event)` in the
 * transaction of that change. Payloads carry ids and codes only, never the command's payload,
 * which may hold an address (Law 151). The orders write back projection (spec 0013 AC-12) and,
 * later, the tasks module listen to them.
 */
abstract class OutboundCommandEvent {
  /** Takes the command, its connection and kind, the record it is about, and a failure code. */
  constructor(
    readonly commandId: string,
    readonly connectionId: string,
    /** The command kind, for example `shopify.order_edit`. */
    readonly kind: string,
    readonly linkedType: OutboundLinkedType,
    readonly linkedId: string,
    /** A provider error code only (`STEP_OFF`), set on a failure; never provider text. */
    readonly failureCode: string | null = null,
    /**
     * The person who queued the command (a staff user id), when the publisher knows one; the
     * tasks module assigns a failed write back to that person when she still holds
     * `orders.confirm` (spec 0016 AC-8, review B1). Null for a system queued command. An id
     * only, never a name.
     */
    readonly queuedByUserId: string | null = null,
  ) {}
}

/** A command was written and waits to be sent. */
export class OutboundCommandQueued extends OutboundCommandEvent {}

/** A command landed at the provider. */
export class OutboundCommandSynced extends OutboundCommandEvent {}

/** A command was rejected or ran out of retries; `failureCode` says why. */
export class OutboundCommandFailed extends OutboundCommandEvent {}

/** A person closed a failed command (retried, fixed in the provider, or the edit undone). */
export class OutboundCommandResolved extends OutboundCommandEvent {}

/**
 * An inbox event ended `failed` (spec 0015 AC-8, its exported service table): the mapper or the
 * orders module could not apply what Shopify holds, so nothing of it was written. Published with
 * `DomainEvents.publish(tx, event)` in the transaction that marks the event failed; feature 17
 * turns it into one task per order for operations. Ids, the Shopify order name, and a code only,
 * never a read value or provider text (Law 151).
 */
export class InboundEventFailed {
  /** Takes the connection, the inbox event, its subject, and the failure code. */
  constructor(
    readonly connectionId: string,
    readonly eventId: string,
    /** The inbox subject type, `order` in milestone 1. */
    readonly subjectType: InboundSubject,
    /** The Shopify gid of the subject, or null when the delivery named none. */
    readonly subjectExternalId: string | null,
    /** The Shopify order name (`#1001`) when the read back gave one, else null. */
    readonly subjectLabel: string | null,
    /** An upper case code (`ORDER_NUMBER_TAKEN`, `ORDER_UNREADABLE`), never provider text. */
    readonly failureCode: string,
  ) {}
}

/**
 * A Shopify removal and addition of the same variant, on the same operating day, for the same
 * absolute amount were netted (spec 0015 AC-11, Inbound processing item 5, its exported service
 * table): the metric dictionary (feature 24) counts neither half. Published once per pair with
 * `DomainEvents.publish(tx, event)` in the inbox job's unit of work. It never changes the order:
 * the lines stay as Shopify's line items say. Ids and the day only (Law 151).
 */
export class ChannelEditNetted {
  /** Takes the app order, the Shopify line item ids of the pair, and the operating day. */
  constructor(
    readonly orderId: string,
    /** The removal's then the addition's Shopify line item id, each once. */
    readonly channelLineIds: readonly string[],
    /** The operating day of both sales, `YYYY-MM-DD` (`ssd_operating_day`). */
    readonly operatingDay: string,
  ) {}
}

/**
 * A Shopify refund was seen on an order (spec 0015 AC-11, AC-12, its exported service table): the
 * `RETURN` sales of one refund agreement, published once per refund id with
 * `DomainEvents.publish(tx, event)` in the inbox job's unit of work. Refunds (35) and returns
 * write back (37) listen. It never changes the order or the stock. Ids, an amount, and a time
 * only, never a line text or a person (Law 151).
 */
export class ChannelRefundRecorded {
  /** Takes the app order, the Shopify refund gid, the amount, and when it happened. */
  constructor(
    readonly orderId: string,
    /** The Shopify refund gid (`gid://shopify/Refund/...`). */
    readonly externalRefundId: string,
    /** The sum of the refund's `RETURN` sales as a positive amount with two decimals. */
    readonly amount: string,
    /** When Shopify recorded the refund (`happenedAt`), an ISO instant. */
    readonly occurredAt: string,
  ) {}
}
