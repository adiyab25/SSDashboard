import { describe, expect, it } from 'vitest';
import { minimizeShopifyWebhook, topicIsProcessed } from './shopify-hook-payload.js';

// Spec 0015 AC-6: the inbox keeps the topic, the Shopify id, and the update time only.
const ORDER_BODY = {
  id: 5550000001001,
  admin_graphql_api_id: 'gid://shopify/Order/5550000001001',
  name: '#1001',
  updated_at: '2026-11-02T11:15:04+02:00',
  phone: '+201000000101',
  email: 'maha@example.com',
  note: 'call before delivery',
  customer: { first_name: 'Maha', phone: '+201000000101' },
  shipping_address: {
    name: 'Maha Experimental',
    address1: '12 Test Street',
    phone: '+201000000101',
  },
  line_items: [{ title: 'Fixture Basic Tee', sku: 'FX-TEE-BLK-M' }],
};

describe('minimizeShopifyWebhook (AC-6)', () => {
  it('keeps an order topic, its gid, and its update time in UTC, and nothing else', () => {
    const minimized = minimizeShopifyWebhook('orders/create', ORDER_BODY);
    expect(minimized).toEqual({
      subjectType: 'order',
      subjectExternalId: 'gid://shopify/Order/5550000001001',
      subjectVersion: '2026-11-02T09:15:04.000Z',
      payload: {
        topic: 'orders/create',
        id: 'gid://shopify/Order/5550000001001',
        updatedAt: '2026-11-02T09:15:04.000Z',
      },
    });
    const text = JSON.stringify(minimized);
    for (const personal of [
      '+2010',
      'Maha',
      'Test Street',
      'example.com',
      'call before',
      'Tee',
      '#1001',
    ]) {
      expect(text).not.toContain(personal);
    }
  });

  it('builds the gid from the REST id when no admin_graphql_api_id is sent, or a wrong type is', () => {
    expect(minimizeShopifyWebhook('orders/updated', { id: 42 }).subjectExternalId).toBe(
      'gid://shopify/Order/42',
    );
    expect(
      minimizeShopifyWebhook('orders/updated', {
        id: 42,
        admin_graphql_api_id: 'gid://shopify/Product/42',
      }).subjectExternalId,
    ).toBe('gid://shopify/Order/42');
    expect(minimizeShopifyWebhook('products/update', { id: '77' }).subjectExternalId).toBe(
      'gid://shopify/Product/77',
    );
  });

  it('names a refund by its order, an app message by no id, and an unknown topic by no subject', () => {
    expect(minimizeShopifyWebhook('refunds/create', { id: 1, order_id: 9 })).toMatchObject({
      subjectType: 'order',
      subjectExternalId: 'gid://shopify/Order/9',
    });
    expect(
      minimizeShopifyWebhook('app/uninstalled', { id: 1, name: 'Shop', email: 'o@example.com' }),
    ).toEqual({
      subjectType: 'app',
      subjectExternalId: null,
      subjectVersion: null,
      payload: { topic: 'app/uninstalled', id: null, updatedAt: null },
    });
    expect(minimizeShopifyWebhook('carts/create', { id: 1 }).subjectType).toBeNull();
  });

  it('keeps the item, location, and quantity of an inventory level message, numbers only', () => {
    expect(
      minimizeShopifyWebhook('inventory_levels/update', {
        inventory_item_id: 123,
        location_id: 444,
        available: 7,
        updated_at: '2026-11-02T09:15:04Z',
        note: 'dropped',
      }).payload,
    ).toEqual({
      topic: 'inventory_levels/update',
      id: null,
      updatedAt: '2026-11-02T09:15:04.000Z',
      inventoryItemId: '123',
      locationId: '444',
      available: 7,
    });
  });

  it('survives a body that is not an object and a time that is not a time', () => {
    expect(minimizeShopifyWebhook('orders/create', 'text')).toMatchObject({
      subjectExternalId: null,
      subjectVersion: null,
    });
    expect(
      minimizeShopifyWebhook('orders/create', { id: 1, updated_at: 'yesterday' }).subjectVersion,
    ).toBeNull();
  });
});

describe('topicIsProcessed (D9)', () => {
  it('sends a job for the four order topics and app/uninstalled only', () => {
    for (const topic of [
      'orders/create',
      'orders/updated',
      'orders/edited',
      'orders/cancelled',
      'app/uninstalled',
    ]) {
      expect(topicIsProcessed(topic)).toBe(true);
    }
    for (const topic of [
      'refunds/create',
      'products/update',
      'customers/create',
      'inventory_levels/update',
      'bulk_operations/finish',
    ]) {
      expect(topicIsProcessed(topic)).toBe(false);
    }
  });
});
