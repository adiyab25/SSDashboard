import type { Database } from '@ssdashboard/db';
import { isRetryable, type Transaction } from '../database/sql.js';

/**
 * Runs one catalog write transaction: READ COMMITTED (the search triggers' rule, spec 0012
 * milestone 1, so it never depends on the server default), and the whole `work` run again once
 * on a deadlock or serialization failure (40P01, 40001), as `ledgerTransaction` does for the
 * stock ledger. Inventory's SKU archive and code change take the variant row before the style
 * row while the style writers take the style first, so PostgreSQL can abort one side of a
 * crossing pair; the rerun turns that into a short wait instead of a 500.
 *
 * Lives in catalog because catalog never imports inventory (the module wall); it reuses the one
 * shared `isRetryable` of `database/sql.ts`. `work` may run twice, so it must read its inputs
 * again inside and keep no state outside between runs. It never retries any other error and
 * never retries more than once.
 */
export async function catalogTransaction<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(work, { isolationLevel: 'read committed' });
    } catch (error) {
      if (attempt === 0 && isRetryable(error)) continue;
      throw error;
    }
  }
}
