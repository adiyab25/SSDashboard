import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditActorKind,
  AuditEntryDetail,
  AuditEntryListQuery,
  AuditEntryListResponse,
  AuditEntryView,
  AuditExportQuery,
  AuditFieldChange,
  StaffRole,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray } from '../database/sql.js';
import { StaffDirectory } from '../identity/staff/staff-directory.js';
import { decodeTimeIdKeyset, encodeKeyset } from '../platform/keyset-cursor.js';
import { AuditEntryNotFound, AuditReadForbidden } from './audit.errors.js';

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * Who is reading the trail, as the read permission sees them (spec 0010, AC-13). `role` stands in
 * for the `audit.read` permission until hats land (spec 0008).
 */
export interface AuditViewer {
  id: string;
  role: StaffRole;
}

/** Whether a viewer may read the trail: `audit.read`, the `admin` role until hats land. */
export function canReadAudit(viewer: AuditViewer): boolean {
  return viewer.role === 'admin';
}

/** One `audit_entries` row as the readers select it. */
export type EntryRow = {
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

/** The columns every reader selects, `recorded_at` as the microsecond UTC text the cursor uses. */
const ENTRY_COLUMNS = sql`
  id, to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS recorded_at,
  to_char(operating_day, 'YYYY-MM-DD') AS operating_day, correlation_id, actor_kind,
  actor_user_id, actor_ref, actor_hat, job_id, action, record_type, record_id,
  record_label, before, after, personal_fields, reason`;

/** A position in the keyset order: an entry's `recorded_at` (microsecond UTC text) and id. */
export interface AuditKey {
  at: string;
  id: string;
}

/** The keyset condition "this entry or an older one". */
function atOrBelow(key: AuditKey): SQL {
  return sql`(recorded_at, id) <= (${key.at}::timestamptz, ${key.id}::uuid)`;
}

/** The filters of a list or export query, as SQL conditions (no cursor). */
function filtersOf(query: Omit<Partial<AuditEntryListQuery>, 'cursor' | 'limit'>): SQL[] {
  const filters: SQL[] = [];
  if (query.actorUserId) filters.push(sql`actor_user_id = ${query.actorUserId}`);
  if (query.recordType) filters.push(sql`record_type = ${query.recordType}`);
  if (query.recordId) filters.push(sql`record_id = ${query.recordId}`);
  if (query.action) filters.push(sql`action = ${query.action}`);
  if (query.dayFrom) filters.push(sql`operating_day >= ${query.dayFrom}::date`);
  if (query.dayTo) filters.push(sql`operating_day <= ${query.dayTo}::date`);
  if (query.correlationId) filters.push(sql`correlation_id = ${query.correlationId}`);
  return filters;
}

/**
 * The field by field diff of an entry (spec 0010, AC-12): every top level field of `before` and
 * `after`, in stored order, with the values on each side (null when absent) and whether the trail
 * masked it as personal (its path, or a path under it, is in `personal_fields`).
 */
export function fieldChanges(row: EntryRow): AuditFieldChange[] {
  const fields = [...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})])];
  return fields.map((field) => ({
    field,
    before: row.before?.[field] ?? null,
    after: row.after?.[field] ?? null,
    personal: row.personal_fields.some((path) => path === field || path.startsWith(`${field}.`)),
  }));
}

