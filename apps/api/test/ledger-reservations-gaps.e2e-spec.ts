import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { driftedBalances, fixtures, level, posting } from './ledger.js';

// Spec 0011 milestone 2, QA gap probes beside ledger-reservations.e2e-spec.ts: boundaries of the
// line input, reversal of a carrier shipment filling demand, a posting read by a reversal key,
// parallel replays, and an unfilled only reservation shipped.

describe('stock reservations: QA gap probes', { timeout: 180_000 }, () => {
  let api: InProcessApi;
  let make: ReturnType<typeof fixtures>;
  let ledger: LedgerService;

  beforeAll(async () => {
    api = await startInProcessApi();
    make = fixtures(api.owner);
    ledger = api.app.get(LedgerService);
  });
  afterAll(async () => {
    await api?.close();
  });
  afterEach(async () => {
    expect(await driftedBalances(api.owner)).toEqual([]);
  });

  async function key() {
    return { variantId: await make.variant(), locationId: await make.location() };
  }
  const stock = (at: { variantId: string; locationId: string }, quantity: number) =>
    ledger.post(
      posting([{ ...at, quantity, unitCost: '5.0000' }], { sourceType: 'opening_balance' }),
    );
  const reserve = (
    orderId: string,
    shortage: 'reserve_available' | 'refuse',
    lines: { variantId: string; locationId: string; quantity: number; sourceLineId?: string }[],
  ) =>
    ledger.transaction((tx) =>
      ledger.reserveLines(tx, {
        sourceType: 'order',
        sourceId: orderId,
        shortage,
        lines: lines.map((l) => ({ ...l, sourceLineId: l.sourceLineId ?? randomUUID() })),
      }),
    );
  async function openOf(orderId: string) {
    const { rows } = await api.owner.pool.query<{
      open_quantity: number;
      unfilled_quantity: number;
      status: string;
    }>('SELECT open_quantity, unfilled_quantity, status FROM reservations WHERE source_id = $1', [
      orderId,
    ]);
    return rows;
  }

  it('accepts exactly 200 lines and refuses 0 lines', async () => {
    const at = await key();
    const lines = Array.from({ length: 200 }, () => ({ ...at, quantity: 1 }));
    const held = await reserve(randomUUID(), 'reserve_available', lines);
    expect(held).toHaveLength(200);
    expect(held.every((l) => l.unfilled === 1 && l.short)).toBe(true);
    await expect(reserve(randomUUID(), 'refuse', [])).rejects.toMatchObject({
      code: 'InvalidInput',
    });
  });

  it.each([0, -1, 1.5])('refuses a requested quantity of %s', async (quantity) => {
    const at = await key();
    await stock(at, 5);
    const orderId = randomUUID();
    await expect(
      reserve(orderId, 'reserve_available', [{ ...at, quantity }]),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
    expect(await openOf(orderId)).toEqual([]);
  });

  it('refuses a carrier shipment with no lines, a zero quantity, or a bad generation', async () => {
    const at = await key();
    const line = { sourceLineId: randomUUID(), ...at, quantity: 1 };
    await expect(
      ledger.postCarrierShipment({ orderId: randomUUID(), lines: [] }),
    ).rejects.toMatchObject({
      code: 'InvalidInput',
    });
    await expect(
      ledger.postCarrierShipment({ orderId: randomUUID(), lines: [{ ...line, quantity: 0 }] }),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
    await expect(
      ledger.postCarrierShipment({ orderId: randomUUID(), generation: 0, lines: [line] }),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
  });

  it('ships a reservation that holds only unfilled demand, below zero', async () => {
    const at = await key();
    const orderId = randomUUID();
    const [r] = await reserve(orderId, 'reserve_available', [{ ...at, quantity: 2 }]);
    expect(r).toMatchObject({ held: 0, unfilled: 2 });
    await ledger.postCarrierShipment({
      orderId,
      lines: [
        {
          sourceLineId: r?.sourceLineId ?? '',
          ...at,
          quantity: 2,
          reservationId: r?.reservationId,
        },
      ],
    });
    expect((await level(api.owner, at)).onHand).toBe(-2);
    expect(await openOf(orderId)).toMatchObject([
      { status: 'fulfilled', open_quantity: 0, unfilled_quantity: 0 },
    ]);
  });

  it('fills waiting demand when a carrier shipment that overdrew is reversed, then restocked', async () => {
    const at = await key();
    const shipped = await ledger.postCarrierShipment({
      orderId: randomUUID(),
      lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
    });
    const waiting = randomUUID();
    await reserve(waiting, 'reserve_available', [{ ...at, quantity: 1 }]);
    await ledger.reverse({
      groupId: shipped.groupId,
      idempotencyKey: randomUUID(),
      postedBy: null,
      reasonCode: 'test',
    });
    // on hand 0 after the reversal: nothing is free to fill yet
    expect(await openOf(waiting)).toMatchObject([{ open_quantity: 0, unfilled_quantity: 1 }]);
    await stock(at, 1);
    expect(await openOf(waiting)).toMatchObject([{ open_quantity: 1, unfilled_quantity: 0 }]);
  });

  it('reads a reversal by its key with reversesGroupId', async () => {
    const at = await key();
    await stock(at, 1);
    const shipped = await ledger.postCarrierShipment({
      orderId: randomUUID(),
      lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
    });
    const reversalKey = `rev:${randomUUID()}`;
    const reversal = await ledger.reverse({
      groupId: shipped.groupId,
      idempotencyKey: reversalKey,
      postedBy: null,
      reasonCode: 'test',
    });
    const stored = await ledger.postingFor(reversalKey);
    expect(stored?.groupId).toBe(reversal.groupId);
    expect(stored?.reversesGroupId).toBe(shipped.groupId);
  });

  it('turns 10 parallel identical carrier shipments into one posting and 9 replays', async () => {
    const at = await key();
    await stock(at, 5);
    const input = {
      orderId: randomUUID(),
      lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.postCarrierShipment(input)),
    );
    expect(new Set(results.map((r) => r.groupId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await level(api.owner, at)).onHand).toBe(4);
  });

  it('refuses a replay whose lines differ in SKU or line id', async () => {
    const at = await key();
    const other = await key();
    await stock(at, 2);
    await stock(other, 2);
    const orderId = randomUUID();
    const lineId = randomUUID();
    await ledger.postCarrierShipment({
      orderId,
      lines: [{ sourceLineId: lineId, ...at, quantity: 1 }],
    });
    await expect(
      ledger.postCarrierShipment({
        orderId,
        lines: [{ sourceLineId: lineId, ...other, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'IdempotencyConflict' });
    await expect(
      ledger.postCarrierShipment({
        orderId,
        lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'IdempotencyConflict' });
  });

  it('reads reservationsFor an unknown document as an empty list', async () => {
    expect(await ledger.reservationsFor({ sourceType: 'order', sourceId: randomUUID() })).toEqual(
      [],
    );
  });
});
