import { describe, expect, it } from 'vitest';
import { ConnectShopifyBody } from './connections.js';

// Security review L11: the connection label is typed by a manager and shown in the list, the
// detail, and the audit trail, so it refuses control and direction characters.
const body = (label: string) => ({
  label,
  storeCode: 'SHOP1',
  shopDomain: 'fixture-store.myshopify.com',
  clientId: 'fake-client-id',
  clientSecret: 'fake-client-secret',
  appOwner: 'organization',
});

describe('ConnectShopifyBody label', () => {
  it('accepts an English or Arabic label, trimmed', () => {
    expect(ConnectShopifyBody.parse(body('  Main store  ')).label).toBe('Main store');
    expect(ConnectShopifyBody.parse(body('المتجر الرئيسي')).label).toBe('المتجر الرئيسي');
  });

  it.each([
    ['a C0 control', 'Main\u0007store'],
    ['a line break', 'Main\nstore'],
    ['a C1 control', 'Main\u0085store'],
    ['the right to left override', 'Main‮erots'],
    ['a right to left mark', 'Main‏store'],
    ['a first strong isolate', 'Main⁨store⁩'],
    ['the Arabic letter mark', 'Main؜store'],
  ])('refuses %s', (_name, label) => {
    expect(ConnectShopifyBody.safeParse(body(label)).success).toBe(false);
  });
});
