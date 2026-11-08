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
