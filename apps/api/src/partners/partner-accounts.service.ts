import { Inject, Injectable } from '@nestjs/common';
import type { PartnerAccount } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A role flag a party can hold, named by its `parties` column (the roles a location owner needs). */
export type PartyRoleColumn = 'is_consignment_partner' | 'is_wholesale_customer';

/**
 * The partner accounts other modules may name (spec 0008, AC-9 and AC-15): the `parties` rows that
 * are consignment partners and are not archived. Identity binds a partner user to one of them and
 * asks here whether an id is one, so identity never reads `parties` itself (spec 0002, A5).
 *
 * It only reads. It must never write `parties`, never answer a party's contact details, and never
 * call it a partner account when it is not a consignment partner. Feature 41 builds the rest of
 * the partners module on top of it.
 */
@Injectable()
export class PartnerAccounts {
  private readonly db: Database;

  /** Takes the app database connection the parties are read from. */
  constructor(@Inject(DATABASE) connection: DatabaseConnection) {
    this.db = connection.db;
  }

  /**
   * Whether `id` is a consignment partner that is not archived, read through `executor` (pass the
   * caller's transaction, so the answer and the write that follows see the same snapshot). A
   * malformed id is simply not one. The row is read `FOR SHARE`, so the lock lasts until the
   * caller's transaction ends: archiving the party (an update of that row) waits for the bind that
   * is being written, and a bind that starts after the archive sees it. Pass the transaction that
   * writes the bind; on a plain connection the lock ends with the single statement.
   */
  async isConsignmentPartner(id: string, executor: Pick<Executor, 'execute'>): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const result = await executor.execute(
      sql`SELECT 1 FROM parties
           WHERE id = ${id}::uuid AND is_consignment_partner AND archived_at IS NULL
           FOR SHARE`,
    );
    return result.rows.length > 0;
  }

  /**
   * Whether the party `id` exists, is not archived and holds `role`, read through `executor` with
   * the row locked `FOR SHARE` until that transaction ends (so the party cannot be archived while
   * a location that names it is being inserted). A malformed id holds no role. It answers yes or
   * no only: never a party's details.
   */
  async holdsRole(
    id: string,
    role: PartyRoleColumn,
    executor: Pick<Executor, 'execute'>,
  ): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const result = await executor.execute<{ ok: boolean }>(
      sql`SELECT ${sql.identifier(role)} AS ok FROM parties
           WHERE id = ${id}::uuid AND archived_at IS NULL
           FOR SHARE`,
    );
    return result.rows[0]?.ok === true;
  }

  /** Every consignment partner that is not archived, as `{ id, code, name }`, ordered by code. */
  async list(): Promise<PartnerAccount[]> {
    const result = await this.db.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM parties
           WHERE is_consignment_partner AND archived_at IS NULL
           ORDER BY code COLLATE "C", id`,
    );
    return result.rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
  }
}
