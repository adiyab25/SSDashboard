import { Inject, Injectable } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray, type Executor, type Transaction } from '../database/sql.js';

/**
 * A SKU row as a stock posting needs it after a lock (spec 0011 AC-18): its id, kind, tracking,
 * and whether it is archived. It carries no code, name, or price, and is never written back.
 */
export interface LockedVariant extends Record<string, unknown> {
  id: string;
  kind: string;
  tracking: string;
  archived: boolean;
}

/**
 * The row locks and reads the stock ledger takes on SKU rows (spec 0011 AC-18), so inventory never
 * names `product_variants`. Kept apart from `CatalogService` so the product and SKU screens and
 * the ledger's locking change independently. It never changes a row, never opens a transaction of
 * its own, and never imports anything from inventory.
 */
@Injectable()
export class CatalogLocks {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Locks SKU rows `FOR SHARE` in id order inside the caller's transaction and answers what a
   * stock posting checks: kind, tracking, and whether archived. An archive or code change, which
   * takes `lockForUpdate`, waits for every holder, and the reverse. A SKU that does not exist is
   * simply absent from the answer. Takes a `Transaction`, never the pool: outside a transaction the
   * lock would end with the statement. It must never lock variant rows in any order but ascending
   * id (duplicates dropped), and must never lock a style or product row after a variant row: the
   * catalog's own writers lock a handle, then the style, then variants by ascending id, and the
   * ledger takes these locks before its pair locks and reservation rows, so one order holds
   * everywhere and no two paths deadlock.
   */
  async lockForShare(
    tx: Transaction,
    variantIds: readonly string[],
  ): Promise<Map<string, LockedVariant>> {
    const { rows } = await tx.execute<LockedVariant>(sql`
      SELECT id, kind, tracking, archived_at IS NOT NULL AS archived
      FROM product_variants WHERE id = ANY(${pgArray([...new Set(variantIds)])}::uuid[])
      ORDER BY id
      FOR SHARE`);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Locks SKU rows `FOR UPDATE` in id order inside the caller's transaction, for an archive,
   * unarchive, or code change that must wait for every posting in flight. Same answer as
   * `lockForShare`; a SKU that does not exist is absent. Takes a `Transaction`, never the pool.
   * Only inventory's archive and code change paths call it: it can stall every posting on the rows.
   * It must never lock variant rows in any order but ascending id (duplicates dropped), and must
   * never lock a style or product row after a variant row, for the same lock order as
   * `lockForShare`.
   */
  async lockForUpdate(
    tx: Transaction,
    variantIds: readonly string[],
  ): Promise<Map<string, LockedVariant>> {
    const { rows } = await tx.execute<LockedVariant>(sql`
      SELECT id, kind, tracking, archived_at IS NOT NULL AS archived
      FROM product_variants WHERE id = ANY(${pgArray([...new Set(variantIds)])}::uuid[])
      ORDER BY id
      FOR UPDATE`);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * The ids of every serial tracked SKU, read only, for the reconciliation's serial check. Reads
   * through `executor`, so a snapshot transaction sees one consistent answer; takes no lock.
   */
  async serialTrackedVariantIds(executor: Executor = this.connection.db): Promise<string[]> {
    const { rows } = await executor.execute<{ id: string }>(
      sql`SELECT id FROM product_variants WHERE tracking = 'serial'`,
    );
    return rows.map((row) => row.id);
  }
}
