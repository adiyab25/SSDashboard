import { describe, expect, it } from 'vitest';
import {
  CancelOrderBody,
  CreateGiftedOrderBody,
  CreateManualOrderBody,
  OrderEditBody,
  OrderListQuery,
  OrderMoveBody,
  orderLabelOf,
} from '../src/index.js';

const id = '01937f3a-0000-7000-8000-000000000001';
const other = '01937f3a-0000-7000-8000-000000000002';

const gifted = (line: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  clientRef: id,
  storeId: id,
  channelId: id,
  shipTo: { name: 'A', phone: '01001234567', address: 'x' },
  lines: [{ variantId: id, quantity: 1, ...line }],
  giftReasonCode: 'influencer',
  ...over,
});

describe('CreateGiftedOrderBody', () => {
  it('keeps the retail price: a price above 0 with a discount of price times quantity', () => {
    const ok = CreateGiftedOrderBody.safeParse(
      gifted({ quantity: 2, unitPrice: '500.00', discountAmount: '1000.00' }),
    );

    expect(ok.success).toBe(true);
  });

  it.each([
    ['a part discount', { unitPrice: '500.00', discountAmount: '100.00' }],
    ['no discount', { unitPrice: '500.00' }],
    ['a price of 0', { unitPrice: '0.00', discountAmount: '0.00' }],
    ['a discount above the value', { unitPrice: '500.00', discountAmount: '600.00' }],
  ])('refuses %s', (_name, line) => {
    expect(CreateGiftedOrderBody.safeParse(gifted(line)).success).toBe(false);
  });

  it('needs a goodwill link for replacement_goodwill and refuses a replacement link', () => {
    const line = { unitPrice: '500.00', discountAmount: '500.00' };
    const lonely = gifted(line, { giftReasonCode: 'replacement_goodwill' });
    const linked = gifted(line, {
      giftReasonCode: 'replacement_goodwill',
      relatedOrder: { orderId: other, relation: 'goodwill_for' },
    });
    const replacement = gifted(line, {
      relatedOrder: { orderId: other, relation: 'replacement_for' },
    });

    expect(CreateGiftedOrderBody.safeParse(lonely).success).toBe(false);
    expect(CreateGiftedOrderBody.safeParse(linked).success).toBe(true);
    expect(CreateGiftedOrderBody.safeParse(replacement).success).toBe(false);
  });
});

describe('CreateManualOrderBody', () => {
  const sale = (over: Record<string, unknown>) => ({
    clientRef: id,
    storeId: id,
    channelId: id,
    shipTo: { name: 'A', phone: '01001234567', address: 'x' },
    lines: [{ variantId: id, quantity: 1, unitPrice: '10.00' }],
    shippingChargedAmount: '5.00',
    paymentMethod: 'cod',
    ...over,
  });

  it('pairs cash on delivery with no prepayment and any other method with one', () => {
    expect(CreateManualOrderBody.safeParse(sale({})).success).toBe(true);
    expect(CreateManualOrderBody.safeParse(sale({ prepaidAmount: '15.00' })).success).toBe(false);
    expect(CreateManualOrderBody.safeParse(sale({ paymentMethod: 'instapay' })).success).toBe(
      false,
    );
    expect(
      CreateManualOrderBody.safeParse(sale({ paymentMethod: 'instapay', prepaidAmount: '15.00' }))
        .success,
    ).toBe(true);
  });

  it('normalizes Arabic digits in money and quantity', () => {
    const parsed = CreateManualOrderBody.parse(
      sale({ lines: [{ variantId: id, quantity: '٣', unitPrice: '١٢٫٥٠' }] }),
    );

    expect(parsed.lines[0]).toMatchObject({ quantity: 3, unitPrice: '12.50' });
  });
});

