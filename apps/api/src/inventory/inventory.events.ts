/**
 * The events the inventory module publishes inside its own transaction with
 * `DomainEvents.publish(tx, event)` (spec 0011, Domain events). A handler (spec 0013 for orders,
 * feature 17 for tasks) runs on the publisher's transaction and commits or rolls back with the
 * stock change. Payloads hold ids, codes, and quantities only, never a name, a phone, a cost, or
 * a written reason. These classes never carry behaviour and never reach another module's tables.
 */

/** Why held stock moved back to waiting demand: a carrier took a piece, or a manager wrote one off. */
export type ReservationShortenedCause = 'carrier_shipment' | 'damaged' | 'missing';

/**
 * Held quantity of a reservation moved to unfilled (spec 0011 AC-22, AC-23). Spec 0013 turns it
 * into a short order line and an attention for support.
 */
export class ReservationShortened {
  /** Takes every field of the payload; see the spec's events table. */
  constructor(
    readonly reservationId: string,
    readonly sourceType: string,
    readonly sourceId: string,
    readonly sourceLineId: string,
    readonly variantId: string,
    readonly locationId: string,
    /** The quantity that moved from held to unfilled. */
    readonly quantity: number,
    readonly cause: ReservationShortenedCause,
    /** The movement group of the posting that caused it. */
    readonly groupId: string,
  ) {}
}

/**
 * Waiting demand of a reservation was filled from freed stock (spec 0011 AC-21). Spec 0013 clears
 * or lowers the line's short quantity.
 */
export class ReservationFilled {
  /** Takes every field of the payload; see the spec's events table. */
  constructor(
    readonly reservationId: string,
    readonly sourceType: string,
    readonly sourceId: string,
    readonly sourceLineId: string,
    /** The quantity that moved from unfilled to held. */
    readonly quantity: number,
    /** What the reservation still waits for after this fill. */
    readonly stillUnfilled: number,
  ) {}
}

/**
 * A carrier shipment left on hand below zero (spec 0011 AC-22): "shipped with no stock on the
 * books, count this SKU". Feature 17 turns it into a task for the warehouse hat.
 */
export class StockOverdrawn {
  /** Takes every field of the payload; see the spec's events table. */
  constructor(
    readonly variantId: string,
    readonly locationId: string,
    readonly onHandAfter: number,
    readonly groupId: string,
  ) {}
}
