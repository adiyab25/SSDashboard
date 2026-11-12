import { describe, expect, it } from 'vitest';
import type { Executor } from '../../database/sql.js';
import {
  OnlineGateKeyDuplicate,
  OnlineStockGate,
  type OnlineGateCheckResult,
  type OnlineGateCheckProvider,
} from './online-stock-gate.js';

const executor = {} as Executor;

const provider = (
  key: string,
  result: Partial<OnlineGateCheckResult> = {},
): OnlineGateCheckProvider => ({
  key,
  run: () =>
    Promise.resolve({
      label: 'inventory.onlineGate.checks.stockCounted',
      passed: true,
      count: 1,
      ...result,
    }),
});

// Spec 0011 AC-19: the gate stamps each provider's key and checks every result against the
// contract, so a bad action path fails at the api and never reaches the browser.
describe('OnlineStockGate', () => {
  it('runs the checks in registration order with the provider key', async () => {
    const gate = new OnlineStockGate();
    gate.register(provider('a.first'));
    gate.register(
      provider('b.second', {
        passed: false,
        action: {
          method: 'POST',
          path: '/api/orders/hold-open-orders',
          label: 'inventory.onlineGate.checks.stockCounted',
        },
      }),
    );

    const checks = await gate.evaluate('loc', executor);

    expect(checks.map((check) => [check.key, check.passed])).toEqual([
      ['a.first', true],
      ['b.second', false],
    ]);
    expect(checks[1]?.action?.path).toBe('/api/orders/hold-open-orders');
  });

  it('refuses a second check under the same key', () => {
    const gate = new OnlineStockGate();
    gate.register(provider('dup'));

    expect(() => gate.register(provider('dup'))).toThrow(OnlineGateKeyDuplicate);
  });

  it.each([
    ['another host', 'https://evil.example/api/x'],
    ['a protocol relative url', '//evil.example/api/x'],
    ['a double slash inside the path', '/api//orders'],
    ['a parent segment', '/api/orders/../settings'],
    ['a query', '/api/orders/hold?x=1'],
    ['a fragment', '/api/orders/hold#top'],
    ['a path outside the api', '/orders/hold'],
    ['a javascript url', 'javascript:alert(1)'],
    ['an empty path', ''],
  ])('fails loudly when a provider answers %s as its action path', async (_name, path) => {
    const gate = new OnlineStockGate();
    gate.register(
      provider('bad.action', {
        passed: false,
        action: { method: 'POST', path, label: 'inventory.onlineGate.checks.stockCounted' },
      }),
    );

    await expect(gate.evaluate('loc', executor)).rejects.toThrow();
  });

  it('fails loudly on an empty label or a method outside the allow list', async () => {
    const gate = new OnlineStockGate();
    gate.register({
      key: 'bad.label',
      run: () =>
        Promise.resolve({
          label: '' as OnlineGateCheckResult['label'],
          passed: true,
          count: 0,
        }),
    });
    await expect(gate.evaluate('loc', executor)).rejects.toThrow();

    const other = new OnlineStockGate();
    other.register(
      provider('bad.method', {
        action: {
          method: 'DELETE' as 'POST',
          path: '/api/orders/hold',
          label: 'inventory.onlineGate.checks.stockCounted',
        },
      }),
    );
    await expect(other.evaluate('loc', executor)).rejects.toThrow();
  });
});
