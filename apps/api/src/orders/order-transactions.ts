import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { isRetryable, pgErrorCode, type Transaction } from '../database/sql.js';
import { OrderLockTimeout, OrderTransactionNested } from './orders.errors.js';

declare const orderTransactionBrand: unique symbol;

/**
 * A database transaction opened by {@link OrderTransactions.run}. Every orders write method takes
 * one as its first argument, so a caller cannot reach a write with a plain Drizzle transaction:
 * the type checker refuses it (spec 0013 AC-22).
 */
export type OrderTransaction = Transaction & { readonly [orderTransactionBrand]: true };

/** How long one lock wait inside an order transaction may last before the unit fails with `LockTimeout`. */
export const ORDER_LOCK_TIMEOUT_MS = 5_000;

/** Set while an order unit of work runs on this async call chain: how a nested `run` is told. */
const openUnit = new AsyncLocalStorage<true>();

/**
 * The one way to open an order unit of work (spec 0013 AC-22, the contract spec 0011's
 * `LedgerService.transaction` will fill): READ COMMITTED, each lock wait capped at
 * {@link ORDER_LOCK_TIMEOUT_MS}, a deadlock or serialization failure reruns the whole `work` once,
 * and a lock wait past its cap throws {@link OrderLockTimeout} (503 `BUSY` at the edge).
 *
 * Because `work` can run twice, it must be rerunnable: read its inputs again inside, keep no
 * state outside it between runs, and call no provider or other connection inside it. It writes
 * every row of its unit inside `work` so they commit or roll back together. This service never
 * commits on its own and never nests: calling `run` inside `work` throws
 * {@link OrderTransactionNested}, because a second transaction would not see, wait for, or roll
 * back with the first (pass the open transaction down instead).
 */
@Injectable()
export class OrderTransactions {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Runs `work` in one transaction and returns what it returns; see the class for the rules. */
  async run<T>(work: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    if (openUnit.getStore()) throw new OrderTransactionNested();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.connection.db.transaction(
          async (tx) => {
            await tx.execute(
              sql`SELECT set_config('lock_timeout', ${`${ORDER_LOCK_TIMEOUT_MS}ms`}, true)`,
            );
            return openUnit.run(true, () => work(tx as OrderTransaction));
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        if (attempt === 0 && isRetryable(error)) continue;
        if (pgErrorCode(error) === '55P03') throw new OrderLockTimeout();
        throw error;
      }
    }
  }
}