describe('OrderListQuery', () => {
  it('reads one value or a list for the states, and true or false text for the flags', () => {
    const query = OrderListQuery.parse({
      fulfillment: 'new',
      cash: ['unpaid', 'prepaid'],
      hold: 'true',
    });

    expect(query).toMatchObject({
      fulfillment: ['new'],
      cash: ['unpaid', 'prepaid'],
      hold: true,
      limit: 50,
    });
  });

  it('caps the page at 100 and refuses an unknown key', () => {
    expect(OrderListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(OrderListQuery.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe('orderLabelOf', () => {
  it('puts the store code beside the order number', () => {
    expect(orderLabelOf({ storeCode: 'ESS', orderNumber: '#1001' })).toBe('ESS/#1001');
  });
});

describe('OrderEditBody', () => {
  const at = '2026-11-08T10:00:00.123456Z';
  const edit = (operations: unknown[], over: Record<string, unknown> = {}) => ({
    expectedUpdatedAt: at,
    operations,
    ...over,
  });

  it('takes every operation kind, with Arabic digits in amounts', () => {
    const parsed = OrderEditBody.parse(
      edit(
        [
          { kind: 'ship_to', address: 'x', phoneAlt: null },
          { kind: 'add_line', variantId: id, quantity: '٢', unitPrice: '١٠٠.٠٠' },
          { kind: 'replace_line', lineId: id, variantId: other, quantity: 1, unitPrice: '5.00' },
          { kind: 'remove_line', lineId: other, cancelReasonCode: 'out_of_stock' },
          { kind: 'shipping', shippingChargedAmount: '0' },
        ],
        { reasonCode: 'size_change' },
      ),
    );

    expect(parsed.operations[1]).toMatchObject({
      quantity: 2,
      unitPrice: '100.00',
      discountAmount: '0.00',
    });
    expect(parsed.reasonCode).toBe('size_change');
  });

  it('refuses no operation, an empty ship to change, one line named twice, and a bad reason', () => {
    expect(OrderEditBody.safeParse(edit([])).success).toBe(false);
    expect(OrderEditBody.safeParse(edit([{ kind: 'ship_to' }])).success).toBe(false);
    expect(
      OrderEditBody.safeParse(
        edit([
          { kind: 'remove_line', lineId: id, cancelReasonCode: 'duplicate' },
          { kind: 'replace_line', lineId: id, variantId: id, quantity: 1, unitPrice: '1.00' },
        ]),
      ).success,
    ).toBe(false);
    expect(
      OrderEditBody.safeParse(
        edit([{ kind: 'shipping', shippingChargedAmount: '1' }], { reasonCode: 'whim' }),
      ).success,
    ).toBe(false);
    expect(
      OrderEditBody.safeParse(
        edit([{ kind: 'remove_line', lineId: id, cancelReasonCode: 'edit_removal' }]),
      ).success,
    ).toBe(false);
  });

  it('needs the concurrency token as an instant', () => {
    const ops = [{ kind: 'shipping', shippingChargedAmount: '1' }];
    expect(OrderEditBody.safeParse({ operations: ops }).success).toBe(false);
    expect(OrderEditBody.safeParse(edit(ops, { expectedUpdatedAt: 'yesterday' })).success).toBe(
      false,
    );
  });
});

describe('CancelOrderBody and OrderMoveBody', () => {
  const at = '2026-11-08T10:00:00.123456Z';

  it('takes a duplicate target only with the duplicate reason', () => {
    expect(
      CancelOrderBody.safeParse({
        expectedUpdatedAt: at,
        reasonCode: 'duplicate',
        duplicateOfOrderId: id,
      }).success,
    ).toBe(true);
    expect(
      CancelOrderBody.safeParse({ expectedUpdatedAt: at, reasonCode: 'duplicate' }).success,
    ).toBe(true);
    expect(
      CancelOrderBody.safeParse({
        expectedUpdatedAt: at,
        reasonCode: 'fake',
        duplicateOfOrderId: id,
      }).success,
    ).toBe(false);
    expect(CancelOrderBody.safeParse({ expectedUpdatedAt: at, reasonCode: 'bored' }).success).toBe(
      false,
    );
  });

  it('carries only the token on a move', () => {
    expect(OrderMoveBody.safeParse({ expectedUpdatedAt: at }).success).toBe(true);
    expect(OrderMoveBody.safeParse({ expectedUpdatedAt: at, extra: 1 }).success).toBe(false);
  });
});
