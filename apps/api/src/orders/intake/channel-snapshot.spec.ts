import { ChannelOrderSnapshot, type ChannelOrderLineInput } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import type { PlanLine } from '../editing/edit-plan.js';
import { priceLines } from '../writer/order-money.js';
import { CHANNEL_EDIT_REMOVAL, diffChannelSnapshot } from './channel-snapshot.js';

const M = '01937f3a-0000-7000-8000-00000000000a';
const L = '01937f3a-0000-7000-8000-00000000000b';
const LINE_M = '01937f3a-0000-7000-8000-000000000101';
const LINE_L = '01937f3a-0000-7000-8000-000000000102';

/** A stored open line (570.00 at 14%, VAT inclusive) with the given id, variant, and channel id. */
function stored(
  id: string,
  variantId: string | null,
  channelLineId: string | null,
  quantity = 1,
  position = 1,
): PlanLine {
  const [priced] = priceLines(
    [{ quantity, unitPrice: '570.00', discountAmount: '0.00' }],
    '14.00',
    true,
  );
  if (!priced) throw new Error('no line');
  return {
    ...priced,
    position,
    id,
    variantId,
    channelLineId,
    prepaidAmount: '0.00',
    creditAppliedAmount: '0.00',
  };
}

const line = (over: Partial<ChannelOrderLineInput> = {}): ChannelOrderLineInput => ({
  channelLineId: 'c-m',
  variantId: M,
  title: 'Tee M',
  quantity: 1,
  unitPrice: '570.00',
  discountAmount: '0.00',
  taxRate: '14.00',
  ...over,
});

const snapshot = (lines: ChannelOrderLineInput[], shipTo: Record<string, unknown> = {}) =>
  ChannelOrderSnapshot.parse({
    type: 'sale',
    paymentMethod: 'cod',
    shippingChargedAmount: '50.00',
    channelCustomer: null,
    shipTo: { name: null, phone: null, address: null, ...shipTo },
    lines,
  });

describe('diffChannelSnapshot (spec 0013 AC-14)', () => {
  it('changes nothing for an echo of the stored lines', () => {
    const diff = diffChannelSnapshot([stored(LINE_M, M, 'c-m')], snapshot([line()]));

    expect(diff.operations).toEqual([{ kind: 'shipping', shippingChargedAmount: '50.00' }]);
    expect(diff.matchedIds).toEqual([]);
  });

  it('cancels a dropped line and replaces a line whose quantity changed', () => {
    const diff = diffChannelSnapshot(
      [stored(LINE_M, M, 'c-m'), stored(LINE_L, L, 'c-l', 1, 2)],
      snapshot([line({ quantity: 2 })]),
    );

    expect(diff.operations).toEqual([
      {
        kind: 'replace_line',
        lineId: LINE_M,
        variantId: M,
        title: 'Tee M',
        quantity: 2,
        unitPrice: '570.00',
        discountAmount: '0.00',
        taxRate: '14.00',
        channelLineId: 'c-m',
      },
      { kind: 'remove_line', lineId: LINE_L, cancelReasonCode: CHANNEL_EDIT_REMOVAL },
      { kind: 'shipping', shippingChargedAmount: '50.00' },
    ]);
  });

  it('matches a line with no channel id by variant, quantity, and price before adding', () => {
    const diff = diffChannelSnapshot(
      [stored(LINE_M, M, 'c-m'), stored(LINE_L, L, null, 1, 2)],
      snapshot([line(), line({ channelLineId: 'c-l', variantId: L, title: 'Tee L' })]),
    );

    expect(diff.matchedIds).toEqual([{ lineId: LINE_L, channelLineId: 'c-l' }]);
    expect(diff.operations.filter((op) => op.kind !== 'shipping')).toEqual([]);
  });

  it('matches the lowest position first among equal lines with no channel id', () => {
    const diff = diffChannelSnapshot(
      [stored(LINE_L, L, null, 1, 3), stored(LINE_M, L, null, 1, 2)],
      snapshot([line({ channelLineId: 'c-l', variantId: L })]),
    );

    expect(diff.matchedIds).toEqual([{ lineId: LINE_M, channelLineId: 'c-l' }]);
    expect(diff.operations).toContainEqual({
      kind: 'remove_line',
      lineId: LINE_L,
      cancelReasonCode: CHANNEL_EDIT_REMOVAL,
    });
  });

  it('adds a line the order does not hold, unmapped included', () => {
    const diff = diffChannelSnapshot(
      [stored(LINE_M, M, 'c-m')],
      snapshot([line(), line({ channelLineId: 'c-x', variantId: null, title: 'Mystery' })]),
    );

    expect(diff.operations).toContainEqual({
      kind: 'add_line',
      variantId: null,
      title: 'Mystery',
      quantity: 1,
      unitPrice: '570.00',
      discountAmount: '0.00',
      taxRate: '14.00',
      channelLineId: 'c-x',
    });
  });

  it('leaves a stored variant alone when the snapshot line is still unmapped, and an unmapped line for linkChannelLineVariant', () => {
    const mapped = diffChannelSnapshot(
      [stored(LINE_M, M, 'c-m')],
      snapshot([line({ variantId: null })]),
    );
    const unmapped = diffChannelSnapshot(
      [stored(LINE_M, null, 'c-m')],
      snapshot([line({ variantId: M })]),
    );

    expect(mapped.operations).toEqual([{ kind: 'shipping', shippingChargedAmount: '50.00' }]);
    expect(unmapped.operations).toEqual([{ kind: 'shipping', shippingChargedAmount: '50.00' }]);
  });

  it('sends only the ship to fields the channel gave', () => {
    const diff = diffChannelSnapshot(
      [stored(LINE_M, M, 'c-m')],
      snapshot([line()], { phone: '01001234567', phoneAlt: 'x', address: 'New Street' }),
    );

    expect(diff.operations[0]).toEqual({
      kind: 'ship_to',
      phone: '01001234567',
      phoneAlt: 'x',
      address: 'New Street',
    });
  });
});
