import { describe, expect, it } from 'vitest';
import { decideConnectHealth, missingScopes, type ConnectFacts } from './connect-health.js';
import {
  hookAddress,
  isHttpsAddress,
  SHOPIFY_REQUIRED_SCOPES,
  SHOPIFY_WEBHOOK_TOPICS,
  topicsToCreate,
} from './shopify-app.js';

const passing: ConnectFacts = {
  grantedScopes: SHOPIFY_REQUIRED_SCOPES,
  latestOrder: { hasName: true, hasPhone: true, hasAddress: true },
  shopCurrency: 'EGP',
  installCurrency: 'EGP',
  shopTimezone: 'Africa/Cairo',
  installTimezone: 'Africa/Cairo',
  appOwner: 'organization',
  hookAddressIsHttps: true,
};

describe('decideConnectHealth (spec 0015 AC-1)', () => {
  it('is ok with no warning when every check passes', () => {
    expect(decideConnectHealth(passing)).toEqual({
      health: 'ok',
      reason: null,
      warnings: [],
      missingScopes: [],
    });
  });

  it('fails with SCOPES_MISSING and names the missing handles in the required order', () => {
    const verdict = decideConnectHealth({
      ...passing,
      grantedScopes: ['read_orders', 'write_orders', 'read_products', 'read_customers'],
    });
    expect(verdict).toMatchObject({
      health: 'failing',
      reason: 'SCOPES_MISSING',
      missingScopes: ['write_order_edits', 'read_inventory', 'write_inventory', 'read_locations'],
    });
  });

  it.each([
    ['name', { hasName: false, hasPhone: true, hasAddress: true }],
    ['phone', { hasName: true, hasPhone: false, hasAddress: true }],
    ['address', { hasName: true, hasPhone: true, hasAddress: false }],
  ])('fails with PROTECTED_DATA_MISSING when the latest order lacks its %s', (_, fields) => {
    expect(decideConnectHealth({ ...passing, latestOrder: fields })).toMatchObject({
      health: 'failing',
      reason: 'PROTECTED_DATA_MISSING',
    });
  });

  it('records nothing about protected data while the store has no order yet', () => {
    expect(decideConnectHealth({ ...passing, latestOrder: null }).health).toBe('ok');
  });

  it('fails with CURRENCY_MISMATCH for a shop in another currency', () => {
    expect(decideConnectHealth({ ...passing, shopCurrency: 'USD' })).toMatchObject({
      health: 'failing',
      reason: 'CURRENCY_MISMATCH',
    });
  });

  it('fails with PUBLIC_URL_NOT_HTTPS when webhooks could not be delivered', () => {
    expect(decideConnectHealth({ ...passing, hookAddressIsHttps: false })).toMatchObject({
      health: 'failing',
      reason: 'PUBLIC_URL_NOT_HTTPS',
    });
  });

  it('names one code, in the order scopes, protected data, currency, https', () => {
    const everything: ConnectFacts = {
      ...passing,
      grantedScopes: [],
      latestOrder: { hasName: false, hasPhone: false, hasAddress: false },
      shopCurrency: 'USD',
      hookAddressIsHttps: false,
    };
    expect(decideConnectHealth(everything).reason).toBe('SCOPES_MISSING');
    const scoped = { ...everything, grantedScopes: SHOPIFY_REQUIRED_SCOPES };
    expect(decideConnectHealth(scoped).reason).toBe('PROTECTED_DATA_MISSING');
    expect(decideConnectHealth({ ...scoped, latestOrder: null }).reason).toBe('CURRENCY_MISMATCH');
    expect(decideConnectHealth({ ...scoped, latestOrder: null, shopCurrency: 'EGP' }).reason).toBe(
      'PUBLIC_URL_NOT_HTTPS',
    );
  });

  it('keeps health ok with the time zone and person owned warnings', () => {
    expect(
      decideConnectHealth({ ...passing, shopTimezone: 'Asia/Dubai', appOwner: 'person' }),
    ).toEqual({
      health: 'ok',
      reason: null,
      warnings: ['SHOP_TIMEZONE_DIFFERS', 'APP_OWNED_BY_PERSON'],
      missingScopes: [],
    });
  });

  it('still shows the warnings on a failing verdict', () => {
    expect(
      decideConnectHealth({ ...passing, shopCurrency: 'USD', appOwner: 'person' }).warnings,
    ).toEqual(['APP_OWNED_BY_PERSON']);
  });

  it('compares scopes handle by handle', () => {
    expect(missingScopes(SHOPIFY_REQUIRED_SCOPES)).toEqual([]);
    expect(missingScopes(['write_orders'])).toContain('read_orders');
  });
});

describe('webhook subscriptions (spec 0015, Shopify app)', () => {
  const address = 'https://erp.example/api/hooks/shopify/00000000-0000-4000-8000-000000000001';

  it('has exactly the 13 topics of the spec', () => {
    expect(SHOPIFY_WEBHOOK_TOPICS).toHaveLength(13);
    expect(new Set(SHOPIFY_WEBHOOK_TOPICS).size).toBe(13);
  });

  it('builds the address from PUBLIC_URL and the connection id', () => {
    expect(hookAddress('https://erp.example', '00000000-0000-4000-8000-000000000001')).toBe(
      address,
    );
    expect(isHttpsAddress(address)).toBe(true);
    expect(isHttpsAddress('http://127.0.0.1:3000/api/hooks/shopify/x')).toBe(false);
  });

  it('registers every topic when none is subscribed', () => {
    expect(topicsToCreate([], address)).toEqual(SHOPIFY_WEBHOOK_TOPICS);
  });

  it('skips topics already subscribed for this address, not those of another address', () => {
    const left = topicsToCreate(
      [
        { topic: 'ORDERS_CREATE', uri: address },
        { topic: 'APP_UNINSTALLED', uri: address },
        { topic: 'ORDERS_UPDATED', uri: 'https://old.example/api/hooks/shopify/other' },
      ],
      address,
    );
    expect(left).toHaveLength(11);
    expect(left).not.toContain('ORDERS_CREATE');
    expect(left).not.toContain('APP_UNINSTALLED');
    expect(left).toContain('ORDERS_UPDATED');
  });
});
