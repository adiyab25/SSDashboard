import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import { OrderTransactions } from './order-transactions.js';
import { OrderTransactionNested } from './orders.errors.js';

/** A connection whose transaction runs the callback at once with a stub that accepts `execute`. */
function fakeConnection(opened: { count: number }): DatabaseConnection {
  const tx = { execute: () => Promise.resolve({ rows: [] }) };
  const db = {
    transaction: (work: (tx: unknown) => Promise<unknown>) => {
      opened.count += 1;
      return work(tx);
    },
  };
  return { db } as unknown as DatabaseConnection;
}

// Spec 0013 AC-22 (review C9): a nested run is refused with a named error, never silently nested.
describe('OrderTransactions nesting guard', () => {
  it('refuses a run inside a run and opens no second transaction', async () => {
    const opened = { count: 0 };
    const transactions = new OrderTransactions(fakeConnection(opened));

    await expect(
      transactions.run(() => transactions.run(() => Promise.resolve('inner'))),
    ).rejects.toBeInstanceOf(OrderTransactionNested);
    expect(opened.count).toBe(1);
  });

  it('allows a second run after the first has ended, and two runs side by side', async () => {
    const opened = { count: 0 };
    const transactions = new OrderTransactions(fakeConnection(opened));

    const first = await transactions.run(() => Promise.resolve('one'));
    const both = await Promise.all([
      transactions.run(() => Promise.resolve('a')),
      transactions.run(() => Promise.resolve('b')),
    ]);

    expect([first, both]).toEqual(['one', ['a', 'b']]);
    expect(opened.count).toBe(3);
  });
});
