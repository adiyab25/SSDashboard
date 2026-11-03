import { createHash } from 'node:crypto';
import { sql, type Database } from '@ssdashboard/db';
import { isRetryable, pgArray, pgErrorCode, type Transaction } from '../../database/sql.js';
import { LedgerError } from './ledger.errors.js';

/**
 * How long a ledger transaction waits for any one lock. A stuck transaction on a hot SKU
 * then fails the postings queued behind it quickly instead of holding every pool connection.
 */
export const LOCK_TIMEOUT_MS = 5_000;

/** Turns PostgreSQL's lock timeout (55P03) into a ledger error the caller can retry later. */
function asLockTimeout(error: unknown): unknown {
  if (pgErrorCode(error) !== '55P03') return error;
  return new LedgerError('LockTimeout', 'Stock is busy with another posting. Try again.');
}

/**
 * Runs one ledger write transaction (spec 0002, Key invariants): READ COMMITTED, lock waits
 * capped at `LOCK_TIMEOUT_MS` each, the whole transaction retried once on a deadlock or
 * serialization failure, and a lock timeout raised as `LockTimeout`. Every writer of
 * balances, reservations, or discrepancies goes through here.
 */
export async function ledgerTransaction<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true)`);
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (attempt === 0 && isRetryable(error)) continue;
      throw asLockTimeout(error);
    }
  }
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
