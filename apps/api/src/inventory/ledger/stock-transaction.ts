import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from '../../database/sql.js';
import { LedgerError } from './ledger.errors.js';

declare const stockTransactionBrand: unique symbol;

/**
 * A database transaction opened by `LedgerService.transaction` (spec 0011 AC-5). The reservation
 * functions take one as their first argument, so a plain Drizzle transaction does not type check
 * and they also refuse one at run time. It is a `Transaction`, so it is accepted wherever one is:
 * `AuditService.record`, `DomainEvents.publish`, `CustomersService.findOrCreate`,
 * `NumberingService.next`, and pg-boss `send` with the `db` option. The `within` callback of a
 * posting receives one too, so it may call `releaseLines` and `reserveLines`.
 */
export type StockTransaction = Transaction & { readonly [stockTransactionBrand]: true };

/** What is known about the ledger transaction running on this async call chain. */
interface RunningUnit {
  /** Set when a nested ledger transaction was attempted; the runner then fails the unit. */
  nested: LedgerError | null;
  /** Set when the unit ends, so a detached continuation that outlives it is not mistaken for it. */
  done: boolean;
}

/**
 * The transaction objects the ledger marked as a stock unit and has not finished with. Module
 * private: only `markStockUnit` adds to it, and a static test (`stock-transaction-wall.spec.ts`)
 * fails any value import of this file from outside `inventory/ledger/`.
 */
const opened = new WeakSet<object>();

/** Set while any ledger transaction's work runs, so a nested one is detected. */
const running = new AsyncLocalStorage<RunningUnit>();

/**
 * Runs `work` as the body of a ledger transaction (every `ledgerTransaction`): flags the call chain.
 * If `work` (or anything it called, an event handler or a `within` callback included) tried to
 * open another ledger transaction, that call threw `NestedStockTransaction`, and this throws it
 * again after `work` ends, even when `work` swallowed the first throw, so the outer transaction
 * always rolls back. Never commits.
 */
export async function runLedgerUnit<T>(work: () => Promise<T>): Promise<T> {
  const unit: RunningUnit = { nested: null, done: false };
  try {
    const result = await running.run(unit, work);
    if (unit.nested) throw unit.nested;
    return result;
  } finally {
    unit.done = true;
  }
}

/**
 * Called before any ledger transaction opens: inside a running one it throws
 * `NestedStockTransaction` (and marks the outer unit failed), because a second transaction is a
 * second connection that would not see, wait for, or roll back with the first.
 */
export function refuseNesting(): void {
  const unit = running.getStore();
  if (!unit || unit.done) return;
  unit.nested = new LedgerError(
    'NestedStockTransaction',
    'A ledger transaction cannot open inside a running one; pass the open transaction down.',
  );
  throw unit.nested;
}

/**
 * Marks `tx` as a stock unit while `work` runs, so the reservation functions accept it, and
 * unmarks it afterwards. Only the ledger calls this, for `LedgerService.transaction` and for the
 * `within` callback of a posting.
 */
export async function markStockUnit<T>(
  tx: Transaction,
  work: (tx: StockTransaction) => Promise<T>,
): Promise<T> {
  const already = opened.has(tx);
  opened.add(tx);
  try {
    return await work(tx as StockTransaction);
  } finally {
    if (!already) opened.delete(tx);
  }
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
