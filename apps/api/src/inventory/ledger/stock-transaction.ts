import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from '../../database/sql.js';
import { LedgerError } from './ledger.errors.js';

declare const stockTransactionBrand: unique symbol;

/**
 * A database transaction opened by `LedgerService.transaction` (spec 0011 AC-5). The reservation
 * functions take one as their first argument, so a plain Drizzle transaction does not type check
 * and they also refuse one at run time. It is a `Transaction`, so it is accepted wherever one is:
 * `AuditService.record`, `DomainEvents.publish`, `CustomersService.findOrCreate`,
 * `NumberingService.next`, and pg-boss `send` with the `db` option.
 */
export type StockTransaction = Transaction & { readonly [stockTransactionBrand]: true };

/** What is known about the stock transaction running on this async call chain. */
interface RunningUnit {
  /** Set when a nested `LedgerService.transaction` was attempted; the runner then fails the unit. */
  nested: LedgerError | null;
}

/** The transaction objects the runner opened and has not finished with. Module private. */
const opened = new WeakSet<object>();

/** Set while a stock transaction's `work` runs, so a nested runner call is detected. */
const running = new AsyncLocalStorage<RunningUnit>();

/**
 * Runs `work` as the body of a stock transaction: marks `tx` as opened by the runner and flags the
 * call chain. If `work` (or anything it called) tried to open another ledger transaction, that
 * call threw `NestedStockTransaction` and this throws it again after `work` ends, even when
 * `work` swallowed the first throw, so the outer transaction always rolls back. Never commits.
 */
export async function runStockUnit<T>(
  tx: Transaction,
  work: (tx: StockTransaction) => Promise<T>,
): Promise<T> {
  const unit: RunningUnit = { nested: null };
  opened.add(tx);
  try {
    const result = await running.run(unit, () => work(tx as StockTransaction));
    if (unit.nested) throw unit.nested;
    return result;
  } finally {
    opened.delete(tx);
  }
}

/**
 * Called before any ledger transaction opens: inside a running stock transaction it throws
 * `NestedStockTransaction` (and marks the outer unit failed), because a second transaction is a
 * second connection that would not see, wait for, or roll back with the first.
 */
export function refuseNesting(): void {
  const unit = running.getStore();
  if (!unit) return;
  unit.nested = new LedgerError(
    'NestedStockTransaction',
    'A ledger transaction cannot open inside a running stock transaction; pass the open one down.',
  );
  throw unit.nested;
}

/** Throws `InvalidInput` unless `tx` was opened by `LedgerService.transaction` and is still running. */
export function assertStockTransaction(tx: Transaction): asserts tx is StockTransaction {
  if (!opened.has(tx)) {
    throw new LedgerError(
      'InvalidInput',
      'Reservations are written inside LedgerService.transaction; this transaction was not opened by it.',
    );
  }
}
