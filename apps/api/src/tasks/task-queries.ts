import { Inject, Injectable } from '@nestjs/common';
import {
  TASK_PAGE_SIZE,
  TASK_TYPES,
  taskTypeOf,
  type TaskListResponse,
  type TaskListRow,
  type TaskLink,
  type TaskSummary,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray, type Executor } from '../database/sql.js';
import { HatDirectory } from '../identity/hats/hat-directory.js';
import { StaffDirectory } from '../identity/staff/staff-directory.js';
import type { Access } from '../platform/access/access.js';
import { PlatformClock } from '../platform/license/platform-clock.js';
import { SettingsService } from '../platform/settings/settings.service.js';
import { TaskLinks } from './task-links.js';
import { TASK_COLUMNS, toTaskRow, type TaskDbRow } from './task-rows.js';
import { visibilityPlan, type VisibilityPlan } from './task-visibility.js';

/** The write back types the unsynced count adds up (`sync.write_back_late` joins when registered). */
const UNSYNCED_TYPES = ['sync.write_back_failed', 'sync.write_back_late'].filter((code) =>
  Object.hasOwn(TASK_TYPES, code),
);

/** What a keyset cursor holds: the last row's due time (or none), creation time, and id. */
interface Cursor {
  due: string | null;
  created: string;
  id: string;
}

/** Encodes a cursor as base64url JSON. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Decodes a cursor; null for anything that is not one this module wrote. */
function decodeCursor(text: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { due, created, id } = parsed as Record<string, unknown>;
    const instant = (value: unknown) =>
      typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value);
    if (!(due === null || instant(due)) || !instant(created) || typeof id !== 'string') return null;
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    return { due: due as string | null, created: created as string, id };
  } catch {
    return null;
  }
}

/** A refused cursor: the controller answers 400 `INVALID_QUERY`. */
export class InvalidTaskCursor extends Error {
  /** Fixed text. */
  constructor() {
    super('The cursor is not one this list gave');
    this.name = 'InvalidTaskCursor';
  }
}

/**
 * The read side of tasks (spec 0016): what the caller sees in My work and the counts of the shell.
 * Visibility is decided in SQL from the caller's `Access` and the active holders of each hat
 * (`HatDirectory`, read once per request), so an invisible task is the same as a missing one.
 * Rows carry ids, codes, times, display names of staff, and the label and path a record's owner
 * gives through `TaskLinks` (an order's number and store code; a kind with no resolver shows its
 * kind only); never a phone, a name, an address, or a note. It never writes.
 */
@Injectable()
export class TaskQueries {
  private readonly db: Executor;

