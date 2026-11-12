import { describe, expect, it } from 'vitest';
import { LedgerError } from '../inventory/ledger/ledger.errors.js';
import type { LedgerService } from '../inventory/ledger/ledger.service.js';
import { OrderTransactions } from './order-transactions.js';
import { OrderLockTimeout, OrderTransactionNested } from './orders.errors.js';

/** A ledger whose `transaction` runs the callback at once with a stub transaction. */
function fakeLedger(opened: { count: number }, fail?: Error): LedgerService {
  const ledger = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      opened.count += 1;
      if (fail) throw fail;
      return work({ execute: () => Promise.resolve({ rows: [] }) });
    },
  };
  return ledger as unknown as LedgerService;
}

// Spec 0013 AC-22 (review C9): a nested run is refused with a named error, never silently nested.
describe('OrderTransactions nesting guard', () => {
  it('refuses a run inside a run and opens no second transaction', async () => {
    const opened = { count: 0 };
    const transactions = new OrderTransactions(fakeLedger(opened));

    await expect(
      transactions.run(() => transactions.run(() => Promise.resolve('inner'))),
    ).rejects.toBeInstanceOf(OrderTransactionNested);
    expect(opened.count).toBe(1);
  });

  it('allows a second run after the first has ended, and two runs side by side', async () => {
    const opened = { count: 0 };
    const transactions = new OrderTransactions(fakeLedger(opened));

    const first = await transactions.run(() => Promise.resolve('one'));
    const both = await Promise.all([
      transactions.run(() => Promise.resolve('a')),
      transactions.run(() => Promise.resolve('b')),
    ]);

    expect([first, both]).toEqual(['one', ['a', 'b']]);
    expect(opened.count).toBe(3);
  });
});

// Spec 0013 AC-22: run is the ledger's transaction; its lock timeout is the orders' 503 BUSY.
describe('OrderTransactions on the ledger runner', () => {
  it('turns the ledger LockTimeout into OrderLockTimeout', async () => {
    const transactions = new OrderTransactions(
      fakeLedger({ count: 0 }, new LedgerError('LockTimeout', 'busy')),
    );

    await expect(transactions.run(() => Promise.resolve(1))).rejects.toBeInstanceOf(
      OrderLockTimeout,
    );
  });

  it('lets every other ledger error through unchanged', async () => {
    const nested = new LedgerError('NestedStockTransaction', 'nested');
    const transactions = new OrderTransactions(fakeLedger({ count: 0 }, nested));

    await expect(transactions.run(() => Promise.resolve(1))).rejects.toBe(nested);
  });
});
