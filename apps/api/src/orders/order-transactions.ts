import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from '../database/sql.js';
import { LedgerError } from '../inventory/ledger/ledger.errors.js';
import { LedgerService } from '../inventory/ledger/ledger.service.js';
import type { StockTransaction } from '../inventory/ledger/stock-transaction.js';
import { OrderLockTimeout, OrderTransactionNested } from './orders.errors.js';

declare const orderTransactionBrand: unique symbol;

/**
 * A stock transaction opened by {@link OrderTransactions.run} (spec 0013 AC-22). Every orders write
 * method takes one as its first argument, so a caller cannot reach a write with a plain Drizzle
 * transaction: the type checker refuses it. Because `run` is spec 0011's
 * `LedgerService.transaction`, it is also a `StockTransaction`, so the reservation calls inside an
 * order write are legal.
 */
export type OrderTransaction = StockTransaction & { readonly [orderTransactionBrand]: true };

/**
 * How long one lock wait inside an order transaction may last before the unit fails with
 * `LockTimeout`: the ledger's own cap (spec 0011), named here for the orders README and tests.
 */
export const ORDER_LOCK_TIMEOUT_MS = 5_000;

/** Set while an order unit of work runs on this async call chain: how a nested `run` is told. */
const openUnit = new AsyncLocalStorage<true>();

/**
 * The one sanctioned adapter (review N3 of `docs/reviews/review-stock-reservations.md`): turns a
 * transaction the stock ledger itself handed to the orders module into an `OrderTransaction`, so
 * the order writer can be called with it. Only for the ledger's own units: an inventory event
 * handler (`ReservationFilled`, `ReservationShortened`) running in the publisher's transaction,
 * and, from milestone 5, a posting's `within` callback. It returns the same object and checks
 * nothing; nothing else in the api may cast to `OrderTransaction` (`order-transactions.spec.ts`
 * fails otherwise).
 *
 * It must never be used to open, commit, or nest a transaction, never on a transaction the ledger
 * did not hand over, and never to take the order row lock from an event handler (the handler would
 * wait on an order while holding pair locks). A reservation call with the result is refused by the
 * ledger at run time unless the ledger marked that transaction a stock unit (a `within` callback).
 */
export function orderTransactionFromLedger(tx: StockTransaction | Transaction): OrderTransaction {
  return tx as OrderTransaction;
}

/**
 * The one way to open an order unit of work (spec 0013 AC-22): spec 0011's
 * `LedgerService.transaction`, so READ COMMITTED, each lock wait capped at
 * {@link ORDER_LOCK_TIMEOUT_MS}, a deadlock or serialization failure reruns the whole `work` once,
 * and a lock wait past its cap throws {@link OrderLockTimeout} (503 `BUSY` at the edge).
 *
 * Because `work` can run twice, it must be rerunnable: read its inputs again inside, keep no
 * state outside it between runs, and call no provider or other connection inside it. It writes
 * every row of its unit inside `work` so they commit or roll back together. This service never
 * commits on its own and never nests: calling `run` inside `work` throws
 * {@link OrderTransactionNested}, because a second transaction would not see, wait for, or roll
 * back with the first (pass the open transaction down instead); the ledger refuses any other
 * ledger transaction opened inside it the same way.
 */
@Injectable()
export class OrderTransactions {
  /** Takes the stock ledger, whose transaction runner this is. */
  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  /** Runs `work` in one stock transaction and returns what it returns; see the class for the rules. */
  async run<T>(work: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    if (openUnit.getStore()) throw new OrderTransactionNested();
    try {
      return await this.ledger.transaction((tx) =>
        openUnit.run(true, () => work(tx as OrderTransaction)),
      );
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'LockTimeout') {
        throw new OrderLockTimeout();
      }
      throw error;
    }
  }
}
