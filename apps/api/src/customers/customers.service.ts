import { Inject, Injectable } from '@nestjs/common';
import type { CustomerBrief, NormalizedPhone } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray, type Executor, type Transaction } from '../database/sql.js';
import { briefRows } from './customer-briefs.js';
import { CUSTOMER_LOCK } from './customer-locks.js';
import {
  findOrCreate,
  type FindOrCreateInput,
  type FindOrCreateResult,
} from './find-or-create/find-or-create.js';

/** A customer as other modules may show it (spec 0014 `briefs`): the asked id and the canonical customer behind it. */
export interface CustomerBriefOf extends CustomerBrief {
  /** The id the caller asked about; `id` is the canonical customer it resolves to. */
  askedId: string;
}

/**
 * The only door to the customer tables (spec 0014): every order, Shopify customer, import, and
 * confirmation links, finds, or flags a customer through here, and no other module reads or writes
 * `customers`, `customer_phones`, `customer_external_ids`, `customer_merges`, or
 * `customer_merge_suggestions`.
 *
 * Methods that write take the caller's `tx` and never open their own transaction. Reads resolve a
 * merged customer to its survivor through one hop of `merged_into_id`. It must never move a phone
 * or a channel id between customers, never rewrite another module's customer id, and never put a
 * phone, name, or note into an error or a log line (Law 151).
 */
@Injectable()
export class CustomersService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Links a phone and an optional outside id to its canonical customer, or creates her (AC-1,
   * AC-2): see {@link findOrCreate} for the six rules. Pass the caller's transaction.
   */
  findOrCreate(tx: Transaction, input: FindOrCreateInput): Promise<FindOrCreateResult> {
    return findOrCreate(tx, input);
  }

  /** The canonical customer holding this phone, or null when none does. Writes nothing. */
  async findByPhone(phone: NormalizedPhone, tx?: Executor): Promise<string | null> {
    const { rows } = await (tx ?? this.connection.db).execute<{ id: string }>(sql`
      SELECT coalesce(c.merged_into_id, c.id) AS id
      FROM customer_phones p JOIN customers c ON c.id = p.customer_id
      WHERE p.phone_e164 = ${phone.e164}`);
    return rows[0]?.id ?? null;
  }

  /** The survivor of a customer id (the id itself when it is canonical), or null for an unknown id. */
  async canonicalOf(id: string, tx?: Executor): Promise<string | null> {
    const { rows } = await (tx ?? this.connection.db).execute<{ id: string }>(sql`
      SELECT coalesce(merged_into_id, id) AS id FROM customers WHERE id = ${id}::uuid`);
    return rows[0]?.id ?? null;
  }

  /**
   * The canonical customer of `canonicalId` plus every id merged into her, ordered by id; an
   * empty list for an unknown id. Given a merged id it answers the set of its survivor.
   */
  async idsOf(canonicalId: string, tx?: Executor): Promise<string[]> {
    const { rows } = await (tx ?? this.connection.db).execute<{ id: string }>(sql`
      SELECT c.id FROM customers c
      WHERE c.id = (SELECT coalesce(merged_into_id, id) FROM customers WHERE id = ${canonicalId}::uuid)
         OR c.merged_into_id = (SELECT coalesce(merged_into_id, id) FROM customers WHERE id = ${canonicalId}::uuid)
      ORDER BY c.id`);
    return rows.map((row) => row.id);
  }

  /**
   * For each asked id, the canonical customer behind it: id, name, primary phone, phone count, and
   * flag kind and source. Unknown ids are left out. The caller checks its own permission before it
   * shows a name or phone.
   */
  async briefs(ids: readonly string[], tx?: Executor): Promise<CustomerBriefOf[]> {
    if (ids.length === 0) return [];
    const executor = tx ?? this.connection.db;
    const { rows } = await executor.execute<{ asked_id: string; canonical_id: string }>(sql`
      SELECT a.asked_id, coalesce(c.merged_into_id, c.id) AS canonical_id
      FROM unnest(${pgArray(ids)}::uuid[]) AS a(asked_id)
      JOIN customers c ON c.id = a.asked_id`);
    const briefs = new Map(
      (await briefRows(executor, [...new Set(rows.map((row) => row.canonical_id))])).map(
        (brief) => [brief.id, brief],
      ),
    );
    return rows.flatMap((row) => {
      const brief = briefs.get(row.canonical_id);
      return brief ? [{ ...brief, askedId: row.asked_id }] : [];
    });
  }

  /**
   * Takes the `customer` advisory locks over the whole id sets of these canonical customers, the
   * same locks a merge takes (spec 0002), so a credit write never runs against a half merged
   * customer. Locks go in the order of their lock key (the hash, then the id), which is the one
   * order that cannot deadlock even when two ids share a hash. Waits for the lock; the caller's
   * transaction holds it until it ends.
   *
   * The id sets are read before the locks are taken, so a merge may move them while this call
   * waits. After it returns, the caller must read `idsOf` again and refuse or retry when a set
   * changed (a merge answers 409 `CUSTOMER_CHANGED`).
   */
  async lockCustomers(tx: Transaction, canonicalIds: readonly string[]): Promise<void> {
    if (canonicalIds.length === 0) return;
    const { rows } = await tx.execute<{ id: string; key: number }>(sql`
      SELECT DISTINCT c.id::text AS id, hashtext(c.id::text) AS key
      FROM customers c
      WHERE c.id = ANY(${pgArray(canonicalIds)}::uuid[])
         OR c.merged_into_id = ANY(${pgArray(canonicalIds)}::uuid[])
      ORDER BY key, id`);
    const keys = [...new Set(rows.map((row) => row.key))];
    for (const key of keys) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CUSTOMER_LOCK}::int, ${key}::int)`);
    }
  }
}
