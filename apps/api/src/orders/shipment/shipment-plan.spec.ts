import { describe, expect, it } from 'vitest';
import {
  TERMINATED_BEFORE_PICKUP,
  counterPostingLines,
  decideAfterCancel,
  planShipment,
  unitCostsOf,
  type AfterCancelFacts,
} from './shipment-plan.js';

const LINE_A = '00000000-0000-4000-8000-00000000000a';
const LINE_B = '00000000-0000-4000-8000-00000000000b';
const LINE_C = '00000000-0000-4000-8000-00000000000c';
const LINE_D = '00000000-0000-4000-8000-00000000000d';
const SKU_M = '00000000-0000-4000-8000-0000000000a1';
const SKU_SERVICE = '00000000-0000-4000-8000-0000000000a2';
const SHELF = '00000000-0000-4000-8000-0000000000b1';
const ONLINE = '00000000-0000-4000-8000-0000000000b2';
const RESERVATION = '00000000-0000-4000-8000-0000000000c1';

const skus = new Map([
  [SKU_M, { kind: 'stocked' }],
  [SKU_SERVICE, { kind: 'service' }],
]);

// Spec 0013 AC-24: the posting is built from the order's lines, never from the source.
describe('planShipment', () => {
  it('posts a held line at its reservation and an unheld one at the online location', () => {
    const plan = planShipment(
      [
        { id: LINE_A, variantId: SKU_M, quantity: 2 },
        { id: LINE_B, variantId: SKU_M, quantity: 1 },
      ],
      [{ sourceLineId: LINE_A.toUpperCase(), reservationId: RESERVATION, locationId: SHELF }],
      skus,
      ONLINE,
    );

    expect(plan).toEqual({
      post: [
        {
          sourceLineId: LINE_A,
          variantId: SKU_M,
          locationId: SHELF,
          quantity: 2,
          reservationId: RESERVATION,
        },
        { sourceLineId: LINE_B, variantId: SKU_M, locationId: ONLINE, quantity: 1 },
      ],
      unmapped: [],
      unlocated: [],
      partial: [],
    });
  });

  it('marks a held line posted for less than its quantity as partial, so its rest is released', () => {
    const plan = planShipment(
      [
        { id: LINE_A, variantId: SKU_M, quantity: 2, lineQuantity: 3 },
        { id: LINE_B, variantId: SKU_M, quantity: 1, lineQuantity: 2 },
      ],
      [{ sourceLineId: LINE_A, reservationId: RESERVATION, locationId: SHELF }],
      skus,
      ONLINE,
    );

    expect(plan.partial).toEqual([LINE_A]);
    expect(plan.post.map((line) => line.quantity)).toEqual([2, 1]);
  });

  it('reports an unmapped line, an unlocated line, and leaves out a SKU that holds no stock', () => {
    const plan = planShipment(
      [
        { id: LINE_A, variantId: null, quantity: 1 },
        { id: LINE_B, variantId: SKU_M, quantity: 1 },
        { id: LINE_C, variantId: SKU_SERVICE, quantity: 1 },
        { id: LINE_D, variantId: SKU_M, quantity: 0 },
      ],
      [],
      skus,
      null,
    );

    expect(plan).toEqual({ post: [], unmapped: [LINE_A], unlocated: [LINE_B], partial: [] });
  });
});

describe('unitCostsOf', () => {
  it('takes the movement unit cost of a line, and averages two movements of one line', () => {
    const costs = unitCostsOf([
      { sourceLineId: LINE_A, quantity: -2, unitCost: '120.5000', totalCost: '-241.00' },
      { sourceLineId: LINE_B, quantity: -1, unitCost: '100.0000', totalCost: '-100.00' },
      { sourceLineId: LINE_B, quantity: -2, unitCost: '110.0000', totalCost: '-220.00' },
      { sourceLineId: null, quantity: -1, unitCost: '1.0000', totalCost: '-1.00' },
    ]);

    expect([...costs]).toEqual([
      [LINE_A, '120.5000'],
      [LINE_B, '106.6667'],
    ]);
  });
});

