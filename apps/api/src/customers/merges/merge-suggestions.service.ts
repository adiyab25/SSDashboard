import { Inject, Injectable } from '@nestjs/common';
import {
  personActor,
  type CustomerBrief,
  type CustomerDismissReasonCode,
  type MergeSuggestionItem,
  type MergeSuggestionListQuery,
  type MergeSuggestionPage,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService, type AuditEntryInput } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import {
  decodeTimeIdKeyset,
  encodeKeyset,
  InvalidCursorError,
} from '../../platform/keyset-cursor.js';
import { briefRows, MICRO_UTC } from '../customer-briefs.js';
import { CustomersError } from '../customers.errors.js';
import type { MergeActor } from './customer-merges.service.js';

interface SuggestionRow extends Record<string, unknown> {
  id: string;
  reason: MergeSuggestionItem['reason'];
  created_at: string;
  low: string;
  high: string;
}

/**
 * Lists and dismisses merge suggestions (spec 0014 AC-9). A suggestion row is never deleted (the
 * app role cannot), so a dismissed pair is never suggested again. The list shows open suggestions
 * oldest first and hides a pair whose customers already resolve to one. Rows carry ids and codes
 * only; it never reads another module's table.
 */
@Injectable()
export class MergeSuggestions {
  /** Takes the database and the audit writer. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * One page of open suggestions, keyset paged on (created at, id), each with the two canonical
   * customers it names today (older record first), plus the count of all open ones still apart.
   * A cursor it did not issue is `INVALID_CURSOR`.
   */
  async list(query: MergeSuggestionListQuery): Promise<MergeSuggestionPage> {
    let after: { at: string; id: string } | null = null;
    try {
      after = query.cursor === undefined ? null : decodeTimeIdKeyset(query.cursor);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new CustomersError('INVALID_CURSOR', 'The cursor is not one this endpoint issued');
      }
      throw error;
    }
    const db = this.connection.db;
    const apart = sql`coalesce(lo.merged_into_id, lo.id) <> coalesce(hi.merged_into_id, hi.id)`;
    const afterClause =
      after === null
        ? sql``
        : sql`AND (s.created_at, s.id) > (${after.at}::timestamptz, ${after.id}::uuid)`;
    const { rows } = await db.execute<SuggestionRow>(sql`
      SELECT s.id, s.reason,
             to_char(s.created_at AT TIME ZONE 'UTC', ${sql.raw(MICRO_UTC)}) AS created_at,
             coalesce(lo.merged_into_id, lo.id) AS low, coalesce(hi.merged_into_id, hi.id) AS high
      FROM customer_merge_suggestions s
      JOIN customers lo ON lo.id = s.customer_low_id
      JOIN customers hi ON hi.id = s.customer_high_id
      WHERE s.status = 'open' AND ${apart} ${afterClause}
      ORDER BY s.created_at, s.id
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const count = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM customer_merge_suggestions s
      JOIN customers lo ON lo.id = s.customer_low_id
      JOIN customers hi ON hi.id = s.customer_high_id
      WHERE s.status = 'open' AND ${apart}`);
    const briefs = new Map(
      (await briefRows(db, [...new Set(page.flatMap((row) => [row.low, row.high]))])).map(
        (brief) => [brief.id, brief],
      ),
    );
    const older = (a: CustomerBrief, b: CustomerBrief): number =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;
    const items = page.flatMap((row): MergeSuggestionItem[] => {
      const low = briefs.get(row.low);
      const high = briefs.get(row.high);
      if (!low || !high) return [];
      const [first, second] = [low, high].sort(older) as [CustomerBrief, CustomerBrief];
      return [
        { id: row.id, reason: row.reason, createdAt: row.created_at, customers: [first, second] },
      ];
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.created_at, last.id]) : null,
      openCount: count.rows[0]?.n ?? 0,
    };
  }

  /**
   * Dismisses an open suggestion for good (status `dismissed`, who, when, the reason code), and
   * writes one `customer.merge_suggestion_dismissed` on each customer of the pair under one
   * correlation id. `SUGGESTION_NOT_FOUND` for an unknown id, `SUGGESTION_CLOSED` when it is not
   * open.
   */
  async dismiss(
    suggestionId: string,
    reasonCode: CustomerDismissReasonCode | undefined,
    actor: MergeActor,
  ): Promise<void> {
    const correlationId = this.audit.newCorrelationId();
    await this.connection.db.transaction(async (tx) => {
      const row = (
        await tx.execute<{ status: string; low: string; high: string }>(sql`
          SELECT status, customer_low_id AS low, customer_high_id AS high
          FROM customer_merge_suggestions WHERE id = ${suggestionId}::uuid FOR UPDATE`)
      ).rows[0];
      if (row === undefined) {
        throw new CustomersError('SUGGESTION_NOT_FOUND', 'No merge suggestion has that id');
      }
      if (row.status !== 'open') {
        throw new CustomersError('SUGGESTION_CLOSED', 'The merge suggestion is no longer open');
      }
      await tx.execute(sql`
        UPDATE customer_merge_suggestions
        SET status = 'dismissed', decided_by = ${actor.userId}::uuid, decided_at = now(),
            dismiss_reason = ${reasonCode ?? null}, updated_at = now()
        WHERE id = ${suggestionId}::uuid`);
      const auditActor = personActor(actor.userId, actor.hat);
      await this.audit.recordMany(
        tx,
        [
          [row.low, row.high],
          [row.high, row.low],
        ].map(([id, other]): AuditEntryInput => ({
          actor: auditActor,
          action: 'customer.merge_suggestion_dismissed',
          record: { type: 'customer', id: id as string },
          before: { suggestionStatus: 'open' },
          after: { suggestionId, suggestionStatus: 'dismissed', otherCustomerId: other as string },
          ...(reasonCode === undefined ? {} : { reason: reasonCode }),
          correlationId,
        })),
      );
    });
  }
}
