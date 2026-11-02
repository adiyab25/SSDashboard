import { createHash } from 'node:crypto';
import { sql } from '@ssdashboard/db';
import { pgArray, type Transaction } from '../../database/sql.js';

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
