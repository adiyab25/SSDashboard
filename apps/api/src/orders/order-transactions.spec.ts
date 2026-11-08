import { describe, expect, it } from 'vitest';
import type { Transaction } from '../database/sql.js';
import type { OrderTransaction } from './order-transactions.js';
import type { OrderIntake } from './intake/order-intake.service.js';

// Spec 0013 AC-22: no orders write method accepts a plain transaction. The proof is the compiler:
// the `@ts-expect-error` lines fail `pnpm typecheck` the day a plain Drizzle transaction is accepted.
describe('OrderTransaction', () => {
  it('is not satisfied by a plain transaction', () => {
    const plain = {} as Transaction;
    const intake = {} as OrderIntake;
    const call = (): unknown =>
      // @ts-expect-error a plain transaction is not an OrderTransaction
      intake.createManual(plain, {} as never, {} as never, {} as never);
    const branded = (tx: OrderTransaction): unknown =>
      intake.createManual(tx, {} as never, {} as never, {} as never);

    expect(typeof call).toBe('function');
    expect(typeof branded).toBe('function');
  });
});
