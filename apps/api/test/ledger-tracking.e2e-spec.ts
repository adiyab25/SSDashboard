import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LedgerError } from '../src/inventory/ledger/ledger.errors.js';
import {
  driftedBalances,
  fixtures,
  ledgerHarness,
  level,
  posting,
  type LedgerHarness,
} from './ledger.js';

// Spec 0002, Milestone 3: lots, serials, and reservations, against PostgreSQL.
describe('inventory ledger: tracking and reservations', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let make: ReturnType<typeof fixtures>;

  beforeAll(async () => {
    h = await ledgerHarness();
    make = fixtures(h.owner);
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    expect(await driftedBalances(h.owner)).toEqual([]);
    // For serial SKUs, in stock serials at each place equal its on hand (key invariant).
    const { rows } = await h.owner.pool.query(`
      SELECT sl.id FROM stock_levels sl
      JOIN product_variants v ON v.id = sl.variant_id AND v.tracking = 'serial'
      WHERE sl.on_hand <> (
        SELECT count(*) FROM serials s
        WHERE s.variant_id = sl.variant_id AND s.status = 'in_stock'
          AND s.location_id = sl.location_id AND s.bin_id IS NOT DISTINCT FROM sl.bin_id)`);
    expect(rows).toEqual([]);
  });

  async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }

  async function serialRows(variantId: string) {
    const { rows } = await h.owner.pool.query<{
      serial: string;
      status: string;
      location_id: string | null;
      bin_id: string | null;
    }>(
      'SELECT serial, status, location_id, bin_id FROM serials WHERE variant_id = $1 ORDER BY serial',
      [variantId],
    );
    return rows;
  }

  describe('lots and serials (AC-8)', () => {
    it('rejects a lot SKU without a lot, and a lot of another SKU', async () => {
      const variantId = await make.variant({ tracking: 'lot' });
      const otherLot = await make.lot(await make.variant({ tracking: 'lot' }));
      const locationId = await make.location();
      const line = { variantId, locationId, quantity: 1, unitCost: '1.0000' };

      await rejects(h.ledger.post(posting([line])), 'TrackingMismatch');
      await rejects(h.ledger.post(posting([{ ...line, lotId: otherLot }])), 'TrackingMismatch');
    });

    it('keeps a balance per lot', async () => {
      const variantId = await make.variant({ tracking: 'lot' });
      const [lotA, lotB] = [await make.lot(variantId), await make.lot(variantId)];
      const locationId = await make.location();

      await h.ledger.post(
        posting([
          { variantId, locationId, lotId: lotA, quantity: 2, unitCost: '1.0000' },
          { variantId, locationId, lotId: lotB, quantity: 3, unitCost: '2.0000' },
        ]),
      );

      expect(await level(h.owner, { variantId, locationId, lotId: lotA })).toMatchObject({
        onHand: 2,
        totalValue: '2.00',
      });
      expect(await level(h.owner, { variantId, locationId, lotId: lotB })).toMatchObject({
        onHand: 3,
        totalValue: '6.00',
      });
    });

    it('needs exactly as many serials as units', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();

      await rejects(
        h.ledger.post(
          posting([{ variantId, locationId, quantity: 2, unitCost: '1.0000', serials: ['S1'] }]),
        ),
        'TrackingMismatch',
      );
    });

    it('creates arriving serials, takes leaving ones out, and refuses one already in stock', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();
      const binId = await make.bin(locationId);
      const place = { variantId, locationId, binId };

      const received = await h.ledger.post(
        posting([{ ...place, quantity: 2, unitCost: '50.0000', serials: ['SN-2', 'SN-1'] }]),
      );
      await rejects(
        h.ledger.post(posting([{ ...place, quantity: 1, unitCost: '50.0000', serials: ['SN-1'] }])),
        'TrackingMismatch',
      );
      await h.ledger.post(posting([{ ...place, quantity: -1, serials: ['SN-1'] }]));

      expect(received.movements[0]?.serials).toEqual(['SN-1', 'SN-2']);
      expect(await serialRows(variantId)).toEqual([
        { serial: 'SN-1', status: 'out', location_id: null, bin_id: null },
        { serial: 'SN-2', status: 'in_stock', location_id: locationId, bin_id: binId },
      ]);
    });

    it('refuses a serial leaving from a place it is not at', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();
      const [binA, binB] = [await make.bin(locationId), await make.bin(locationId)];
      await h.ledger.post(
        posting([
          { variantId, locationId, binId: binA, quantity: 1, unitCost: '1.0000', serials: ['X'] },
        ]),
      );

      await rejects(
        h.ledger.post(
          posting([{ variantId, locationId, binId: binB, quantity: -1, serials: ['X'] }]),
        ),
        'TrackingMismatch',
      );
      await rejects(
        h.ledger.post(
          posting([{ variantId, locationId, binId: binA, quantity: -1, serials: ['Y'] }]),
        ),
        'TrackingMismatch',
      );
    });

    it('moves a serial between bins inside one posting', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();
      const [binA, binB] = [await make.bin(locationId), await make.bin(locationId)];
      await h.ledger.post(
        posting([
          { variantId, locationId, binId: binA, quantity: 1, unitCost: '9.0000', serials: ['M'] },
        ]),
      );

      // The inbound line sorts first by bin here; outbound serials are still checked first.
      const lines = [
        { variantId, locationId, binId: binB, quantity: 1, unitCost: '9.0000', serials: ['M'] },
        { variantId, locationId, binId: binA, quantity: -1, serials: ['M'] },
      ];
      await h.ledger.post(posting(binA < binB ? lines.reverse() : lines));

      expect(await serialRows(variantId)).toEqual([
        { serial: 'M', status: 'in_stock', location_id: locationId, bin_id: binB },
      ]);
    });

    it('returns a sold serial to stock on a later inbound movement', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();
      await h.ledger.post(
        posting([{ variantId, locationId, quantity: 1, unitCost: '1.0000', serials: ['R'] }]),
      );
      await h.ledger.post(posting([{ variantId, locationId, quantity: -1, serials: ['R'] }]));

      await h.ledger.post(
        posting([{ variantId, locationId, quantity: 1, unitCost: '1.0000', serials: ['R'] }], {
          sourceType: 'customer_return_restock',
        }),
      );

      expect((await serialRows(variantId))[0]?.status).toBe('in_stock');
    });

    it('rejects service and bundle SKUs, and archived SKUs, locations, and bins', async () => {
      const locationId = await make.location();
      const line = (variantId: string) => ({ variantId, locationId, quantity: 1, unitCost: '1' });

      await rejects(
        h.ledger.post(posting([line(await make.variant({ kind: 'service' }))])),
        'NotStockable',
      );
      await rejects(
        h.ledger.post(posting([line(await make.variant({ kind: 'bundle' }))])),
        'NotStockable',
      );
      const archived = await make.variant();
      await make.archive('product_variants', archived);
      await rejects(h.ledger.post(posting([line(archived)])), 'Archived');

      const variantId = await make.variant();
      const closed = await make.location();
      await make.archive('locations', closed);
      await rejects(
        h.ledger.post(posting([{ ...line(variantId), locationId: closed }])),
        'Archived',
      );
      const binId = await make.bin(locationId);
      await make.archive('bins', binId);
      await rejects(h.ledger.post(posting([{ ...line(variantId), binId }])), 'Archived');
    });

    it('reverses a shipment of serial stock back to the same bin', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();
      const binId = await make.bin(locationId);
      const place = { variantId, locationId, binId };
      await h.ledger.post(
        posting([{ ...place, quantity: 2, unitCost: '10.0000', serials: ['A1', 'A2'] }]),
      );
      const shipment = await h.ledger.post(
        posting([{ ...place, quantity: -2, serials: ['A1', 'A2'] }], {
          sourceType: 'order_shipment',
        }),
      );

      const reversal = await h.ledger.reverse({
        postedBy: null,
        groupId: shipment.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'cancelled',
      });

      expect(reversal.movements[0]).toMatchObject({ quantity: 2, serials: ['A1', 'A2'] });
      expect((await serialRows(variantId)).map((s) => [s.status, s.bin_id])).toEqual([
        ['in_stock', binId],
        ['in_stock', binId],
      ]);
      expect(await level(h.owner, place)).toMatchObject({ onHand: 2, totalValue: '20.00' });
    });

    it('reverses a shipment of lot stock back to the same lot', async () => {
      const variantId = await make.variant({ tracking: 'lot' });
      const lotId = await make.lot(variantId);
      const locationId = await make.location();
      const place = { variantId, locationId, lotId };
      await h.ledger.post(posting([{ ...place, quantity: 4, unitCost: '2.0000' }]));
      const shipment = await h.ledger.post(posting([{ ...place, quantity: -4 }]));

      await h.ledger.reverse({
        postedBy: null,
        groupId: shipment.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'cancelled',
      });

      expect(await level(h.owner, place)).toMatchObject({ onHand: 4, totalValue: '8.00' });
    });
  });

  describe('reservations (AC-4, AC-9)', () => {
    async function stocked(onHand: number) {
      const key = { variantId: await make.variant(), locationId: await make.location() };
      await h.ledger.post(posting([{ ...key, quantity: onHand, unitCost: '1.0000' }]));
      return key;
    }

    function reservation(key: { variantId: string; locationId: string }, quantity: number) {
      return h.ledger.reserve({
        ...key,
        quantity,
        sourceType: 'sales_order',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
      });
    }

    it('protects reserved stock from unreserved outbound lines, but lets the reservation ship', async () => {
      const key = await stocked(10);
      const held = await reservation(key, 8);

      await rejects(h.ledger.post(posting([{ ...key, quantity: -3 }])), 'InsufficientStock');
      await h.ledger.post(posting([{ ...key, quantity: -3, reservationId: held.id }]));

      const [row] = await h.ledger.getAvailable({ variantId: key.variantId });
      expect(row).toMatchObject({ onHand: 7, reserved: 5, available: 2 });
    });

    it('rejects a reservation larger than available', async () => {
      const key = await stocked(5);
      await reservation(key, 4);

      await rejects(reservation(key, 2), 'InsufficientStock');
    });

    it('does not count a non sellable bin as available', async () => {
      const variantId = await make.variant();
      const locationId = await make.location();
      const quarantine = await make.bin(locationId, { isSellable: false });
      await h.ledger.post(
        posting([{ variantId, locationId, binId: quarantine, quantity: 5, unitCost: '1.0000' }]),
      );

      await rejects(reservation({ variantId, locationId }, 1), 'InsufficientStock');
    });

    it('releases part of a reservation in place, then closes it at zero', async () => {
      const key = await stocked(5);
      const held = await reservation(key, 5);

      const partial = await h.ledger.release({ reservationId: held.id, quantity: 2 });
      const rest = await h.ledger.release({ reservationId: held.id });

      expect(partial).toMatchObject({ openQuantity: 3, status: 'active' });
      expect(rest).toMatchObject({ openQuantity: 0, status: 'released' });
      await expect(h.ledger.release({ reservationId: held.id })).rejects.toMatchObject({
        code: 'ReservationClosed',
      });
    });

    it('refuses to release more than is open', async () => {
      const key = await stocked(5);
      const held = await reservation(key, 2);

      await rejects(h.ledger.release({ reservationId: held.id, quantity: 3 }), 'QuantityTooLarge');
    });

    it('marks a reservation fulfilled when shipments consume it, and never reactivates it', async () => {
      const key = await stocked(5);
      const held = await reservation(key, 2);

      const shipment = await h.ledger.post(
        posting([{ ...key, quantity: -2, reservationId: held.id }]),
      );
      await h.ledger.reverse({
        postedBy: null,
        groupId: shipment.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'cancelled',
      });

      const { rows } = await h.owner.pool.query<{ status: string; open_quantity: number }>(
        'SELECT status, open_quantity FROM reservations WHERE id = $1',
        [held.id],
      );
      expect(rows[0]).toEqual({ status: 'fulfilled', open_quantity: 0 });
    });

    it('refuses to fulfil a reservation with another lot', async () => {
      const variantId = await make.variant({ tracking: 'lot' });
      const [lotA, lotB] = [await make.lot(variantId), await make.lot(variantId)];
      const locationId = await make.location();
      await h.ledger.post(
        posting([
          { variantId, locationId, lotId: lotA, quantity: 3, unitCost: '1.0000' },
          { variantId, locationId, lotId: lotB, quantity: 3, unitCost: '1.0000' },
        ]),
      );
      const held = await h.ledger.reserve({
        variantId,
        locationId,
        lotId: lotA,
        quantity: 2,
        sourceType: 'sales_order',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
      });

      await rejects(
        h.ledger.post(
          posting([{ variantId, locationId, lotId: lotB, quantity: -2, reservationId: held.id }]),
        ),
        'ReservationMismatch',
      );
    });

    it('refuses to fulfil more than the reservation has open', async () => {
      const key = await stocked(5);
      const held = await reservation(key, 2);

      await rejects(
        h.ledger.post(posting([{ ...key, quantity: -3, reservationId: held.id }])),
        'ReservationMismatch',
      );
    });

    it('allows one active reservation per document line', async () => {
      const key = await stocked(5);
      const line = {
        ...key,
        quantity: 1,
        sourceType: 'sales_order',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
      };
      await h.ledger.reserve(line);

      await rejects(h.ledger.reserve(line), 'DuplicateReservation');
    });

    it('refuses to reserve a service SKU or at an archived location', async () => {
      const locationId = await make.location();
      const service = await make.variant({ kind: 'service' });
      await rejects(reservation({ variantId: service, locationId }, 1), 'NotStockable');

      const variantId = await make.variant();
      await make.archive('locations', locationId);
      await rejects(reservation({ variantId, locationId }, 1), 'Archived');
    });

    it('never over reserves under concurrent requests', async () => {
      const key = await stocked(5);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => reservation(key, 1)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    });

    it('sums on hand over every bin when protecting reserved stock (covers: AC-4)', async () => {
      const variantId = await make.variant();
      const locationId = await make.location();
      const [binA, binB] = [await make.bin(locationId), await make.bin(locationId)];
      await h.ledger.post(
        posting([
          { variantId, locationId, binId: binA, quantity: 4, unitCost: '1' },
          { variantId, locationId, binId: binB, quantity: 4, unitCost: '1' },
        ]),
      );
      await reservation({ variantId, locationId }, 6);

      // 8 on hand across both bins, 6 reserved: 2 may leave without the reservation.
      await h.ledger.post(posting([{ variantId, locationId, binId: binA, quantity: -2 }]));
      await rejects(
        h.ledger.post(posting([{ variantId, locationId, binId: binB, quantity: -1 }])),
        'InsufficientStock',
      );
    });

    it('serializes unreserved shipments from two bins against one reservation (covers: AC-4)', async () => {
      const variantId = await make.variant();
      const locationId = await make.location();
      const [binA, binB] = [await make.bin(locationId), await make.bin(locationId)];
      await h.ledger.post(
        posting([
          { variantId, locationId, binId: binA, quantity: 5, unitCost: '1' },
          { variantId, locationId, binId: binB, quantity: 5, unitCost: '1' },
        ]),
      );
      await reservation({ variantId, locationId }, 6);

      // 10 on hand, 6 reserved: only 4 of 6 parallel unreserved shipments may leave,
      // whichever bin each takes from.
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          h.ledger.post(
            posting([{ variantId, locationId, binId: i % 2 ? binA : binB, quantity: -1 }]),
          ),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
      const { rows } = await h.owner.pool.query<{ on_hand: number }>(
        'SELECT sum(on_hand)::int AS on_hand FROM stock_levels WHERE variant_id = $1',
        [variantId],
      );
      expect(rows[0]?.on_hand).toBe(6);
    });

    it('rejects a reservation for a lot of another SKU', async () => {
      const key = await stocked(5);
      const foreignLot = await make.lot(await make.variant({ tracking: 'lot' }));

      await rejects(
        h.ledger.reserve({
          ...key,
          lotId: foreignLot,
          quantity: 1,
          sourceType: 'sales_order',
          sourceId: randomUUID(),
          sourceLineId: randomUUID(),
        }),
        'UnknownReference',
      );
    });

    it('rejects releasing a reservation that does not exist', async () => {
      await rejects(h.ledger.release({ reservationId: randomUUID() }), 'NotFound');
    });

    it('lets an allow_negative location reserve beyond what is available (covers: AC-9)', async () => {
      const key = {
        variantId: await make.variant(),
        locationId: await make.location({ allowNegative: true }),
      };

      const held = await reservation(key, 3);

      expect(held).toMatchObject({ quantity: 3, openQuantity: 3, status: 'active' });
    });

    it('reserves a lot tracked SKU only by lot, even where stock may go negative (covers: AC-8)', async () => {
      const variantId = await make.variant({ tracking: 'lot' });
      const locationId = await make.location({ allowNegative: true });

      await rejects(reservation({ variantId, locationId }, 1), 'TrackingMismatch');
    });

    it('refuses a lot on a reservation for a SKU that is not lot tracked (covers: AC-8)', async () => {
      const key = await stocked(5);
      const lotId = await make.lot(key.variantId);

      await rejects(
        h.ledger.reserve({
          ...key,
          lotId,
          quantity: 1,
          sourceType: 'sales_order',
          sourceId: randomUUID(),
          sourceLineId: randomUUID(),
        }),
        'TrackingMismatch',
      );
    });
  });
});
