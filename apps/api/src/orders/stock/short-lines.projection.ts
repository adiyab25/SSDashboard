import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from '../../database/sql.js';
import { ReservationFilled, ReservationShortened } from '../../inventory/inventory.events.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { orderTransactionFromLedger } from '../order-transactions.js';
import { OrderAttentionRaised } from '../orders.events.js';
import { OrderWriter } from '../writer/order-writer.js';

/** The reservation source type of an order line; every other source type is ignored. */
const ORDER_SOURCE = 'order';

/**
 * Keeps `order_lines.short_quantity` equal to the ledger's waiting demand between order writes
 * (spec 0013 AC-13, Domain events): `ReservationFilled` lowers it to the event's `stillUnfilled`,
 * `ReservationShortened` raises it by the event's quantity and, when it wrote the line (an open
 * line of an order in `new`, `confirmed`, or `packed`), publishes `OrderAttentionRaised` with
 * `reservation_shortened` for support (source type the event's `cause`, source id the reservation).
 *
 * Both run in the ledger's own transaction, which they hand to the writer through the one
 * sanctioned adapter, `orderTransactionFromLedger`. They write only the one line row and must
 * never take the order row lock, call a reservation function, open a transaction, or catch an
 * error (a failure rolls the stock change back). Reservations of any other source are ignored.
 */
@Injectable()
export class ShortLinesProjection implements OnModuleInit {
  /** Takes the events service and the order writer. */
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(OrderWriter) private readonly writer: OrderWriter,
  ) {}

  /** Registers the two handlers. */
  onModuleInit(): void {
    this.events.on(ReservationFilled, (tx, event) => this.filled(tx, event), 'orders');
    this.events.on(ReservationShortened, (tx, event) => this.shortened(tx, event), 'orders');
  }

  /** Lowers the line's short quantity to what the reservation still waits for. */
  async filled(tx: Transaction, event: ReservationFilled): Promise<void> {
    if (event.sourceType !== ORDER_SOURCE) return;
    await this.writer.projectShortQuantity(
      orderTransactionFromLedger(tx),
      event.sourceId,
      event.sourceLineId,
      { to: event.stillUnfilled },
    );
  }

  /** Raises the line's short quantity and asks support to look when the order still holds stock. */
  async shortened(tx: Transaction, event: ReservationShortened): Promise<void> {
    if (event.sourceType !== ORDER_SOURCE) return;
    const order = orderTransactionFromLedger(tx);
    const written = await this.writer.projectShortQuantity(
      order,
      event.sourceId,
      event.sourceLineId,
      { add: event.quantity },
    );
    if (!written) return;
    await this.events.publish(
      tx,
      new OrderAttentionRaised(
        event.sourceId,
        'reservation_shortened',
        event.cause,
        event.reservationId,
      ),
    );
  }
}
