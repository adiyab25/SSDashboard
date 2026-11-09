import { Inject, Injectable } from '@nestjs/common';
import {
  personActor,
  type CustomerMergeReasonCode,
  type CustomerMergeResponse,
  type CustomerUndoMergeResponse,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService, type AuditEntryInput } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Transaction } from '../../database/sql.js';
import { briefRows } from '../customer-briefs.js';
import { CustomersError, MergeAlreadyUndone, MergeNotLatest } from '../customers.errors.js';
import { CustomersService } from '../customers.service.js';
import { nextStampOf } from '../customer-stamp.js';

/** The handler code of the audit screen's undo of `customer.merged` (spec 0014, Audit actions). */
export const MERGE_UNDO_HANDLER = 'customers.merge_undo';

/** The staff person who merges or undoes: a merge row names a person (`customer_merges.actor_id`). */
export interface MergeActor {
  /** The person's user id. */
  userId: string;
  /** The hat they act under, for the audit entry. */
  hat: string;
}

/** What a merge needs (spec 0014 AC-6). */
export interface MergeInput {
  /** The customer that stays: must be canonical (lower case uuid, as Postgres answers ids). */
  survivorId: string;
  /** The customer that is pointed at the survivor: must be canonical and not the survivor. */
  mergedId: string;
  /** Why, as a listed code; recorded on the merge row and its audit entries, never a note. */
  reasonCode?: CustomerMergeReasonCode;
  /** The open suggestion this merge applies; it must name this pair (lower case uuid). */
  suggestionId?: string;
}

/** What an undo changed: the restored customer, the survivor, and every record it moved back. */
export interface UndoOutcome extends CustomerUndoMergeResponse {
  /** Every customer record whose pointer moved: the restored one first, then its repointed ones. */
  changed: string[];
}

interface MergeRow extends Record<string, unknown> {
  survivor_id: string;
  merged_id: string;
  repointed_ids: string[];
  undone: boolean;
}

/**
 * Whether two id lists are equal element by element. Both must come sorted from
 * `CustomersService.idsOf` (it orders by id), so equal lists mean equal sets.
 */
