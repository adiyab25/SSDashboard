import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditActorKind,
  AuditEntryListQuery,
  AuditEntryListResponse,
  AuditEntryView,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray } from '../database/sql.js';
import { decodeTimeIdKeyset, encodeKeyset } from '../platform/keyset-cursor.js';
import { StaffDirectory } from '../identity/staff/staff-directory.js';

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** One `audit_entries` row as the list query returns it. */
type EntryRow = {
  id: string;
  recorded_at: string;
  operating_day: string;
  correlation_id: string;
  actor_kind: AuditActorKind;
  actor_user_id: string | null;
  actor_ref: string | null;
  actor_hat: string | null;
  job_id: string | null;
  action: string;
  record_type: string;
  record_id: string;
  record_label: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  personal_fields: string[];
  reason: string | null;
};

/**
 * The only reader of `audit_entries` (spec 0010, AC-9, AC-12). Other modules read history through
 * it, never through the table. Person names come from the staff directory by id, never from a
 * join. The caller (the controller) checks that the viewer may read the trail (AC-13).
 * It never pages by offset and never counts all rows.
 */
@Injectable()
export class AuditQueryService {
  /** Takes the app database connection and the staff directory for actor names. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /**
   * Entries newest first (`recorded_at`, then id), filtered by person, record, action, operating
   * day range, and correlation id, one keyset page at a time. A cursor this endpoint did not issue
   * throws `InvalidCursorError` from the keyset helper.
   */
  async list(query: AuditEntryListQuery): Promise<AuditEntryListResponse> {
    const filters: SQL[] = [];
    if (query.actorUserId) filters.push(sql`actor_user_id = ${query.actorUserId}`);
    if (query.recordType) filters.push(sql`record_type = ${query.recordType}`);
    if (query.recordId) filters.push(sql`record_id = ${query.recordId}`);
    if (query.action) filters.push(sql`action = ${query.action}`);
    if (query.dayFrom) filters.push(sql`operating_day >= ${query.dayFrom}::date`);
    if (query.dayTo) filters.push(sql`operating_day <= ${query.dayTo}::date`);
    if (query.correlationId) filters.push(sql`correlation_id = ${query.correlationId}`);
    if (query.cursor) {
      const after = decodeTimeIdKeyset(query.cursor);
      filters.push(sql`(recorded_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
    }
    const where = filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
    const { rows } = await this.connection.db.execute<EntryRow>(sql`
      SELECT id, to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS recorded_at,
             to_char(operating_day, 'YYYY-MM-DD') AS operating_day, correlation_id, actor_kind,
             actor_user_id, actor_ref, actor_hat, job_id, action, record_type, record_id,
             record_label, before, after, personal_fields, reason
      FROM audit_entries
      ${where}
      ORDER BY recorded_at DESC, id DESC
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const ids = page.map((row) => row.id);
    const undone = await this.undoneAmong(ids);
    const names = await this.staff.namesByIds(
      page.flatMap((row) => (row.actor_user_id ? [row.actor_user_id] : [])),
    );
    const last = page.at(-1);
    return {
      items: page.map((row): AuditEntryView => ({
        id: row.id,
        recordedAt: row.recorded_at,
        operatingDay: row.operating_day,
        correlationId: row.correlation_id,
        actor: {
          kind: row.actor_kind,
          userId: row.actor_user_id,
          ref: row.actor_ref,
          hat: row.actor_hat,
          jobId: row.job_id,
        },
        actorName: row.actor_user_id ? (names.get(row.actor_user_id) ?? null) : null,
        action: row.action,
        record: { type: row.record_type, id: row.record_id, label: row.record_label },
        before: row.before,
        after: row.after,
        personalFields: row.personal_fields,
        reason: row.reason,
        undone: undone.has(row.id),
        // The undo arrives with milestone 4 (AuditUndoService); until then nothing is undoable.
        canUndo: false,
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.recorded_at, last.id]) : null,
    };
  }

  /** The ids among `ids` that a later entry undoes (spec 0010, State). */
  private async undoneAmong(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const { rows } = await this.connection.db.execute<{ id: string }>(sql`
      SELECT undoes_entry_id AS id FROM audit_entries
      WHERE undoes_entry_id = ANY(${pgArray(ids)}::uuid[])`);
    return new Set(rows.map((row) => row.id));
  }
}
