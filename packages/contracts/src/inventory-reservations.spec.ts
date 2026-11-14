import { describe, expect, it } from 'vitest';
import {
  CarrierShipmentInput,
  ReleaseLinesInput,
  ReservationLine,
  ReservationSource,
  ReservedLine,
  ReserveLinesInput,
  carrierShipmentKey,
} from './inventory.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (n: number, quantity = 1) => ({
  sourceLineId: id(n),
  variantId: id(1000),
  locationId: id(2000),
  quantity,
});

describe('ReserveLinesInput (spec 0011 AC-5)', () => {
  const base = { sourceType: 'order', sourceId: id(1), shortage: 'refuse' as const };

  it('accepts 1 to 200 lines with distinct line ids', () => {
    expect(ReserveLinesInput.safeParse({ ...base, lines: [line(1)] }).success).toBe(true);
    const many = Array.from({ length: 200 }, (_, i) => line(i + 1));
    expect(ReserveLinesInput.safeParse({ ...base, lines: many }).success).toBe(true);
  });

  it('refuses no lines, 201 lines, and a repeated line id', () => {
    expect(ReserveLinesInput.safeParse({ ...base, lines: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 201 }, (_, i) => line(i + 1));
    expect(ReserveLinesInput.safeParse({ ...base, lines: tooMany }).success).toBe(false);
    expect(ReserveLinesInput.safeParse({ ...base, lines: [line(1), line(1)] }).success).toBe(false);
  });

  it('refuses a bad quantity, an unknown shortage policy, and an empty or long source type', () => {
    for (const quantity of [0, -1, 1.5, 2_147_483_648]) {
      expect(ReserveLinesInput.safeParse({ ...base, lines: [line(1, quantity)] }).success).toBe(
        false,
      );
    }
    expect(
      ReserveLinesInput.safeParse({ ...base, shortage: 'ignore', lines: [line(1)] }).success,
    ).toBe(false);
    expect(ReserveLinesInput.safeParse({ ...base, sourceType: '', lines: [line(1)] }).success).toBe(
      false,
    );
    expect(
      ReserveLinesInput.safeParse({ ...base, sourceType: 'x'.repeat(51), lines: [line(1)] })
        .success,
    ).toBe(false);
  });
});

describe('release and read shapes (spec 0011 AC-6)', () => {
  it('bounds sourceLineIds to 1 to 200 uuids', () => {
    expect(
      ReleaseLinesInput.safeParse({ sourceType: 'order', sourceLineIds: [id(1)] }).success,
    ).toBe(true);
    expect(ReleaseLinesInput.safeParse({ sourceType: 'order', sourceLineIds: [] }).success).toBe(
      false,
    );
    expect(
      ReleaseLinesInput.safeParse({
        sourceType: 'order',
        sourceLineIds: Array.from({ length: 201 }, (_, i) => id(i + 1)),
      }).success,
    ).toBe(false);
    expect(ReleaseLinesInput.safeParse({ sourceType: 'order', sourceLineIds: ['x'] }).success).toBe(
      false,
    );
  });

  it('names a document by a trimmed type and a uuid', () => {
    expect(ReservationSource.parse({ sourceType: ' order ', sourceId: id(1) })).toEqual({
      sourceType: 'order',
      sourceId: id(1),
    });
    expect(ReservationSource.safeParse({ sourceType: 'order', sourceId: 'nope' }).success).toBe(
      false,
    );
  });

  it('parses a reserved line and a reservation line answer', () => {
    expect(
      ReservedLine.safeParse({
        sourceLineId: id(1),
        reservationId: id(2),
        requested: 5,
        held: 4,
        unfilled: 1,
        short: true,
      }).success,
    ).toBe(true);
    expect(
      ReservationLine.safeParse({
        sourceLineId: id(1),
        reservationId: id(2),
        variantId: id(3),
        locationId: id(4),
        quantity: 0,
        openQuantity: 0,
        unfilledQuantity: 2,
        status: 'active',
      }).success,
    ).toBe(true);
    expect(
      ReservationLine.safeParse({
        sourceLineId: id(1),
        reservationId: id(2),
        variantId: id(3),
        locationId: id(4),
        quantity: 1,
        openQuantity: 1,
        unfilledQuantity: 0,
        status: 'gone',
      }).success,
    ).toBe(false);
  });
});

describe('CarrierShipmentInput (spec 0011 AC-22)', () => {
  const carrierLine = {
    sourceLineId: id(1),
    variantId: id(2),
    locationId: id(3),
    quantity: 2,
  };

  it('defaults the generation to 1 and the poster to null, and coerces the time', () => {
    const parsed = CarrierShipmentInput.parse({
      orderId: id(9),
      effectiveAt: '2026-11-01T10:00:00Z',
      lines: [carrierLine],
    });
    expect(parsed.generation).toBe(1);
    expect(parsed.postedBy).toBeNull();
    expect(parsed.effectiveAt).toBeInstanceOf(Date);
  });

  it('refuses 0 or 201 lines, a zero quantity, and a generation below 1', () => {
    const base = { orderId: id(9) };
    expect(CarrierShipmentInput.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(
      CarrierShipmentInput.safeParse({
        ...base,
        lines: Array.from({ length: 201 }, (_, i) => ({ ...carrierLine, sourceLineId: id(i + 1) })),
      }).success,
    ).toBe(false);
    expect(
      CarrierShipmentInput.safeParse({ ...base, lines: [{ ...carrierLine, quantity: 0 }] }).success,
    ).toBe(false);
    expect(
      CarrierShipmentInput.safeParse({ ...base, generation: 0, lines: [carrierLine] }).success,
    ).toBe(false);
  });

  it('builds the key: plain for generation 1, suffixed from 2', () => {
    expect(carrierShipmentKey(id(9))).toBe(`order_shipment:${id(9)}`);
    expect(carrierShipmentKey(id(9), 1)).toBe(`order_shipment:${id(9)}`);
    expect(carrierShipmentKey(id(9), 3)).toBe(`order_shipment:${id(9)}:3`);
  });
});
