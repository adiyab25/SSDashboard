import { describe, expect, it } from 'vitest';
import type { Executor } from '../../database/sql.js';
import type { OrderQueries } from '../../orders/reading/order-query.service.js';
import type { SettingsService } from '../../platform/settings/settings.service.js';
import { CustomerRiskSignals, daysBefore } from './customer-risk-signals.js';

/** A signal reader over stub orders reads that record each `sinceDay` they are asked. */
const signalsWith = (windowDays: number) => {
  const asked: (string | null)[] = [];
  const orders = {
    countsForCustomers: (_ids: readonly string[], options: { sinceDay: string | null }) => {
      asked.push(options.sinceDay);
      return Promise.resolve({ orders: 3, refused: 2, returned: 0 });
    },
  } as unknown as OrderQueries;
  const settings = {
    read: () =>
      Promise.resolve({
        customer_risk_signal: { windowDays, refusalsToSuggest: 2, returnsToSuggest: 2 },
        timezone: 'Africa/Cairo',
      }),
  } as unknown as SettingsService;
  return { signals: new CustomerRiskSignals(orders, settings), asked };
};

const executor = {} as Executor;

// Spec 0014 AC-13: the window is `windowDays` calendar days back from today in the install time
// zone, today included, so it spans `windowDays + 1` operating days (review m4).
describe('the returner signal window (spec 0014 AC-13)', () => {
  it.each([
    // Winter, Cairo is UTC+2: midnight on 15 January is 22:00 UTC on the 14th.
    ['winter, a moment before Cairo midnight', '2026-01-14T21:59:59.999Z', '2025-07-18'],
    ['winter, Cairo midnight', '2026-01-14T22:00:00.000Z', '2025-07-19'],
    // Summer, Egypt keeps daylight saving (UTC+3): midnight on 15 July is 21:00 UTC on the 14th.
    ['summer, a moment before Cairo midnight', '2026-07-14T20:59:59.999Z', '2026-01-15'],
    ['summer, Cairo midnight', '2026-07-14T21:00:00.000Z', '2026-01-16'],
    // At 21:30 UTC it is already the 15th in summer, still the 14th one hour earlier in winter.
    ['summer, 21:30 UTC', '2026-07-14T21:30:00.000Z', '2026-01-16'],
    ['winter, 21:30 UTC', '2026-01-14T21:30:00.000Z', '2025-07-18'],
  ])('asks the orders from the right operating day: %s', async (_name, now, sinceDay) => {
    const { signals, asked } = signalsWith(180);

    const signal = await signals.signalOf(['c1'], false, executor, new Date(now));

    expect(asked).toEqual([sinceDay]);
    expect(signal).toEqual({ refusals: 2, returns: 0, windowDays: 180, suggestedKind: 'refuser' });
  });

  it('counts today and the windowDays days before it, on the calendar', () => {
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(daysBefore('2026-11-11', 0)).toBe('2026-11-11');
    // Across the summer time change (last Friday of April 2026): whole days, never hours.
    expect(daysBefore('2026-04-25', 1)).toBe('2026-04-24');
  });

  it('asks the order count with no day', async () => {
    const { signals, asked } = signalsWith(180);

    expect(await signals.orderCount(['c1'], executor)).toBe(3);
    expect(asked).toEqual([null]);
  });
});
