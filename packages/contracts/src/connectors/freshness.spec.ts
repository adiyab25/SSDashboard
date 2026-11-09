import { describe, expect, it } from 'vitest';
import {
  ConnectionFreshnessResponse,
  ConnectionFreshnessState,
  FRESHNESS_LATE_AFTER_MINUTES,
} from './freshness.js';

const ITEM = {
  connectionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  storePublicName: { en: 'Fixture Essentials', ar: 'أساسيات' },
  lastOrderAt: '2026-11-05T09:57:00.000000Z',
  lastSweepAt: '2026-11-05T09:58:00.000000Z',
  failedCommands: 0,
  failedOrderEvents: 1,
  state: 'fresh',
};

// Spec 0015 AC-18 and *API surface*: `GET /api/connections/freshness`.
describe('the freshness contract', () => {
  it('reads an answer with the server instant and one item per connection', () => {
    const parsed = ConnectionFreshnessResponse.parse({
      asOf: '2026-11-05T10:00:00.000000Z',
      items: [ITEM, { ...ITEM, lastOrderAt: null, lastSweepAt: null, storePublicName: {} }],
    });
    expect(parsed.items).toHaveLength(2);
    expect(FRESHNESS_LATE_AFTER_MINUTES).toBe(15);
  });

  it('knows exactly the states fresh, late, and failing', () => {
    expect(ConnectionFreshnessState.options).toEqual(['fresh', 'late', 'failing']);
    expect(
      ConnectionFreshnessResponse.safeParse({
        asOf: '2026-11-05T10:00:00Z',
        items: [{ ...ITEM, state: 'stale' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a negative count or a connection id that is no uuid', () => {
    const bad = (item: object) =>
      ConnectionFreshnessResponse.safeParse({ asOf: '2026-11-05T10:00:00Z', items: [item] })
        .success;
    expect(bad({ ...ITEM, failedOrderEvents: -1 })).toBe(false);
    expect(bad({ ...ITEM, connectionId: 'shop-1' })).toBe(false);
  });
});
