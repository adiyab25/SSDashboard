import { InternalHat, type TaskRow } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';

/** A time written as UTC text with microseconds, the concurrency token form. */
const micro = (column: string) =>
  sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`);

/**
 * The `tasks` columns a `TaskRow` is made of, as SQL: times as microsecond UTC text (so
 * `updated_at` round trips as `expectedUpdatedAt`). The free text `note` is never selected.
 */
export const TASK_COLUMNS = sql`id, type, linked_type, linked_id, subject_key, owner_user_id,
  owner_hat, ${micro('due_at')}, status, outcome_code, created_by_type, ${micro('created_at')},
  ${micro('updated_at')}, ${micro('closed_at')}`;

/** One `tasks` row as `TASK_COLUMNS` selects it. */
export interface TaskDbRow extends Record<string, unknown> {
  id: string;
  type: string;
  linked_type: TaskRow['linkedType'];
  linked_id: string;
  subject_key: string | null;
  owner_user_id: string | null;
  owner_hat: string;
  due_at: string | null;
  status: TaskRow['status'];
  outcome_code: string | null;
  created_by_type: TaskRow['createdByType'];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** The contract shape of a database row. */
export function toTaskRow(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    type: row.type,
    linkedType: row.linked_type,
    linkedId: row.linked_id,
    subjectKey: row.subject_key,
    ownerUserId: row.owner_user_id,
    ownerHat: InternalHat.parse(row.owner_hat),
    dueAt: row.due_at,
    status: row.status,
    outcomeCode: row.outcome_code,
    createdByType: row.created_by_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}
