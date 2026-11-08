import { describe, expect, it } from 'vitest';
import {
  EditChangesPayment,
  EditOverpaid,
  GiftMustStayFree,
  InvalidOrderInput,
  InvalidPhoneAlt,
  InvalidPhoneMain,
  LineFullyDiscounted,
  OrderLocked,
  OrderNeedsALine,
  VariantUnknown,
} from '../orders.errors.js';
import { priceLines } from '../writer/order-money.js';
import {
  editAuditDiff,
  planEdit,
  type EditContext,
  type PlanLine,
  type PlanOperation,
  type PlanOrder,
} from './edit-plan.js';

const M = '01937f3a-0000-7000-8000-00000000000a';
const L = '01937f3a-0000-7000-8000-00000000000b';
const XL = '01937f3a-0000-7000-8000-00000000000c';
const LINE_1 = '01937f3a-0000-7000-8000-000000000101';
const LINE_2 = '01937f3a-0000-7000-8000-000000000102';

/** Two priced lines (570.00 x 2 and 400.00 x 1 at 14%, VAT inclusive), as stored. */
function storedLines(
  prices: [string, number][] = [
    ['570.00', 2],
    ['400.00', 1],
  ],
): PlanLine[] {
  const ids = [LINE_1, LINE_2];
  const variants = [M, L];
  return priceLines(
    prices.map(([unitPrice, quantity]) => ({ quantity, unitPrice, discountAmount: '0.00' })),
    '14.00',
    true,
  ).map((line, index) => ({
    ...line,
    id: ids[index] ?? '',
    variantId: variants[index] ?? null,
    channelLineId: null,
    prepaidAmount: '0.00',
    creditAppliedAmount: '0.00',
  }));
}

/** A COD sale of 1,540.00 plus 50.00 shipping, `confirmed`, nothing prepaid. */
function order(over: Partial<PlanOrder> = {}): PlanOrder {
  return {
    type: 'sale',
    fulfillmentState: 'confirmed',
    carrierDeliveryCreated: false,
    shippingChargedAmount: '50.00',
    prepaidAmount: '0.00',
    creditAppliedAmount: '0.00',
    codExpectedAmount: '1590.00',
    totalAmount: '1590.00',
    shipTo: {
      name: 'Old Name',
      phone: '+201001234567',
      phoneAlt: null,
      contactPhoneRaw: null,
      address: 'Old Street',
      courierNote: null,
      area: null,
    },
    lines: storedLines(),
    ...over,
  };
}

const context = (over: Partial<EditContext> = {}): EditContext => ({
  taxRate: '14.00',
  pricesIncludeVat: true,
  titles: new Map([
    [M, 'Tee M'],
    [L, 'Tee L'],
    [XL, 'Tee XL'],
  ]),
  allowZeroNetLines: false,
  unparseablePhone: 'refuse',
  unparseablePhoneAlt: 'refuse',
  ...over,
});

const addXl = (unitPrice = '400.00', discountAmount = '0.00'): PlanOperation => ({
  kind: 'add_line',
  variantId: XL,
  quantity: 1,
  unitPrice,
  discountAmount,
});