// Spec 0013 *After a cancel*: one ordered table, the first matching row wins.
describe('decideAfterCancel', () => {
  const facts = (over: Partial<AfterCancelFacts> = {}): AfterCancelFacts => ({
    jobGeneration: 1,
    orderGeneration: 1,
    posted: true,
    reversed: false,
    fulfillmentState: 'cancelled',
    origin: 'channel',
    reasonCode: 'channel.customer',
    stockOutSource: 'shopify_fulfillment',
    ...over,
  });

  it('row 1: another generation, or nothing posted', () => {
    expect(decideAfterCancel(facts({ orderGeneration: 2 }))).toEqual({ row: 1, then: 'nothing' });
    expect(decideAfterCancel(facts({ posted: false }))).toEqual({ row: 1, then: 'nothing' });
  });

  it('row 2: the posting is already reversed', () => {
    expect(decideAfterCancel(facts({ reversed: true }))).toEqual({ row: 2, then: 'nothing' });
  });

  it('row 3: a carrier shipped fact moved the order on', () => {
    expect(decideAfterCancel(facts({ fulfillmentState: 'shipped' }))).toEqual({
      row: 3,
      then: 'nothing',
    });
  });

  it('row 4: the carrier terminated the delivery before pickup, whatever the source', () => {
    expect(
      decideAfterCancel(facts({ origin: 'carrier', reasonCode: TERMINATED_BEFORE_PICKUP })),
    ).toEqual({ row: 4, then: 'reverse' });
  });

  it('row 5: a Shopify fulfillment or pick, pack and ship puts the pieces on the awaiting list', () => {
    expect(decideAfterCancel(facts())).toEqual({ row: 5, then: 'await_restock' });
    expect(decideAfterCancel(facts({ stockOutSource: 'pick_pack_ship' }))).toEqual({
      row: 5,
      then: 'await_restock',
    });
  });

  it('row 6: a carrier shipped stock out on a cancelled order is a fault', () => {
    expect(decideAfterCancel(facts({ stockOutSource: 'carrier_shipped' }))).toEqual({
      row: 6,
      then: 'fault',
    });
  });

  it('a posting whose request was cleared does nothing', () => {
    expect(decideAfterCancel(facts({ stockOutSource: null }))).toEqual({
      row: 1,
      then: 'nothing',
    });
  });
});

describe('counterPostingLines (owner ruling 2026-11-21)', () => {
  const movement = (sourceLineId: string | null, quantity: number) => ({
    variantId: SKU_M,
    locationId: SHELF,
    binId: null,
    lotId: null,
    quantity,
    unitCost: '100.0000',
    sourceLineId,
  });

  it('books back every outbound piece at its own location and cost when nothing was handled', () => {
    expect(
      counterPostingLines([movement(LINE_A, -2), movement(LINE_B, -1)], [], 'some_reason'),
    ).toEqual([
      {
        variantId: SKU_M,
        locationId: SHELF,
        quantity: 2,
        unitCost: '100.0000',
        sourceLineId: LINE_A,
        reasonCode: 'some_reason',
      },
      {
        variantId: SKU_M,
        locationId: SHELF,
        quantity: 1,
        unitCost: '100.0000',
        sourceLineId: LINE_B,
        reasonCode: 'some_reason',
      },
    ]);
  });

  it('leaves out the pieces of a line already restocked or closed, across its movements', () => {
    const lines = counterPostingLines(
      [movement(LINE_A, -1), movement(LINE_A, -2), movement(LINE_B, -1)],
      [
        { lineId: LINE_A.toUpperCase(), quantity: 2 },
        { lineId: LINE_B, quantity: 1 },
      ],
      'some_reason',
    );
    expect(lines.map((line) => [line.sourceLineId, line.quantity])).toEqual([[LINE_A, 1]]);
  });

  it('answers nothing when every piece was handled, and ignores inbound rows', () => {
    expect(
      counterPostingLines(
        [movement(LINE_A, -2), movement(LINE_C, 3)],
        [{ lineId: LINE_A, quantity: 5 }],
        'some_reason',
      ),
    ).toEqual([]);
  });
});
