import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../../database/sql.js';
import { ReservationFilled, ReservationShortened } from '../../inventory/inventory.events.js';
import type { DomainEvents } from '../../platform/events/domain-events.js';
import { OrderAttentionRaised } from '../orders.events.js';
import type { OrderWriter } from '../writer/order-writer.js';
import { ShortLinesProjection } from './short-lines.projection.js';

const ORDER = '0190c0de-0000-7000-8000-000000000001';
const LINE = '0190c0de-0000-7000-8000-00000000000a';
const RESERVATION = '0190c0de-0000-7000-8000-0000000000c1';

function projectionWith(written: boolean) {
  const events = { on: vi.fn(), publish: vi.fn(() => Promise.resolve()) };
  const writer = { projectShortQuantity: vi.fn(() => Promise.resolve(written)) };
  const projection = new ShortLinesProjection(
    events as unknown as DomainEvents,
    writer as unknown as OrderWriter,
  );
  const tx = { execute: vi.fn() } as unknown as Transaction;
  return { projection, events, writer, tx };
}

const shortened = (sourceType = 'order'): ReservationShortened =>
  new ReservationShortened(
    RESERVATION,
    sourceType,
    ORDER,
    LINE,
    'variant',
    'location',
    1,
    'carrier_shipment',
    'group',
  );

// Spec 0013 AC-13, Domain events: the ledger's reservation events drive short_quantity.
describe('ShortLinesProjection', () => {
  it('registers on ReservationFilled and ReservationShortened as orders', () => {
    const { projection, events } = projectionWith(true);
    projection.onModuleInit();

    expect(events.on).toHaveBeenCalledWith(ReservationFilled, expect.any(Function), 'orders');
    expect(events.on).toHaveBeenCalledWith(ReservationShortened, expect.any(Function), 'orders');
  });

  it('lowers the line to what the reservation still waits for, on the same transaction', async () => {
    const { projection, writer, tx } = projectionWith(true);
    await projection.filled(tx, new ReservationFilled(RESERVATION, 'order', ORDER, LINE, 1, 0));

    expect(writer.projectShortQuantity).toHaveBeenCalledWith(tx, ORDER, LINE, { to: 0 });
  });

  it('raises the line and asks support when it wrote one', async () => {
    const { projection, writer, events, tx } = projectionWith(true);
    await projection.shortened(tx, shortened());

    expect(writer.projectShortQuantity).toHaveBeenCalledWith(tx, ORDER, LINE, { add: 1 });
    expect(events.publish).toHaveBeenCalledWith(
      tx,
      new OrderAttentionRaised(ORDER, 'reservation_shortened', 'carrier_shipment', RESERVATION),
    );
  });

  it('raises no attention when the line is no longer open or the order moved on', async () => {
    const { projection, events, tx } = projectionWith(false);
    await projection.shortened(tx, shortened());

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('ignores reservations of any other source', async () => {
    const { projection, writer, tx } = projectionWith(true);
    await projection.shortened(tx, shortened('transfer'));
    await projection.filled(tx, new ReservationFilled(RESERVATION, 'transfer', ORDER, LINE, 1, 0));

    expect(writer.projectShortQuantity).not.toHaveBeenCalled();
  });
});
