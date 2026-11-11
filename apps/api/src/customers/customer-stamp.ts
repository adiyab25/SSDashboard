import { sql, type SQL } from '@ssdashboard/db';
import { pgArray } from '../database/sql.js';

/**
 * The `updated_at` a customer write stamps on the rows it changes, as one SQL scalar: the later
 * of the clock read now (`clock_timestamp()`, not the transaction's start) and one microsecond
 * past the greatest `updated_at` over `ids`, the whole id set of the customer before the write.
 *
 * Why: every writer of the customer's stamp (merge, undo, flag set and clear, the import flag)
 * reads it after waiting for the `customer` locks, so a write that committed while it waited can
 * never be newer than its own; `now()` is the transaction's start and could be older (review m1).
 * The `+ 1 microsecond` keeps the stamp moving forward even when the clock steps back.
 *
 * Use it inside the `SET` of one `UPDATE` (an uncorrelated scalar subquery, so it is read once per
 * statement), or select it once when several statements must share one stamp. Call it only under `lockCustomers` over `ids`; it must never be used as a business
 * time (`risk_flag_set_at`, `decided_at` stay `now()`).
 */
export const nextStampOf = (ids: readonly string[]): SQL =>
  sql`(SELECT greatest(clock_timestamp(), max(updated_at) + interval '1 microsecond')
       FROM customers WHERE id = ANY(${pgArray(ids)}::uuid[]))`;