const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Merges two customers and undoes a merge (spec 0014 AC-6, AC-8), by pointer only: it sets
 * `merged_into_id`, keeps chains one hop, and appends to `customer_merges`; it never rewrites a
 * phone, a channel id, or another module's row. Both run under the `customer` advisory locks of
 * `CustomersService.lockCustomers` over the whole id sets, then read the sets again.
 *
 * Not exported from the module: other modules never merge. The `*In` methods take the caller's
 * transaction (the audit undo handler runs inside the audit module's); `merge` and `undo` open
 * their own for the routes. Errors are typed (`CustomersError`, `MergeNotLatest`,
 * `MergeAlreadyUndone`) and never carry a name or phone.
 */
@Injectable()
export class CustomerMerges {
  /** Takes the database, the customers service (locks and id sets), and the audit writer. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Merges in one new transaction (the route); see {@link mergeIn}. */
  async merge(input: MergeInput, actor: MergeActor): Promise<CustomerMergeResponse> {
    const correlationId = this.audit.newCorrelationId();
    return this.connection.db.transaction((tx) => this.mergeIn(tx, input, actor, correlationId), {
      isolationLevel: 'read committed',
    });
  }

  /**
   * Merges `mergedId` into `survivorId` in `tx` (AC-6): refuses `SAME_CUSTOMER` when both resolve
   * to one customer, `CUSTOMER_MERGED` when either is no longer canonical, `CUSTOMER_NOT_FOUND`
   * for an unknown id; takes the customer locks over both id sets and refuses `CUSTOMER_CHANGED`
   * when a set moved while it waited; checks the suggestion (`SUGGESTION_NOT_FOUND`,
   * `SUGGESTION_CLOSED`, `SUGGESTION_MISMATCH` when it names another pair). Then points the merged
   * customer and every customer that pointed at it to the survivor, appends the merge row, writes
   * one `customer.merged` per changed record (the merged record's entry carries the undo), marks
   * the suggestion `applied`, and closes as `applied` every other open suggestion whose pair now
   * resolves to one customer.
   */
  async mergeIn(
    tx: Transaction,
    input: MergeInput,
    actor: MergeActor,
    correlationId: string,
  ): Promise<CustomerMergeResponse> {
    const { survivorId, mergedId } = input;
    const survivorCanonical = await this.customers.canonicalOf(survivorId, tx);
    const mergedCanonical = await this.customers.canonicalOf(mergedId, tx);
    if (survivorCanonical === null || mergedCanonical === null) {
      throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
    }
    if (survivorCanonical === mergedCanonical) {
      throw new CustomersError('SAME_CUSTOMER', 'Both ids are already one customer');
    }
    if (survivorCanonical !== survivorId || mergedCanonical !== mergedId) {
      throw new CustomersError('CUSTOMER_MERGED', 'A customer was merged into another one');
    }

    const survivorIds = await this.customers.idsOf(survivorId, tx);
    const mergedIds = await this.customers.idsOf(mergedId, tx);
    await this.customers.lockCustomers(tx, [survivorId, mergedId]);
    // Read again under the locks: both still canonical (a merge that committed between the reads
    // above could leave the two sets equal before and after), and neither set moved.
    if (
      (await this.customers.canonicalOf(survivorId, tx)) !== survivorId ||
      (await this.customers.canonicalOf(mergedId, tx)) !== mergedId ||
      !sameIds(await this.customers.idsOf(survivorId, tx), survivorIds) ||
      !sameIds(await this.customers.idsOf(mergedId, tx), mergedIds)
    ) {
      throw new CustomersError('CUSTOMER_CHANGED', 'The customers changed, open them again');
    }

    if (input.suggestionId !== undefined) {
      await this.checkSuggestion(tx, input.suggestionId, survivorId, mergedId);
    }

    const repointed = mergedIds.filter((id) => id !== mergedId);
    // Stamped after the locks over both sets, so the survivor's stamp moves past any write that
    // committed while this merge waited (review m1 of milestone 3).
    await tx.execute(sql`
      UPDATE customers
      SET merged_into_id = ${survivorId}::uuid, updated_at = ${nextStampOf([...survivorIds, ...mergedIds])}
      WHERE id = ${mergedId}::uuid OR merged_into_id = ${mergedId}::uuid`);
    const mergeId = (
      await tx.execute<{ id: string }>(sql`
        INSERT INTO customer_merges (action, survivor_id, merged_id, repointed_ids, reason, actor_id)
        VALUES ('merge', ${survivorId}::uuid, ${mergedId}::uuid, ${pgArray(repointed)}::uuid[],
                ${input.reasonCode ?? null}, ${actor.userId}::uuid)
        RETURNING id`)
    ).rows[0]?.id;
    if (mergeId === undefined) throw new Error('The merge insert returned no row');

    const auditActor = personActor(actor.userId, actor.hat);
    const reason = input.reasonCode === undefined ? {} : { reason: input.reasonCode };
    const entries: AuditEntryInput[] = [
      {
        actor: auditActor,
        action: 'customer.merged',
        record: { type: 'customer', id: mergedId },
        before: { mergedIntoId: null },
        after: { mergedIntoId: survivorId, mergeId, repointedCount: repointed.length },
        ...reason,
        correlationId,
        undo: { action: MERGE_UNDO_HANDLER, args: { mergeId } },
      },
      ...repointed.map((id): AuditEntryInput => ({
        actor: auditActor,
        action: 'customer.merged',
        record: { type: 'customer', id },
        before: { mergedIntoId: mergedId },
        after: { mergedIntoId: survivorId, mergeId },
        ...reason,
        correlationId,
      })),
    ];
    await this.audit.recordMany(tx, entries);

    if (input.suggestionId !== undefined) {
      await tx.execute(sql`
        UPDATE customer_merge_suggestions
        SET status = 'applied', merge_id = ${mergeId}::uuid, decided_by = ${actor.userId}::uuid,
            decided_at = now(), updated_at = now()
        WHERE id = ${input.suggestionId}::uuid`);
    }
    // Every other open suggestion whose two customers now resolve to one is closed by this merge.
    await tx.execute(sql`
      UPDATE customer_merge_suggestions s
      SET status = 'applied', merge_id = ${mergeId}::uuid, decided_by = ${actor.userId}::uuid,
          decided_at = now(), updated_at = now()
      FROM customers lo, customers hi
      WHERE s.status = 'open'
        AND lo.id = s.customer_low_id AND hi.id = s.customer_high_id
        AND coalesce(lo.merged_into_id, lo.id) = coalesce(hi.merged_into_id, hi.id)`);

    const [survivor] = await briefRows(tx, [survivorId]);
    if (survivor === undefined) throw new Error('The survivor brief returned no row');
    return { mergeId, survivor };
  }

  /** Undoes in one new transaction (the route), writing `customer.unmerged`; see {@link undoIn}. */
  async undo(
    mergeId: string,
    reasonCode: string,
    actor: MergeActor,
  ): Promise<CustomerUndoMergeResponse> {
    const correlationId = this.audit.newCorrelationId();
    return this.connection.db.transaction(
      async (tx) => {
        const outcome = await this.undoIn(tx, mergeId, reasonCode, actor);
        const auditActor = personActor(actor.userId, actor.hat);
        await this.audit.recordMany(
          tx,
          outcome.changed.map((id): AuditEntryInput => ({
            actor: auditActor,
            action: 'customer.unmerged',
            record: { type: 'customer', id },
            before: { mergedIntoId: outcome.survivorId },
            after: {
              mergedIntoId: id === outcome.restoredId ? null : outcome.restoredId,
              mergeId,
            },
            reason: reasonCode,
            correlationId,
          })),
        );
        return { restoredId: outcome.restoredId, survivorId: outcome.survivorId };
      },
      { isolationLevel: 'read committed' },
    );
  }

  /**
   * Undoes merge `mergeId` in `tx` (AC-8), writing no audit entry (the caller writes
   * `customer.unmerged`, or the audit module `customer.merged_undone`). Takes the customer locks
   * over the survivor's and the merged customer's sets, then applies the undo rule: refuses
   * `MERGE_NOT_FOUND` for an id that is not a merge, `MergeAlreadyUndone` when an undo row names
   * it, and `MergeNotLatest` unless the survivor is canonical and the merged customer still points
   * at it. Restores exactly the pointers before the merge (the merged customer canonical, its
   * repointed customers back on it), appends the `undo` row, and reopens every suggestion this
   * merge applied whose pair no longer resolves to one customer.
   */
  async undoIn(
    tx: Transaction,
    mergeId: string,
    reasonCode: string,
    actor: MergeActor,
  ): Promise<UndoOutcome> {
    const read = async (): Promise<MergeRow | undefined> =>
      (
        await tx.execute<MergeRow>(sql`
          SELECT m.survivor_id, m.merged_id, m.repointed_ids::text[] AS repointed_ids,
                 EXISTS (SELECT 1 FROM customer_merges u WHERE u.undoes_merge_id = m.id) AS undone
          FROM customer_merges m
          WHERE m.id = ${mergeId}::uuid AND m.action = 'merge'`)
      ).rows[0];
    const before = await read();
    if (before === undefined) throw new CustomersError('MERGE_NOT_FOUND', 'No merge has that id');
    const survivorCanonical = await this.customers.canonicalOf(before.survivor_id, tx);
    await this.customers.lockCustomers(tx, [
      ...new Set([before.survivor_id, before.merged_id, survivorCanonical ?? before.survivor_id]),
    ]);

    // Everything below reads again under the locks.
    const merge = await read();
    if (merge === undefined) throw new CustomersError('MERGE_NOT_FOUND', 'No merge has that id');
    if (merge.undone) throw new MergeAlreadyUndone();
    const { rows } = await tx.execute<{ id: string; merged_into_id: string | null }>(sql`
      SELECT id, merged_into_id FROM customers
      WHERE id = ANY(${pgArray([merge.survivor_id, merge.merged_id])}::uuid[])`);
    const pointer = new Map(rows.map((row) => [row.id, row.merged_into_id]));
    if (
      pointer.get(merge.survivor_id) !== null ||
      pointer.get(merge.merged_id) !== merge.survivor_id
    ) {
      throw new MergeNotLatest();
    }

    // One stamp for every moved row, read after the locks over the survivor's whole set (review
    // m1 of milestone 3): the restored customer's stamp is newer than any the survivor answered.
    const stamp = (
      await tx.execute<{ at: string }>(sql`
        SELECT ${nextStampOf(await this.customers.idsOf(merge.survivor_id, tx))}::text AS at`)
    ).rows[0]?.at;
    if (stamp === undefined) throw new Error('The undo stamp read returned no row');
    await tx.execute(sql`
      UPDATE customers SET merged_into_id = NULL, updated_at = ${stamp}::timestamptz
      WHERE id = ${merge.merged_id}::uuid`);
    if (merge.repointed_ids.length > 0) {
      const moved = await tx.execute<{ id: string }>(sql`
        UPDATE customers
        SET merged_into_id = ${merge.merged_id}::uuid, updated_at = ${stamp}::timestamptz
        WHERE id = ANY(${pgArray(merge.repointed_ids)}::uuid[])
          AND merged_into_id = ${merge.survivor_id}::uuid
        RETURNING id`);
      if (moved.rows.length !== merge.repointed_ids.length) throw new MergeNotLatest();
    }
    await tx.execute(sql`
      INSERT INTO customer_merges
        (action, survivor_id, merged_id, repointed_ids, undoes_merge_id, reason, actor_id)
      VALUES ('undo', ${merge.survivor_id}::uuid, ${merge.merged_id}::uuid,
              ${pgArray(merge.repointed_ids)}::uuid[], ${mergeId}::uuid, ${reasonCode},
              ${actor.userId}::uuid)`);
    // Every suggestion this merge applied (the named one too: no column records which one it
    // named) whose pair is apart again goes back to the open list, where a person can dismiss it.
    await tx.execute(sql`
      UPDATE customer_merge_suggestions s
      SET status = 'open', merge_id = NULL, decided_by = NULL, decided_at = NULL,
          updated_at = now()
      FROM customers lo, customers hi
      WHERE s.status = 'applied' AND s.merge_id = ${mergeId}::uuid
        AND lo.id = s.customer_low_id AND hi.id = s.customer_high_id
        AND coalesce(lo.merged_into_id, lo.id) <> coalesce(hi.merged_into_id, hi.id)`);
    return {
      restoredId: merge.merged_id,
      survivorId: merge.survivor_id,
      changed: [merge.merged_id, ...merge.repointed_ids],
    };
  }

  /** Refuses a suggestion that is unknown, not open, or about another pair than this merge's. */
  private async checkSuggestion(
    tx: Transaction,
    suggestionId: string,
    survivorId: string,
    mergedId: string,
  ): Promise<void> {
    const row = (
      await tx.execute<{ status: string; low: string; high: string }>(sql`
        SELECT s.status,
               (SELECT coalesce(merged_into_id, id) FROM customers WHERE id = s.customer_low_id) AS low,
               (SELECT coalesce(merged_into_id, id) FROM customers WHERE id = s.customer_high_id) AS high
        FROM customer_merge_suggestions s WHERE s.id = ${suggestionId}::uuid
        FOR UPDATE OF s`)
    ).rows[0];
    if (row === undefined) {
      throw new CustomersError('SUGGESTION_NOT_FOUND', 'No merge suggestion has that id');
    }
    if (row.status !== 'open') {
      throw new CustomersError('SUGGESTION_CLOSED', 'The merge suggestion is no longer open');
    }
    const pair = new Set([row.low, row.high]);
    if (pair.size !== 2 || !pair.has(survivorId) || !pair.has(mergedId)) {
      throw new CustomersError('SUGGESTION_MISMATCH', 'The suggestion names another pair');
    }
  }
}