describe('planEdit: operations (spec 0013 AC-9)', () => {
  it('changes ship to fields and reports only the ones that differ', () => {
    const plan = planEdit(
      order(),
      [{ kind: 'ship_to', name: 'Old Name', address: 'New Street', courierNote: 'Ring twice' }],
      context(),
    );

    expect(plan.changed).toBe(true);
    expect(plan.changedShipToFields).toEqual(['address', 'courierNote']);
    expect(plan.shipToColumns).toEqual({ shipToAddress: 'New Street', courierNote: 'Ring twice' });
    expect(plan.cancelLines).toEqual([]);
    expect(plan.addLines).toEqual([]);
    expect(plan.totals.totalAmount).toBe('1590.00');
    expect(plan.phone).toBeNull();
  });

  it('changes nothing when every value is the one stored', () => {
    const plan = planEdit(
      order(),
      [
        { kind: 'ship_to', address: 'Old Street', phone: '01001234567', phoneAlt: null },
        { kind: 'shipping', shippingChargedAmount: '50.00' },
      ],
      context(),
    );

    expect(plan.changed).toBe(false);
    expect(plan.backToConfirmed).toBe(false);
  });

  it('parses a new main phone, relinks through it, and clears the phone kept as typed', () => {
    const unparsed = order({
      shipTo: { ...order().shipTo, phone: null, contactPhoneRaw: '01x 2345' },
    });

    const plan = planEdit(unparsed, [{ kind: 'ship_to', phone: '0100 765 4321' }], context());

    expect(plan.phone?.e164).toBe('+201007654321');
    expect(plan.shipToColumns).toEqual({ shipToPhone: '+201007654321', contactPhoneRaw: null });
    expect(plan.changedShipToFields).toEqual(['phone']);
  });

  it('sets and clears the second phone, the courier note, and the area codes', () => {
    const withAlt = order({
      shipTo: {
        ...order().shipTo,
        phoneAlt: '+201001111111',
        courierNote: 'x',
        area: { list: 'bosta', governorateCode: 'C', cityCode: 'N', zoneCode: 'Z' },
      },
    });

    const plan = planEdit(
      withAlt,
      [{ kind: 'ship_to', phoneAlt: null, courierNote: null, area: null }],
      context(),
    );
    const set = planEdit(order(), [{ kind: 'ship_to', phoneAlt: '01002222222' }], context());

    expect(plan.shipToColumns).toEqual({
      shipToPhoneAlt: null,
      courierNote: null,
      shipToAreaList: null,
      shipToGovernorateCode: null,
      shipToCityCode: null,
      shipToZoneCode: null,
    });
    expect(plan.changedShipToFields).toEqual(['phoneAlt', 'courierNote', 'area']);
    expect(set.shipToColumns).toEqual({ shipToPhoneAlt: '+201002222222' });
  });

  it('adds a line at the next position, priced at the tax setting, and recomputes the money', () => {
    const plan = planEdit(order(), [addXl()], context());

    expect(plan.addLines).toEqual([
      expect.objectContaining({
        position: 3,
        variantId: XL,
        title: 'Tee XL',
        grossAmount: '400.00',
        taxRate: '14.00',
        lineState: 'open',
      }),
    ]);
    expect(plan.totals).toMatchObject({
      linesGrossAmount: '1940.00',
      totalAmount: '1990.00',
      codExpectedAmount: '1990.00',
      codDueAmount: '1990.00',
    });
  });

  it('replaces a line: the old one cancelled with edit_removal, the new one at the next position', () => {
    const plan = planEdit(
      order(),
      [
        {
          kind: 'replace_line',
          lineId: LINE_1,
          variantId: L,
          quantity: 2,
          unitPrice: '570.00',
          discountAmount: '0.00',
        },
      ],
      context(),
    );

    expect(plan.cancelLines).toEqual([{ lineId: LINE_1, cancelReasonCode: 'edit_removal' }]);
    expect(plan.addLines.map((line) => [line.position, line.variantId, line.quantity])).toEqual([
      [3, L, 2],
    ]);
    expect(plan.totals.totalAmount).toBe('1590.00');
  });

  it('removes a line with its reason and lowers the total', () => {
    const plan = planEdit(
      order(),
      [{ kind: 'remove_line', lineId: LINE_2, cancelReasonCode: 'out_of_stock' }],
      context(),
    );

    expect(plan.cancelLines).toEqual([{ lineId: LINE_2, cancelReasonCode: 'out_of_stock' }]);
    expect(plan.totals).toMatchObject({ totalAmount: '1190.00', codExpectedAmount: '1190.00' });
  });

  it('changes the shipping charge and its tax', () => {
    const plan = planEdit(order(), [{ kind: 'shipping', shippingChargedAmount: '0' }], context());

    expect(plan.shippingChanged).toBe(true);
    expect(plan.shippingChargedAmount).toBe('0.00');
    expect(plan.totals).toMatchObject({ totalAmount: '1540.00', shippingTaxAmount: '0.00' });
  });

  it('moves a packed order back to confirmed, and keeps a new or confirmed one where it is', () => {
    const packed = planEdit(order({ fulfillmentState: 'packed' }), [addXl()], context());
    const fresh = planEdit(order({ fulfillmentState: 'new' }), [addXl()], context());

    expect(packed.backToConfirmed).toBe(true);
    expect(packed.fulfillmentAfter).toBe('confirmed');
    expect(fresh.backToConfirmed).toBe(false);
    expect(fresh.fulfillmentAfter).toBe('new');
  });

  it('spreads a prepayment again over the lines after a price neutral replace', () => {
    const prepaid = order({ prepaidAmount: '1590.00', codExpectedAmount: '0.00' });

    const plan = planEdit(
      prepaid,
      [
        {
          kind: 'replace_line',
          lineId: LINE_2,
          variantId: XL,
          quantity: 1,
          unitPrice: '400.00',
          discountAmount: '0.00',
        },
      ],
      context(),
    );

    expect(plan.lineShares.get(LINE_2)).toEqual({
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
    });
    expect(plan.addLines[0]?.prepaidAmount).toBe('400.00');
    expect(plan.lineShares.get(LINE_1)?.prepaidAmount).toBe('1140.00');
    expect(plan.totals.codExpectedAmount).toBe('0.00');
  });

  it('lets a person who may gift add a line with nothing to pay', () => {
    const plan = planEdit(
      order(),
      [addXl('400.00', '400.00')],
      context({ allowZeroNetLines: true }),
    );

    expect(plan.addLines[0]?.grossAmount).toBe('0.00');
  });

  it('adds a free line and fixes the address of a gifted order', () => {
    const gifted = order({
      type: 'gifted',
      lines: storedLines([['500.00', 1]]).map((line) => ({
        ...line,
        discountAmount: '500.00',
        netAmount: '0.00',
        taxAmount: '0.00',
        grossAmount: '0.00',
      })),
      shippingChargedAmount: '0.00',
      totalAmount: '0.00',
      codExpectedAmount: '0.00',
    });

    const plan = planEdit(
      gifted,
      [addXl('400.00', '400.00'), { kind: 'ship_to', address: 'Influencer Street' }],
      context(),
    );

    expect(plan.totals.totalAmount).toBe('0.00');
    expect(plan.addLines).toHaveLength(1);
  });
});

