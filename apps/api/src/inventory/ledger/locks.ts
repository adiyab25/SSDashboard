import { createHash } from 'node:crypto';
import { sql } from '@ssdashboard/db';
import { pgArray, pgErrorCode, type Transaction } from '../../database/sql.js';
import { LedgerError } from './ledger.errors.js';

/**
 * How long a ledger transaction waits for any one lock. A stuck transaction on a hot SKU
 * then fails the postings queued behind it quickly instead of holding every pool connection.
 */
export const LOCK_TIMEOUT_MS = 5_000;

/** Caps lock waits for the rest of this transaction only (`SET LOCAL`). */
export async function limitLockWait(tx: Transaction, timeoutMs = LOCK_TIMEOUT_MS): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
}

/** Turns PostgreSQL's lock timeout (55P03) into a ledger error the caller can retry later. */
export function asLockTimeout(error: unknown): unknown {
  if (pgErrorCode(error) !== '55P03') return error;
  return new LedgerError('LockTimeout', 'Stock is busy with another posting. Try again.');
}

/** A stable 64 bit lock key per SKU and location, so lock order is the same for everyone. */
function lockKey(variantId: string, locationId: string): bigint {
  const digest = createHash('sha256').update(`${variantId}:${locationId}`).digest();
  return digest.readBigInt64BE(0);
}

/**
 * Takes a transaction lock per SKU and location, in one global order, before a posting,
 * reservation, or rebuild touches balances or reservations. This keeps the cross bin
 * reserved stock check exact, and postings in opposite orders queue instead of deadlocking.
 */
export async function lockPairs(
  tx: Transaction,
  pairs: readonly [string, string][],
): Promise<void> {
  const keys = [...new Set(pairs.map(([variant, location]) => lockKey(variant, location)))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(k) FROM unnest(${pgArray(keys)}::bigint[]) AS k`,
  );
}
