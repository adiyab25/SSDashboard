import { describe, expect, it } from 'vitest';
import {
  carrierShippedFactExists,
  fulfilledLinesDiffer,
  returnedQuantitiesOf,
} from './channel-fulfillment.js';

const open = (id: string, channelLineId: string | null, quantity: number) => ({
  id,
  channelLineId,
  quantity,
  lineState: 'open' as const,
});

// Spec 0013 AC-27 (a, c, d): the pure checks behind the Shopify fulfillment calls.
describe('fulfilledLinesDiffer (AC-27 a)', () => {
  it('matches when every open line is fulfilled exactly, summed per Shopify line', () => {
    const lines = [open('a', 'gid-1', 2), open('b', 'gid-2', 1)];

    expect(
      fulfilledLinesDiffer(lines, [
        { channelLineId: 'gid-1', quantity: 1 },
        { channelLineId: 'gid-2', quantity: 1 },
        { channelLineId: 'gid-1', quantity: 1 },
      ]),
    ).toBe(false);
  });

  it('differs on a short, an extra, or a missing Shopify line, and on an app added line', () => {
    const lines = [open('a', 'gid-1', 2), open('b', 'gid-2', 1)];

    expect(fulfilledLinesDiffer(lines, [{ channelLineId: 'gid-1', quantity: 2 }])).toBe(true);
    expect(
      fulfilledLinesDiffer(lines, [
        { channelLineId: 'gid-1', quantity: 1 },
        { channelLineId: 'gid-2', quantity: 1 },
      ]),
    ).toBe(true);
    expect(
      fulfilledLinesDiffer(lines, [
        { channelLineId: 'gid-1', quantity: 2 },
        { channelLineId: 'gid-2', quantity: 1 },
        { channelLineId: 'gid-3', quantity: 1 },
      ]),
    ).toBe(true);
    expect(fulfilledLinesDiffer([open('c', null, 1)], [])).toBe(true);
  });

  it('ignores cancelled lines and fulfilled quantities of 0', () => {
    const lines = [
      open('a', 'gid-1', 1),
      { ...open('b', 'gid-2', 1), lineState: 'cancelled' as const },
    ];

    expect(
      fulfilledLinesDiffer(lines, [
        { channelLineId: 'gid-1', quantity: 1 },
        { channelLineId: 'gid-2', quantity: 0 },
      ]),
    ).toBe(false);
  });
});

describe('returnedQuantitiesOf (AC-27 d)', () => {
  it('spreads a return over the lines of that Shopify line, capped at what was posted', () => {
    const lines = [
      { id: 'a', channelLineId: 'gid-1', stockOutQuantity: 1, awaitingRestockQuantity: 0 },
      { id: 'b', channelLineId: 'gid-1', stockOutQuantity: 2, awaitingRestockQuantity: 1 },
      { id: 'c', channelLineId: 'gid-2', stockOutQuantity: null, awaitingRestockQuantity: 0 },
    ];

    expect(
      returnedQuantitiesOf(lines, [
        { channelLineId: 'gid-1', quantity: 5 },
        { channelLineId: 'gid-2', quantity: 1 },
      ]),
    ).toEqual([
      { lineId: 'a', quantity: 1 },
      { lineId: 'b', quantity: 1 },
    ]);
  });
});

describe('carrierShippedFactExists (AC-27 c)', () => {
  it('is false before pickup and for a cancelled order, true from shipped on or with a carrier request', () => {
    expect(carrierShippedFactExists({ fulfillmentState: 'packed', stockOutSource: null })).toBe(
      false,
    );
    expect(
      carrierShippedFactExists({
        fulfillmentState: 'cancelled',
        stockOutSource: 'shopify_fulfillment',
      }),
    ).toBe(false);
    expect(carrierShippedFactExists({ fulfillmentState: 'shipped', stockOutSource: null })).toBe(
      true,
    );
    expect(
      carrierShippedFactExists({
        fulfillmentState: 'confirmed',
        stockOutSource: 'carrier_shipped',
      }),
    ).toBe(true);
  });
});
