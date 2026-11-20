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
const CASTS_TO_ORDER_TRANSACTION = /\bas\s+(?:unknown\s+as\s+)?OrderTransaction\b/g;

/** A mention of the adapter outside its own file: an import, a re-export, or a call. */
const NAMES_THE_ADAPTER = /\borderTransactionFromLedger\b/;

/**
 * The files that may use the adapter (review m4, security L2): the reservation event handlers and
 * the milestone 5 shipment posting file (a posting's and a reversal's `within`).
 */
const ADAPTER_USERS = [
  'orders/shipment/shipment-posting.ts',
  'orders/stock/short-lines.projection.ts',
];

const files = () =>
  sourceFiles(API_SRC).map((path) => ({
    name: relative(API_SRC, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));

// Review N3 (docs/reviews/review-stock-reservations.md): one sanctioned adapter turns a
// transaction the ledger handed over into an OrderTransaction; nothing else casts, and only the
// listed files call it.
describe('orderTransactionFromLedger', () => {
  it('hands back the very transaction the ledger gave, adding nothing', () => {
    const tx = { execute: () => Promise.resolve({ rows: [] }) } as unknown as Transaction;

    expect(orderTransactionFromLedger(tx)).toBe(tx);
  });

  it('casts to OrderTransaction exactly twice in the api source, both in order-transactions.ts', () => {
    const casts = files()
      .map((file) => [file.name, (file.text.match(CASTS_TO_ORDER_TRANSACTION) ?? []).length])
      .filter(([, count]) => count !== 0);

    // `run` brands the ledger's transaction; the adapter brands one the ledger handed over.
    expect(casts).toEqual([['orders/order-transactions.ts', 2]]);
  });

  it('is used only by the files on the allow list', () => {
    const users = files()
      .filter((file) => file.name !== 'orders/order-transactions.ts')
      .filter((file) => NAMES_THE_ADAPTER.test(file.text))
      .map((file) => file.name);

    expect(users).toEqual(ADAPTER_USERS);
  });

  it('would catch a planted cast', () => {
    expect('work(tx as OrderTransaction)'.match(CASTS_TO_ORDER_TRANSACTION)).toHaveLength(1);
    expect('x as unknown as OrderTransaction'.match(CASTS_TO_ORDER_TRANSACTION)).toHaveLength(1);
    expect('x as OrderTransactions'.match(CASTS_TO_ORDER_TRANSACTION)).toBeNull();
  });
});
