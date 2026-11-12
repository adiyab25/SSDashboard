import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Transaction } from '../database/sql.js';
import { orderTransactionFromLedger } from './order-transactions.js';

const API_SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** A cast to `OrderTransaction`, direct or through `unknown`. */
const CASTS_TO_ORDER_TRANSACTION = /\bas\s+(?:unknown\s+as\s+)?OrderTransaction\b/;

// Review N3 (docs/reviews/review-stock-reservations.md): one sanctioned adapter turns a
// transaction the ledger handed over into an OrderTransaction; nothing else casts.
describe('orderTransactionFromLedger', () => {
  it('hands back the very transaction the ledger gave, adding nothing', () => {
    const tx = { execute: () => Promise.resolve({ rows: [] }) } as unknown as Transaction;

    expect(orderTransactionFromLedger(tx)).toBe(tx);
  });

  it('is the only cast to OrderTransaction in the api source', () => {
    const casting = sourceFiles(API_SRC)
      .filter((path) => CASTS_TO_ORDER_TRANSACTION.test(readFileSync(path, 'utf8')))
      .map((path) => relative(API_SRC, path).split(sep).join('/'));

    expect(casting).toEqual(['orders/order-transactions.ts']);
  });

  it('would catch a planted cast', () => {
    expect(CASTS_TO_ORDER_TRANSACTION.test('work(tx as OrderTransaction)')).toBe(true);
    expect(CASTS_TO_ORDER_TRANSACTION.test('x as unknown as OrderTransaction')).toBe(true);
    expect(CASTS_TO_ORDER_TRANSACTION.test('x as OrderTransactions')).toBe(false);
  });
});
