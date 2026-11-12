import { describe, expect, it } from 'vitest';
import { OnlineGateAction } from '../src/online-stock.js';

// Spec 0011 AC-19: a gate action points at a same origin api path only, because the web fetches or
// links it as it is (security re-review N1).
describe('OnlineGateAction path', () => {
  const action = (path: string) => ({ method: 'POST', path, label: 'inventory.x' });

  it.each(['/api/orders/hold-open-orders', '/api/a', '/api/connections/abc-1/test_run'])(
    'accepts %s',
    (path) => {
      expect(OnlineGateAction.safeParse(action(path)).success).toBe(true);
    },
  );

  it.each([
    'https://evil.example/api/x',
    '//evil.example/api/x',
    '/api//orders',
    '/api/orders//hold',
    '/api/orders/../settings',
    '/api/orders?x=1',
    '/api/orders#top',
    '/orders/hold',
    '/api/',
    'api/orders',
    'javascript:alert(1)',
    '',
  ])('refuses %s', (path) => {
    expect(OnlineGateAction.safeParse(action(path)).success).toBe(false);
  });
});
