import type { CustomerRiskFlag } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { pgArray, type Executor, type Transaction } from '../../database/sql.js';
import { CustomersError } from '../customers.errors.js';

/** What `CustomersService.setFlagFromImport` did (spec 0014 AC-12). */
export type ImportFlagOutcome = 'set' | 'kept_manual';

/** The id set reads and the lock an import flag needs, from `CustomersService`. */
export interface CustomerSets {
  /** The survivor of an id, or null for an unknown id. */
  canonicalOf(id: string, tx?: Executor): Promise<string | null>;
  /** The canonical customer plus every id merged into her, ordered by id. */
  idsOf(canonicalId: string, tx?: Executor): Promise<string[]>;
  /** The `customer` advisory locks over whole id sets. */
  lockCustomers(tx: Transaction, canonicalIds: readonly string[]): Promise<void>;
}

/**
 * Sets a `blacklist_import` flag of `kind` on the canonical customer behind `customerId` (spec
 * 0014 AC-12), in the caller's transaction, under the `customer` locks over her id set. It never
 * replaces a person's flag: when any id of the canonical customer holds a `manual` flag it writes
 * nothing and answers `kept_manual`. Otherwise it writes the flag on the canonical row with no
 * person and no note, set now, replacing an older import or rule flag there, and answers `set`.
 *
 * It writes no audit entry (feature 15 writes its own import entry, carrying its run id). Throws
 * `CUSTOMER_NOT_FOUND` for an unknown id and `CUSTOMER_CHANGED` when a merge moved the id set while
 * it waited for the locks (the import retries the row).
 */
export async function setFlagFromImport(
  tx: Transaction,
  sets: CustomerSets,
  customerId: string,
  kind: CustomerRiskFlag,
): Promise<ImportFlagOutcome> {
  const canonicalId = await sets.canonicalOf(customerId, tx);
  if (canonicalId === null) {
    throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
  }
  const ids = await sets.idsOf(canonicalId, tx);
  await sets.lockCustomers(tx, [canonicalId]);
  const idsNow = await sets.idsOf(canonicalId, tx);
  if (
    (await sets.canonicalOf(customerId, tx)) !== canonicalId ||
    idsNow.length !== ids.length ||
    idsNow.some((id, i) => id !== ids[i])
  ) {
    throw new CustomersError('CUSTOMER_CHANGED', 'The customer changed, try again');
  }

  const manual = await tx.execute<{ id: string }>(sql`
    SELECT id FROM customers
    WHERE id = ANY(${pgArray(ids)}::uuid[]) AND risk_flag_source = 'manual'
    LIMIT 1`);
  if (manual.rows.length > 0) return 'kept_manual';

  await tx.execute(sql`
    UPDATE customers
    SET risk_flag = ${kind}, risk_flag_source = 'blacklist_import', risk_flag_note = NULL,
        risk_flag_set_at = now(), risk_flag_set_by = NULL, updated_at = now()
    WHERE id = ${canonicalId}::uuid`);
  return 'set';
}