describe('planEdit: refusals (spec 0013 AC-2, AC-8, AC-9)', () => {
  it('refuses any edit once the carrier delivery exists (the freeze)', () => {
    expect(() =>
      planEdit(
        order({ carrierDeliveryCreated: true }),
        [{ kind: 'ship_to', address: 'x' }],
        context(),
      ),
    ).toThrow(OrderLocked);
  });

  it.each(['shipped', 'delivered', 'cancelled', 'refused'] as const)(
    'refuses an edit of a %s order',
    (state) => {
      expect(() =>
        planEdit(
          order({ fulfillmentState: state }),
          [{ kind: 'ship_to', address: 'x' }],
          context(),
        ),
      ).toThrow(OrderLocked);
    },
  );

  it('refuses an edit that leaves no open line', () => {
    expect(() =>
      planEdit(
        order(),
        [
          { kind: 'remove_line', lineId: LINE_1, cancelReasonCode: 'customer_cancelled' },
          { kind: 'remove_line', lineId: LINE_2, cancelReasonCode: 'customer_cancelled' },
        ],
        context(),
      ),
    ).toThrow(OrderNeedsALine);
  });

  it('refuses a new line on a fully prepaid order: it would change how it is paid', () => {
    const prepaid = order({ prepaidAmount: '1590.00', codExpectedAmount: '0.00' });

    expect(() => planEdit(prepaid, [addXl()], context())).toThrow(EditChangesPayment);
  });

  it('refuses an edit that makes a cash on delivery order free to collect', () => {
    expect(() =>
      planEdit(
        order({
          shippingChargedAmount: '0.00',
          totalAmount: '1540.00',
          codExpectedAmount: '1540.00',
        }),
        [
          { kind: 'remove_line', lineId: LINE_1, cancelReasonCode: 'duplicate' },
          {
            kind: 'replace_line',
            lineId: LINE_2,
            variantId: XL,
            quantity: 1,
            unitPrice: '400.00',
            discountAmount: '400.00',
          },
        ],
        context({ allowZeroNetLines: true }),
      ),
    ).toThrow(EditChangesPayment);
  });

  it('refuses dropping a 1,000.00 piece from a fully prepaid 2,000.00 order: overpaid', () => {
    const prepaid = order({
      lines: storedLines([
        ['1000.00', 1],
        ['1000.00', 1],
      ]),
      shippingChargedAmount: '0.00',
      prepaidAmount: '2000.00',
      totalAmount: '2000.00',
      codExpectedAmount: '0.00',
    });

    expect(() =>
      planEdit(
        prepaid,
        [{ kind: 'remove_line', lineId: LINE_2, cancelReasonCode: 'customer_cancelled' }],
        context(),
      ),
    ).toThrow(EditOverpaid);
  });

  it('refuses a priced line or a shipping charge on a gifted order', () => {
    const gifted = order({
      type: 'gifted',
      lines: storedLines([['500.00', 1]]).map((line) => ({
        ...line,
        discountAmount: '500.00',
        netAmount: '0.00',
        taxAmount: '0.00',
        grossAmount: '0.00',
      })),
      shippingChargedAmount: '0.00',
      totalAmount: '0.00',
      codExpectedAmount: '0.00',
    });

    expect(() => planEdit(gifted, [addXl()], context())).toThrow(GiftMustStayFree);
    expect(() =>
      planEdit(gifted, [{ kind: 'shipping', shippingChargedAmount: '30.00' }], context()),
    ).toThrow(GiftMustStayFree);
  });

  it('refuses a sale line with nothing to pay from a person who may not gift', () => {
    expect(() => planEdit(order(), [addXl('400.00', '400.00')], context())).toThrow(
      LineFullyDiscounted,
    );
  });

  it('refuses an unknown or archived variant', () => {
    expect(() => planEdit(order(), [addXl()], context({ titles: new Map() }))).toThrow(
      VariantUnknown,
    );
  });

  it('refuses to replace or remove a line that is not an open line of the order', () => {
    const cancelled = order({
      lines: storedLines().map((line, index) =>
        index === 1 ? { ...line, lineState: 'cancelled' as const } : line,
      ),
    });

    expect(() =>
      planEdit(
        order(),
        [{ kind: 'remove_line', lineId: XL, cancelReasonCode: 'duplicate' }],
        context(),
      ),
    ).toThrow(InvalidOrderInput);
    expect(() =>
      planEdit(
        cancelled,
        [{ kind: 'remove_line', lineId: LINE_2, cancelReasonCode: 'duplicate' }],
        context(),
      ),
    ).toThrow(InvalidOrderInput);
  });

  it('refuses a main or second phone that does not parse, never echoing it', () => {
    expect(() => planEdit(order(), [{ kind: 'ship_to', phone: '01x 2345' }], context())).toThrow(
      InvalidPhoneMain,
    );
    expect(() => planEdit(order(), [{ kind: 'ship_to', phoneAlt: '12' }], context())).toThrow(
      InvalidPhoneAlt,
    );
    try {
      planEdit(order(), [{ kind: 'ship_to', phone: '01x 2345' }], context());
    } catch (error) {
      expect(String(error)).not.toContain('2345');
    }
  });
});