  /** Takes the database, the hat and staff directories, the link registry, the clock, and settings. */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    private readonly hats: HatDirectory,
    private readonly staff: StaffDirectory,
    private readonly links: TaskLinks,
    private readonly clock: PlatformClock,
    private readonly settings: SettingsService,
  ) {
    this.db = connection.db;
  }

  /** The plan of what the caller sees: one read of the hat directory. */
  async planFor(access: Access): Promise<VisibilityPlan> {
    return visibilityPlan(access, await this.hats.holdersByHat());
  }

  /** My work, view `mine` (AC-5, milestone 1): one keyset page of the caller's open tasks. */
  async listMine(access: Access, cursorText: string | undefined): Promise<TaskListResponse> {
    // A bad cursor is a bad query for everyone, also for a caller who sees no type at all.
    const cursor = cursorText === undefined ? null : decodeCursor(cursorText);
    if (cursorText !== undefined && !cursor) throw new InvalidTaskCursor();
    const plan = await this.planFor(access);
    if (plan.visibleTypes.length === 0) return { rows: [], nextCursor: null };
    const after = cursor ? afterCursor(cursor) : sql`true`;
    const { rows } = await this.db.execute<TaskDbRow>(sql`
      SELECT ${TASK_COLUMNS} FROM tasks t
       WHERE ${visibleTo(plan)} AND ${after}
       ORDER BY t.due_at ASC NULLS LAST, t.created_at ASC, t.id ASC
       LIMIT ${TASK_PAGE_SIZE + 1}`);
    const page = rows.slice(0, TASK_PAGE_SIZE);
    const last = page[page.length - 1];
    const now = await this.clock.now(this.db);
    const listRows = await this.decorate(page, now);
    return {
      rows: listRows,
      nextCursor:
        rows.length > TASK_PAGE_SIZE && last
          ? encodeCursor({ due: last.due_at, created: last.created_at, id: last.id })
          : null,
    };
  }

  /**
   * One task by id, whatever its status, when the caller would see it as open (her own, her hats'
   * queue, the orphan rule, a type she holds the permission of); null when it is missing or
   * invisible, which a route answers as 404. A task that closed meanwhile still shows, so the
   * second of two parallel closes hears `TASK_CHANGED` and not "not found".
   */
  async visible(access: Access, taskId: string): Promise<TaskListRow | null> {
    const plan = await this.planFor(access);
    if (plan.visibleTypes.length === 0) return null;
    const { rows } = await this.db.execute<TaskDbRow>(
      sql`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ${taskId}::uuid AND ${visibleTo(plan, true)}`,
    );
    const [row] = await this.decorate(rows, await this.clock.now(this.db));
    return row ?? null;
  }

  /** The row of a task as the screen shows it, whatever its status (after a close, the answer). */
  async rowOf(taskId: string, executor: Executor = this.db): Promise<TaskListRow | null> {
    const { rows } = await executor.execute<TaskDbRow>(
      sql`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ${taskId}::uuid`,
    );
    const [row] = await this.decorate(rows, await this.clock.now(executor));
    return row ?? null;
  }

  /**
   * The shell counts (AC-7): the caller's open, overdue, and due today tasks of view `mine`
   * ("today" is the local date in the `timezone` setting), and `unsyncedEdits` for a holder of
   * `orders.confirm`: every open write back task whatever its queue or assignee.
   */
  async summary(access: Access): Promise<TaskSummary> {
    const plan = await this.planFor(access);
    const now = await this.clock.now(this.db);
    const timeZone = await this.settings.get('timezone');
    let open = 0;
    let overdue = 0;
    let dueToday = 0;
    if (plan.visibleTypes.length > 0) {
      // Counted in SQL: "today" is the local date in the brand's time zone, so the day boundary
      // follows daylight saving and never the UTC date.
      const { rows } = await this.db.execute<{ open: number; overdue: number; due_today: number }>(
        sql`SELECT count(*)::int AS open,
                   count(*) FILTER (WHERE t.due_at < ${now.toISOString()}::timestamptz)::int AS overdue,
                   count(*) FILTER (
                     WHERE (t.due_at AT TIME ZONE ${timeZone})::date
                         = (${now.toISOString()}::timestamptz AT TIME ZONE ${timeZone})::date
                   )::int AS due_today
              FROM tasks t WHERE ${visibleTo(plan)}`,
      );
      open = rows[0]?.open ?? 0;
      overdue = rows[0]?.overdue ?? 0;
      dueToday = rows[0]?.due_today ?? 0;
    }
    const summary: TaskSummary = { mine: { open, overdue, dueToday } };
    if (access.has('orders.confirm') && UNSYNCED_TYPES.length > 0) {
      const { rows } = await this.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM tasks
             WHERE status = 'open' AND type = ANY(${pgArray(UNSYNCED_TYPES)}::text[])`,
      );
      return { ...summary, unsyncedEdits: Number(rows[0]?.count ?? 0) };
    }
    return summary;
  }

  /** Turns rows into screen rows: overdue, owner names, links, and the outcomes a person may use. */
  private async decorate(rows: readonly TaskDbRow[], now: Date): Promise<TaskListRow[]> {
    if (rows.length === 0) return [];
    const names = await this.staff.namesByIds(
      rows.flatMap((row) => (row.owner_user_id ? [row.owner_user_id] : [])),
    );
    // One resolver call per linked kind on the page; a kind with no resolver shows its kind only.
    const described = new Map<string, Awaited<ReturnType<TaskLinks['describe']>>>();
    for (const kind of new Set(rows.map((row) => row.linked_type))) {
      described.set(
        kind,
        await this.links.describe(
          kind,
          rows.filter((row) => row.linked_type === kind).map((row) => row.linked_id),
        ),
      );
    }
    return rows.map((row) => {
      const task = toTaskRow(row);
      const definition = taskTypeOf(task.type);
      const allowed =
        !definition || definition.closedBy === 'system'
          ? []
          : definition.outcomes.filter((outcome) => !definition.systemOutcomes?.includes(outcome));
      const resolved = described.get(task.linkedType)?.get(task.linkedId);
      const link: TaskLink = {
        kind: task.linkedType,
        id: task.linkedId,
        path: resolved?.path ?? null,
        label: resolved?.label ?? null,
      };
      return {
        ...task,
        overdue: task.status === 'open' && task.dueAt !== null && new Date(task.dueAt) < now,
        ownerName: task.ownerUserId ? (names.get(task.ownerUserId) ?? null) : null,
        heldBy: null,
        link,
        allowedOutcomes: allowed,
      };
    });
  }
}

/** The `WHERE` condition of the caller's open tasks, from her plan (milestone 1 rules of AC-5). */
function visibleTo(plan: VisibilityPlan, anyStatus = false): SQL {
  const fallen = plan.fallback.map(
    (group) =>
      sql`(t.type = ANY(${pgArray(group.types)}::text[])
           AND t.owner_user_id <> ALL(${pgArray(group.eligible)}::uuid[]))`,
  );
  const queues = [
    ...(plan.hats.length ? [sql`t.owner_hat = ANY(${pgArray(plan.hats)}::text[])`] : []),
    ...(plan.orphanHats.length
      ? [sql`t.owner_hat = ANY(${pgArray(plan.orphanHats)}::text[])`]
      : []),
  ];
  const inQueue = queues.length
    ? sql`((t.owner_user_id IS NULL ${fallen.length ? sql`OR ${sql.join(fallen, sql` OR `)}` : sql``})
           AND (${sql.join(queues, sql` OR `)}))`
    : sql`false`;
  return sql`${anyStatus ? sql`true` : sql`t.status = 'open'`} AND t.type = ANY(${pgArray(plan.visibleTypes)}::text[])
             AND (t.owner_user_id = ${plan.userId}::uuid OR ${inQueue})`;
}

/** The keyset condition for rows after the cursor in (due asc nulls last, created, id) order. */
function afterCursor(cursor: Cursor): SQL {
  const key = sql`(t.created_at, t.id) > (${cursor.created}::timestamptz, ${cursor.id}::uuid)`;
  if (cursor.due === null) return sql`(t.due_at IS NULL AND ${key})`;
  return sql`(t.due_at > ${cursor.due}::timestamptz OR t.due_at IS NULL
              OR (t.due_at = ${cursor.due}::timestamptz AND ${key}))`;
}