/**
 * The only reader of `audit_entries` (spec 0010, AC-9, AC-12). Other modules read history through
 * it, never through the table. Person names come from the staff directory by id, never from a
 * join. `list`, `get`, and the export reads are guarded by their controller (`@Roles('admin')`
 * until `audit.read` lands); `forRecord`, which other modules may reach, takes the viewer and
 * refuses without the read permission itself (review AR3). It never pages by offset and never
 * counts all rows.
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
    return this.page(filtersOf(query), query.cursor, query.limit);
  }

  /**
   * The history of one record for the panel other screens embed (spec 0010, task 13): its entries
   * newest first, one keyset page at a time. Refuses a viewer without the read permission
   * (`AuditReadForbidden`), whoever calls it.
   */
  async forRecord(
    viewer: AuditViewer,
    type: string,
    id: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<AuditEntryListResponse> {
    if (!canReadAudit(viewer)) throw new AuditReadForbidden();
    return this.page([sql`record_type = ${type}`, sql`record_id = ${id}`], cursor, limit);
  }

  /** One entry with its field diff (spec 0010, AC-12), or `AuditEntryNotFound`. */
  async get(id: string): Promise<AuditEntryDetail> {
    const { rows } = await this.connection.db.execute<EntryRow>(sql`
      SELECT ${ENTRY_COLUMNS} FROM audit_entries WHERE id = ${id}`);
    const row = rows[0];
    if (!row) throw new AuditEntryNotFound();
    const [view] = await this.views([row]);
    if (!view) throw new AuditEntryNotFound();
    return { ...view, changes: fieldChanges(row) };
  }

  /**
   * The newest entry key inside an export's filter, or null when it holds none (spec 0010,
   * AC-15, review M3R2). The export counts and streams only entries at or below it, so the file
   * is exactly what was counted, and entries recorded later (the export's own among them) never
   * join it.
   */
  async exportBound(query: AuditExportQuery): Promise<AuditKey | null> {
    const { rows } = await this.connection.db.execute<{ at: string; id: string }>(sql`
      SELECT to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS at, id
      FROM audit_entries WHERE ${sql.join(filtersOf(query), sql` AND `)}
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1`);
    return rows[0] ?? null;
  }

  /**
   * How many entries at or below `bound` an export holds, counting at most `cap` of them (spec
   * 0010, AC-15): a `LIMIT`ed count, never a count of the whole table.
   */
  async exportSize(query: AuditExportQuery, bound: AuditKey, cap: number): Promise<number> {
    const filters = [...filtersOf(query), atOrBelow(bound)];
    const { rows } = await this.connection.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM audit_entries WHERE ${sql.join(filters, sql` AND `)} LIMIT ${cap}
      ) capped`);
    return rows[0]?.n ?? 0;
  }

  /**
   * The export's entries at or below `bound`, newest first, one keyset batch of `batch` rows at
   * a time and `max` rows in all, with the instant in the install time zone (`local_at`) and
   * actor names (spec 0010, AC-15). The caller closes the generator (a `for await` that stops
   * early does) when its reader goes away.
   */
  async *exportBatches(
    query: AuditExportQuery,
    timezone: string,
    bound: AuditKey,
    batch: number,
    max: number,
  ): AsyncGenerator<{ row: EntryRow; localAt: string; actorName: string | null }[]> {
    const filters = filtersOf(query);
    let after: AuditKey | null = null;
    let left = max;
    while (left > 0) {
      const keyset: SQL = after
        ? sql`(recorded_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`
        : atOrBelow(bound);
      const { rows } = await this.connection.db.execute<EntryRow & { local_at: string }>(sql`
        SELECT ${ENTRY_COLUMNS},
               to_char(recorded_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS local_at
        FROM audit_entries WHERE ${sql.join([...filters, keyset], sql` AND `)}
        ORDER BY recorded_at DESC, id DESC
        LIMIT ${Math.min(batch, left)}`);
      if (!rows.length) return;
      const names = await this.staff.namesByIds(
        rows.flatMap((row) => (row.actor_user_id ? [row.actor_user_id] : [])),
      );
      yield rows.map((row) => ({
        row,
        localAt: row.local_at,
        actorName: row.actor_user_id ? (names.get(row.actor_user_id) ?? null) : null,
      }));
      left -= rows.length;
      const last = rows.at(-1);
      if (!last || rows.length < batch) return;
      after = { at: last.recorded_at, id: last.id };
    }
  }

  /** One keyset page under the given conditions, newest first. */
  private async page(
    filters: SQL[],
    cursor: string | undefined,
    limit: number,
  ): Promise<AuditEntryListResponse> {
    const conditions = [...filters];
    if (cursor) {
      const after = decodeTimeIdKeyset(cursor);
      conditions.push(sql`(recorded_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
    }
    const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
    const { rows } = await this.connection.db.execute<EntryRow>(sql`
      SELECT ${ENTRY_COLUMNS}
      FROM audit_entries
      ${where}
      ORDER BY recorded_at DESC, id DESC
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await this.views(page),
      nextCursor: rows.length > limit && last ? encodeKeyset([last.recorded_at, last.id]) : null,
    };
  }

  /** The screen's view of rows: actor names, and whether a later entry undid each. */
  private async views(rows: EntryRow[]): Promise<AuditEntryView[]> {
    const undone = await this.undoneAmong(rows.map((row) => row.id));
    const names = await this.staff.namesByIds(
      rows.flatMap((row) => (row.actor_user_id ? [row.actor_user_id] : [])),
    );
    return rows.map((row): AuditEntryView => ({
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
    }));
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