describe('planEdit: a main phone that does not parse (review R3)', () => {
  it('is refused for a person (refuse) and kept as typed for a channel (keep_raw)', () => {
    const typed = '01x 9999';

    expect(() =>
      planEdit(
        order(),
        [{ kind: 'ship_to', phone: typed }],
        context({ unparseablePhone: 'refuse' }),
      ),
    ).toThrow(InvalidPhoneMain);
    const kept = planEdit(
      order(),
      [{ kind: 'ship_to', phone: typed }],
      context({ unparseablePhone: 'keep_raw' }),
    );

    expect(kept.phoneUnparseable).toBe(true);
    expect(kept.phone).toBeNull();
    expect(kept.shipToColumns).toEqual({ shipToPhone: null, contactPhoneRaw: typed });
    expect(kept.changedShipToFields).toEqual(['phone']);
    expect(editAuditDiff(order(), kept, [], 'channel')).toEqual({
      before: { shipToPhone: '+201001234567', contactPhoneRaw: null },
      after: { origin: 'channel', shipToPhone: null, contactPhoneRaw: typed },
    });
  });

  it('keeps nothing new when the channel sends the same unparsed text again', () => {
    const unparsed = order({
      shipTo: { ...order().shipTo, phone: null, contactPhoneRaw: '01x 9999' },
    });

    const plan = planEdit(
      unparsed,
      [{ kind: 'ship_to', phone: '01x 9999' }],
      context({ unparseablePhone: 'keep_raw' }),
    );

    expect(plan.changed).toBe(false);
    expect(plan.phoneUnparseable).toBe(false);
  });

  it('parses a good phone the same way in both modes', () => {
    const plan = planEdit(
      order(),
      [{ kind: 'ship_to', phone: '01007654321' }],
      context({ unparseablePhone: 'keep_raw' }),
    );

    expect(plan.phone?.e164).toBe('+201007654321');
    expect(plan.phoneUnparseable).toBe(false);
  });
});

