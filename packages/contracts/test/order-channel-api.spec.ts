import { describe, expect, it } from 'vitest';
import {
  ChannelOrderInput,
  ChannelOrderSnapshot,
  OrderSourceCapturedFrom,
  RederivePaymentMethodInput,
} from '../src/index.js';

const id = '01937f3a-0000-7000-8000-000000000001';
const other = '01937f3a-0000-7000-8000-000000000002';

/** A Shopify shaped order as feature 13 builds it. */
const input = (over: Record<string, unknown> = {}) => ({
  storeId: id,
  channelId: id,
  channelOrderRef: '5551234567890',
  orderNumber: '#1001',
  placedAt: '2026-11-08T10:00:00.000Z',
  type: 'sale',
  paymentMethod: 'cod',
  shippingChargedAmount: '50.00',
  channelCustomer: { kind: 'shopify_customer', connectionId: other, externalId: '7001' },
  shipTo: { name: 'A', phone: '01001234567', phoneAlt: null, address: 'x' },
  lines: [
    {
      channelLineId: '13001',
      variantId: id,
      title: 'Tee M',
      quantity: 1,
      unitPrice: '570.00',
      discountAmount: '0.00',
      taxRate: '14.00',
    },
  ],
  ...over,
});

describe('ChannelOrderInput (spec 0013, Write paths)', () => {
  it('takes a Shopify shaped order with defaults for what the channel left out', () => {
    const parsed = ChannelOrderInput.parse(input());

    expect(parsed.prepaidAmount).toBe('0.00');
    expect(parsed.prepaidMethod).toBeNull();
    expect(parsed.source.capturedFrom).toBe('none');
    expect(parsed.firstStates).toBeNull();
  });

  it('takes an unmapped line (variant null) and keeps the phones as text', () => {
    const parsed = ChannelOrderInput.parse(
      input({
        shipTo: { name: 'A', phone: '01x 2345', phoneAlt: 'not a phone', address: 'x' },
        lines: [
          {
            channelLineId: '13001',
            variantId: null,
            title: 'Mystery tee',
            quantity: 2,
            unitPrice: '100.00',
            taxRate: '14.00',
          },
        ],
      }),
    );

    expect(parsed.lines[0]?.variantId).toBeNull();
    expect(parsed.lines[0]?.discountAmount).toBe('0.00');
    expect(parsed.shipTo.phone).toBe('01x 2345');
  });

  it('refuses two lines with one channel line id', () => {
    const line = input().lines[0];

    expect(ChannelOrderInput.safeParse(input({ lines: [line, line] })).success).toBe(false);
  });

  it('pairs a prepayment with its method, both ways', () => {
    expect(ChannelOrderInput.safeParse(input({ prepaidAmount: '100.00' })).success).toBe(false);
    expect(ChannelOrderInput.safeParse(input({ prepaidMethod: 'gateway' })).success).toBe(false);
    expect(
      ChannelOrderInput.safeParse(input({ prepaidAmount: '100.00', prepaidMethod: 'gateway' }))
        .success,
    ).toBe(true);
  });

  it('needs a gift reason exactly on a gifted order', () => {
    expect(ChannelOrderInput.safeParse(input({ type: 'gifted' })).success).toBe(false);
    expect(ChannelOrderInput.safeParse(input({ giftReasonCode: 'influencer' })).success).toBe(
      false,
    );
    expect(
      ChannelOrderInput.safeParse(input({ type: 'gifted', giftReasonCode: 'influencer' })).success,
    ).toBe(true);
  });

  it('takes the go live first state and the found states of an import, nothing else', () => {
    const goLive = { fulfillment: 'confirmed', reasonCode: 'go_live_import' };
    const found = {
      fulfillment: 'delivered',
      cash: 'reconciled',
      carrierDeliveryCreatedAt: '2026-10-01T09:00:00.000Z',
    };

    expect(ChannelOrderInput.safeParse(input({ firstStates: goLive })).success).toBe(true);
    expect(ChannelOrderInput.safeParse(input({ firstStates: found })).success).toBe(true);
    expect(
      ChannelOrderInput.safeParse(
        input({ firstStates: { fulfillment: 'packed', reasonCode: 'go_live_import' } }),
      ).success,
    ).toBe(false);
    expect(
      ChannelOrderInput.safeParse(
        input({ firstStates: { fulfillment: 'cancelled', cash: 'nothing_to_collect' } }),
      ).success,
    ).toBe(false);
    expect(
      ChannelOrderInput.safeParse(
        input({
          firstStates: {
            fulfillment: 'cancelled',
            cash: 'nothing_to_collect',
            cancelReasonCode: 'channel.customer',
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      ChannelOrderInput.safeParse(
        input({ firstStates: { fulfillment: 'refused', cash: 'nothing_to_collect' } }),
      ).success,
    ).toBe(false);
  });

  it('takes only a Shopify customer id or none', () => {
    expect(ChannelOrderInput.safeParse(input({ channelCustomer: null })).success).toBe(true);
    expect(
      ChannelOrderInput.safeParse(
        input({ channelCustomer: { kind: 'whatsapp_contact', externalId: '1' } }),
      ).success,
    ).toBe(false);
  });

  it('lists the capture sources of the database enum', () => {
    expect(OrderSourceCapturedFrom.options).toEqual([
      'landing_page',
      'shopify_journey',
      'whatsapp_thread',
      'manual',
      'none',
    ]);
  });
});

describe('ChannelOrderSnapshot', () => {
  const snapshot = (over: Record<string, unknown> = {}) => {
    const full: Record<string, unknown> = input(over);
    for (const key of ['storeId', 'channelId', 'channelOrderRef', 'orderNumber', 'placedAt']) {
      delete full[key];
    }
    return full;
  };

  it('is the input without its identity fields', () => {
    expect(ChannelOrderSnapshot.safeParse(snapshot()).success).toBe(true);
  });

  it('never carries a prepayment, a link, or first states', () => {
    expect(ChannelOrderSnapshot.safeParse(snapshot({ prepaidAmount: '10.00' })).success).toBe(
      false,
    );
    expect(
      ChannelOrderSnapshot.safeParse(
        snapshot({ relatedOrder: { orderId: other, relation: 'replacement_for' } }),
      ).success,
    ).toBe(false);
    expect(
      ChannelOrderSnapshot.safeParse(
        snapshot({ firstStates: { fulfillment: 'confirmed', reasonCode: 'go_live_import' } }),
      ).success,
    ).toBe(false);
  });
});

describe('RederivePaymentMethodInput (AC-25 c)', () => {
  it('pairs a prepayment with its method', () => {
    expect(
      RederivePaymentMethodInput.safeParse({
        paymentMethod: 'cod',
        prepaidAmount: '0.00',
        prepaidMethod: null,
      }).success,
    ).toBe(true);
    expect(
      RederivePaymentMethodInput.safeParse({
        paymentMethod: 'gateway',
        prepaidAmount: '100.00',
        prepaidMethod: null,
      }).success,
    ).toBe(false);
  });
});

describe('channel tax rates (security L2, review minor 7)', () => {
  it('caps a line rate and the shipping rate at 100', () => {
    const line = input().lines[0];

    expect(
      ChannelOrderInput.safeParse(input({ lines: [{ ...line, taxRate: '100.01' }] })).success,
    ).toBe(false);
    expect(ChannelOrderInput.safeParse(input({ shippingTaxRate: '140.00' })).success).toBe(false);
  });

  it('defaults the shipping rate to null (the sales tax setting applies)', () => {
    expect(ChannelOrderInput.parse(input()).shippingTaxRate).toBeNull();
    expect(ChannelOrderInput.parse(input({ shippingTaxRate: '14.00' })).shippingTaxRate).toBe(
      '14.00',
    );
  });
});
