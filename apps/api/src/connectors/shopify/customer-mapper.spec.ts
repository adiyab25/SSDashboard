import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mapShopifyCustomer,
  parseShopifyCustomer,
  ShopifyCustomerMappingError,
  type ShopifyCustomer,
} from './customer-mapper.js';
import { CUSTOMER_READ, CUSTOMER_READ_OPERATION } from './shopify-queries.js';

// Spec 0015 task 11 (AC-15, Value sourcing "customer webhook") over the synthetic customer
// fixtures (to be replaced by recordings). Pure: no database.

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CONNECTION = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e03';

function fixture(file: string): ShopifyCustomer {
  const json = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as {
    response: { body: { data: { customer: unknown } } };
  };
  return parseShopifyCustomer(json.response.body.data.customer);
}

describe('the CUSTOMER_READ query', () => {
  it('names its operation and id variable and selects no email or address', () => {
    expect(CUSTOMER_READ).toContain(`query ${CUSTOMER_READ_OPERATION}($id: ID!)`);
    expect(CUSTOMER_READ).toContain('customer(id: $id)');
    expect(CUSTOMER_READ).toContain('defaultPhoneNumber');
    expect(CUSTOMER_READ).not.toMatch(/email|address/i);
  });
});

describe('mapShopifyCustomer (AC-15)', () => {
  it('parses an Egyptian phone at this edge and passes the channel id, joined name, and updatedAt', () => {
    const input = mapShopifyCustomer(
      fixture('customer-updated-phone/01-customer-read.json'),
      CONNECTION,
    );
    expect(input).toEqual({
      phone: { e164: '+201000000120', kind: 'mobile' },
      channelCustomer: {
        kind: 'shopify_customer',
        connectionId: CONNECTION,
        externalId: 'gid://shopify/Customer/8880000020001',
      },
      name: 'سارة تجريبية',
      seenAt: new Date('2026-11-04T10:00:00Z'),
    });
  });

  it('gives a null phone (the no_phone case) to a customer without one', () => {
    const input = mapShopifyCustomer(
      fixture('customer-updated-no-phone/01-customer-read.json'),
      CONNECTION,
    );
    expect(input.phone).toBeNull();
    expect(input.name).toBe('ليلى تجريبية');
  });

  it('reads the deprecated phone only without a default phone number, and drops one that does not parse', () => {
    const base = fixture('customer-updated-no-phone/01-customer-read.json');
    expect(mapShopifyCustomer({ ...base, phone: '01000000121' }, CONNECTION).phone).toEqual({
      e164: '+201000000121',
      kind: 'mobile',
    });
    expect(mapShopifyCustomer({ ...base, phone: '+201300000101' }, CONNECTION).phone).toBeNull();
    expect(
      mapShopifyCustomer(
        { ...base, defaultPhoneNumber: { phoneNumber: '0100000' }, phone: '01000000121' },
        CONNECTION,
      ).phone,
    ).toBeNull();
  });

  it('strips control and direction characters from the name, null when nothing is left', () => {
    const base = fixture('customer-updated-no-phone/01-customer-read.json');
    expect(
      mapShopifyCustomer({ ...base, firstName: '\u202Eليلى\u0000', lastName: null }, CONNECTION)
        .name,
    ).toBe('ليلى');
    expect(
      mapShopifyCustomer({ ...base, firstName: ' ', lastName: '‏' }, CONNECTION).name,
    ).toBeNull();
  });

  it('drops lone surrogates from the name and refuses a customer id that is not storable (security review N4)', () => {
    const base = fixture('customer-updated-no-phone/01-customer-read.json');
    expect(
      mapShopifyCustomer({ ...base, firstName: 'ليلى\uD800', lastName: '\uDC00' }, CONNECTION).name,
    ).toBe('ليلى');
    expect(() => parseShopifyCustomer({ ...base, id: 'gid://shopify/Customer/1\uD800' })).toThrow(
      ShopifyCustomerMappingError,
    );
  });
});

describe('parseShopifyCustomer', () => {
  it('refuses an unreadable customer naming only the paths, never a value (Law 151)', () => {
    let error: unknown = null;
    try {
      parseShopifyCustomer({ id: 'gid://shopify/Customer/1', firstName: 'سارة', phone: 42 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ShopifyCustomerMappingError);
    expect((error as ShopifyCustomerMappingError).code).toBe('CUSTOMER_UNREADABLE');
    expect((error as Error).message).not.toContain('سارة');
    expect((error as ShopifyCustomerMappingError).paths).toContain('phone');
  });
});