describe('planEdit: a second phone that does not parse (review N4)', () => {
  const withAlt = () => order({ shipTo: { ...order().shipTo, phoneAlt: '+201112223334' } });

  it('is refused for a person and dropped for a channel, which says so', () => {
    expect(() =>
      planEdit(withAlt(), [{ kind: 'ship_to', phoneAlt: 'not a phone' }], context()),
    ).toThrow(InvalidPhoneAlt);
    const dropped = planEdit(
      withAlt(),
      [{ kind: 'ship_to', phoneAlt: 'not a phone' }],
      context({ unparseablePhone: 'keep_raw', unparseablePhoneAlt: 'drop' }),
    );

    expect(dropped.phoneAltUnparseable).toBe(true);
    expect(dropped.shipToColumns).toEqual({ shipToPhoneAlt: null });
    expect(dropped.changedShipToFields).toEqual(['phoneAlt']);
  });

  it('says nothing again when the stored second phone is already empty', () => {
    const plan = planEdit(
      order(),
      [{ kind: 'ship_to', phoneAlt: 'not a phone' }],
      context({ unparseablePhoneAlt: 'drop' }),
    );

    expect(plan.changed).toBe(false);
    expect(plan.phoneAltUnparseable).toBe(false);
  });
});

describe('planEdit: channel lines (spec 0013 AC-14)', () => {
  it('adds an unmapped line with the channel title, its own tax rate, and its channel id', () => {
    const plan = planEdit(
      order(),
      [
        {
          kind: 'add_line',
          variantId: null,
          title: 'Mystery tee',
          quantity: 1,
          unitPrice: '100.00',
          discountAmount: '0.00',
          taxRate: '0.00',
          channelLineId: '13009',
        },
      ],
      context({ allowZeroNetLines: true }),
    );

    expect(plan.addLines).toHaveLength(1);
    expect(plan.addLines[0]).toMatchObject({
      variantId: null,
      title: 'Mystery tee',
      channelLineId: '13009',
      taxRate: '0.00',
      grossAmount: '100.00',
    });
  });

  it('prefers the channel title over the catalog name of a mapped variant', () => {
    const plan = planEdit(
      order(),
      [
        {
          kind: 'add_line',
          variantId: XL,
          title: 'Shopify tee XL',
          quantity: 1,
          unitPrice: '100.00',
          discountAmount: '0.00',
        },
      ],
      context(),
    );

    expect(plan.addLines[0]?.title).toBe('Shopify tee XL');
  });

  it('refuses an unmapped line without a title', () => {
    expect(() =>
      planEdit(
        order(),
        [
          {
            kind: 'add_line',
            variantId: null,
            quantity: 1,
            unitPrice: '1.00',
            discountAmount: '0.00',
          },
        ],
        context(),
      ),
    ).toThrow(VariantUnknown);
  });
});

describe('editAuditDiff (spec 0013 Audit)', () => {
  it('names the changed fields with the OrderDetail names and the lines added and cancelled', () => {
    const current = order();
    const plan = planEdit(
      current,
      [
        { kind: 'ship_to', address: 'New Street', phone: '01007654321' },
        {
          kind: 'replace_line',
          lineId: LINE_1,
          variantId: L,
          quantity: 1,
          unitPrice: '570.00',
          discountAmount: '0.00',
        },
      ],
      context(),
    );

    const diff = editAuditDiff(current, plan, ['01937f3a-0000-7000-8000-000000000103'], 'person');

    expect(diff.before).toEqual({
      shipToAddress: 'Old Street',
      shipToPhone: '+201001234567',
      totalAmount: '1590.00',
      codExpectedAmount: '1590.00',
    });
    expect(diff.after).toEqual({
      origin: 'person',
      shipToAddress: 'New Street',
      shipToPhone: '+201007654321',
      totalAmount: '1020.00',
      codExpectedAmount: '1020.00',
      lines: {
        added: [
          {
            lineId: '01937f3a-0000-7000-8000-000000000103',
            variantId: L,
            quantity: 1,
            grossAmount: '570.00',
          },
        ],
        cancelled: [{ lineId: LINE_1, variantId: M, quantity: 2, grossAmount: '1140.00' }],
      },
    });
  });

  it('records a shipping change and leaves the money out of a ship to only edit', () => {
    const current = order();
    const shipping = planEdit(
      current,
      [{ kind: 'shipping', shippingChargedAmount: '70' }],
      context(),
    );
    const shipTo = planEdit(current, [{ kind: 'ship_to', name: 'New Name' }], context());

    expect(editAuditDiff(current, shipping, [], 'person').before).toEqual({
      shippingChargedAmount: '50.00',
      totalAmount: '1590.00',
      codExpectedAmount: '1590.00',
    });
    expect(editAuditDiff(current, shipTo, [], 'person')).toEqual({
      before: { shipToName: 'Old Name' },
      after: { origin: 'person', shipToName: 'New Name' },
    });
  });
});
