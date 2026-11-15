import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  HAT_PERMISSIONS,
  InternalHat,
  personActor,
  systemJobActor,
  taskTypeOf,
  type AuditActor,
  type TaskLinkedType,
  type TaskRow,
  type TaskTypeCode,
  type TaskTypeDefinition,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { AuditService } from '../audit/audit.service.js';
import type { Executor, Transaction } from '../database/sql.js';
import { HatDirectory } from '../identity/hats/hat-directory.js';
import { PlatformClock } from '../platform/license/platform-clock.js';
import { dueFromRule } from './task-due.js';
import {
  InvalidOutcome,
  KeyShapeInvalid,
  NoteInvalid,
  NoteRequired,
  ExpectedUpdatedAtRequired,
  SystemNoteRefused,
  OutcomeNotForPerson,
  TaskAssigneeNotEligible,
  TaskChanged,
  TaskLinkNotAllowed,
  TaskNotFound,
  TaskNotOpen,
  UnknownTaskType,
} from './task-errors.js';
import { TASK_COLUMNS, toTaskRow, type TaskDbRow } from './task-rows.js';

/**
 * Who acts: a person (a staff user id, with the hat the audit entry names) or a system job
 * (spec 0016, *Interface for other modules*). The hat is optional because only the audit entry
 * uses it; without one the entry says `none`.
 */
export type TaskActor =
  | { readonly kind: 'person'; readonly userId: string; readonly hat?: string }
  | { readonly kind: 'system_job' };

/** The record a task is about. */
export interface TaskLinkedRecord {
  readonly type: TaskLinkedType;
  readonly id: string;
}

/** What `TasksService.open` takes. */
export interface OpenTaskInput {
  readonly type: TaskTypeCode;
  readonly linked: TaskLinkedRecord;
  /** Ids and codes only, `^[a-z0-9:_.-]{1,120}$` (for example a command kind and a failure code). */
  readonly subjectKey?: string;
  /** Else the type's due rule; `null` means no due time. Kept as passed. */
  readonly dueAt?: Date | null;
  /** Else the type's default hat. */
  readonly hat?: InternalHat;
  /** An active person who holds the type's permission. */
  readonly assigneeId?: string;
  /** Built from ids, never a phone or a name: `^[A-Za-z0-9:_.-]{1,200}$`. */
  readonly dedupeKey?: string;
  /** Free text, personal data, 1 to 1,000 characters. */
  readonly note?: string;
  readonly by: TaskActor;
}

const SUBJECT_KEY_SHAPE = /^[a-z0-9:_.-]{1,120}$/;
const DEDUPE_KEY_SHAPE = /^[A-Za-z0-9:_.-]{1,200}$/;
const NOTE_MAX = 1000;

/**
 * The one writer of `tasks` and `task_notes` (spec 0016, Key invariants; pinned by
 * `tasks-single-writer.spec.ts`). Other modules open and close tasks only through it, inside
 * their own transaction: every method takes the caller's `tx`, locks the task row `FOR UPDATE`
 * (or, for `open` with a key, inserts with `ON CONFLICT ... DO NOTHING` and reads the winner),
 * and never commits, opens a transaction, or catches a database error. A system call skips the
 * person checks (`expectedUpdatedAt`) but never the registry checks. Milestone 1 holds `open`,
 * `close`, and `closeByKey`; reschedule, assign, cancel, and the finders follow in milestone 2.
 * It must never log or audit a note, and never read another module's tables.
 */
@Injectable()
export class TasksService {
  /** Takes the clock, the audit writer, and the hat directory (who may hold a type). */
  constructor(
    private readonly clock: PlatformClock,
    private readonly audit: AuditService,
    private readonly hats: HatDirectory,
  ) {}

  /**
   * The active people who hold the type's permission through a hat they wear (an eligible
   * assignee, and the people a task falls back to). One read of the hat directory, through
   * `executor` when given (a caller inside a transaction passes its own).
   */
  async eligibleFor(type: TaskTypeCode, executor?: Executor): Promise<ReadonlySet<string>> {
    const definition = taskTypeOf(type);
    if (!definition) throw new UnknownTaskType();
    return eligibleHolders(definition, await this.hats.holdersByHat(executor));
  }

  /**
   * Opens a task, or returns the open one with the same dedupe key (`created: false`), also when
   * two transactions open at once (one row, both callers get it). Throws `UnknownTaskType`,
   * `TaskLinkNotAllowed`, `KeyShapeInvalid`, `NoteInvalid`, `TaskAssigneeNotEligible`, and
   * `DueRequired`. Always stores `owner_hat`. Returning an existing task never moves its due
   * time or owner.
   */
  async open(tx: Transaction, input: OpenTaskInput): Promise<{ task: TaskRow; created: boolean }> {
    const definition = taskTypeOf(input.type);
    if (!definition) throw new UnknownTaskType();
    if (!definition.linkedTypes.includes(input.linked.type)) throw new TaskLinkNotAllowed();
    if (input.subjectKey !== undefined && !SUBJECT_KEY_SHAPE.test(input.subjectKey)) {
      throw new KeyShapeInvalid();
    }
    if (input.dedupeKey !== undefined && !DEDUPE_KEY_SHAPE.test(input.dedupeKey)) {
      throw new KeyShapeInvalid();
    }
    if (input.note !== undefined && (input.note.length < 1 || input.note.length > NOTE_MAX)) {
      throw new NoteInvalid();
    }
    const hat = InternalHat.parse(input.hat ?? definition.defaultHat);
    if (input.assigneeId !== undefined) {
      const eligible = eligibleHolders(definition, await this.hats.holdersByHat(tx));
      if (!eligible.has(input.assigneeId)) throw new TaskAssigneeNotEligible();
    }
    const dueAt =
      input.dueAt !== undefined
        ? input.dueAt
        : dueFromRule(definition.due, await this.clock.now(tx));
    const creator = input.by.kind === 'person' ? input.by.userId : null;

    if (input.dedupeKey !== undefined && definition.once) {
      // A `once` type opens at most one task of a key ever: look at every status first, under a
      // lock so two openers cannot both miss.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`task_once:${input.dedupeKey}`}))`,
      );
      const earlier = await tx.execute<TaskDbRow>(
        sql`SELECT ${TASK_COLUMNS} FROM tasks WHERE dedupe_key = ${input.dedupeKey}
             ORDER BY created_at LIMIT 1`,
      );
      if (earlier.rows[0]) return { task: toTaskRow(earlier.rows[0]), created: false };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await tx.execute<TaskDbRow>(sql`
        INSERT INTO tasks (type, linked_type, linked_id, owner_user_id, owner_hat, due_at, note,
                           dedupe_key, subject_key, created_by_type, created_by)
        VALUES (${input.type}, ${input.linked.type}::task_linked_type, ${input.linked.id}::uuid,
                ${input.assigneeId ?? null}::uuid, ${hat},
                ${dueAt === null ? null : dueAt.toISOString()}::timestamptz,
                ${input.note ?? null}, ${input.dedupeKey ?? null}, ${input.subjectKey ?? null},
                ${input.by.kind}::task_created_by_type, ${creator}::uuid)
        ON CONFLICT (tenant_id, dedupe_key) WHERE status = 'open' DO NOTHING
        RETURNING ${TASK_COLUMNS}`);
      if (inserted.rows[0]) return { task: toTaskRow(inserted.rows[0]), created: true };
      // The conflicting row committed before this statement ended: read the winner. It may have
      // closed since, in which case the next attempt opens a fresh one.
      const winner = await tx.execute<TaskDbRow>(
        sql`SELECT ${TASK_COLUMNS} FROM tasks
             WHERE dedupe_key = ${input.dedupeKey ?? null} AND status = 'open'`,
      );
      if (winner.rows[0]) return { task: toTaskRow(winner.rows[0]), created: false };
    }
    // Three rounds of a key opening and closing under us: a retry of the whole unit is right.
    throw new TaskChanged();
  }

  /**
   * Closes an open task with an allowed outcome and writes one `task.closed` audit entry in the
   * same transaction (ids and codes only, never the note). A person's `expectedUpdatedAt` that is
   * not the row's `updated_at` throws `TaskChanged` (checked first, so the loser of two parallel
   * closes hears `TaskChanged`); a person without one gets `ExpectedUpdatedAtRequired`, and a system
   * close with a note `SystemNoteRefused`. Then: `TaskNotOpen`; `InvalidOutcome` (not one of the type's
   * outcomes); `OutcomeNotForPerson` (a system outcome, or a type only the system closes);
   * `NoteRequired`. A person's note is appended to `task_notes`.
   */
  async close(
    tx: Transaction,
    taskId: string,
    change: { outcome: string; note?: string; by: TaskActor; expectedUpdatedAt?: string },
  ): Promise<TaskRow> {
    if (change.by.kind === 'person' && change.expectedUpdatedAt === undefined) {
      throw new ExpectedUpdatedAtRequired();
    }
    if (change.by.kind === 'system_job' && change.note !== undefined) throw new SystemNoteRefused();
    const locked = await tx.execute<TaskDbRow & { fresh: boolean }>(
      sql`SELECT ${TASK_COLUMNS},
                 ${change.expectedUpdatedAt === undefined ? sql`true` : sql`coalesce(updated_at = ${change.expectedUpdatedAt}::timestamptz, false)`} AS fresh
            FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`,
    );
    const current = locked.rows[0];
    if (!current) throw new TaskNotFound();
    if (change.by.kind === 'person' && !current.fresh) throw new TaskChanged();
    if (current.status !== 'open') throw new TaskNotOpen();
    const definition = taskTypeOf(current.type);
    if (!definition) throw new UnknownTaskType();
    if (!definition.outcomes.includes(change.outcome)) throw new InvalidOutcome();
    if (change.by.kind === 'person') {
      if (definition.closedBy === 'system') throw new OutcomeNotForPerson();
      if (definition.systemOutcomes?.includes(change.outcome)) throw new OutcomeNotForPerson();
      if (definition.noteRequiredOutcomes?.includes(change.outcome) && !change.note) {
        throw new NoteRequired();
      }
    }
    if (change.note !== undefined && (change.note.length < 1 || change.note.length > NOTE_MAX)) {
      throw new NoteInvalid();
    }
    const closer = change.by.kind === 'person' ? change.by.userId : null;
    const closed = await tx.execute<TaskDbRow>(sql`
      UPDATE tasks
         SET status = 'done', outcome_code = ${change.outcome}, closed_at = clock_timestamp(),
             closed_by = ${closer}::uuid, updated_at = clock_timestamp()
       WHERE id = ${taskId}::uuid
       RETURNING ${TASK_COLUMNS}`);
    const row = closed.rows[0];
    if (!row) throw new TaskNotFound();
    if (change.by.kind === 'person' && change.note !== undefined) {
      await tx.execute(
        sql`INSERT INTO task_notes (task_id, note, author_id)
            VALUES (${taskId}::uuid, ${change.note}, ${change.by.userId}::uuid)`,
      );
    }
    const actor = auditActorOf(change.by);
    await this.audit.record(tx, {
      actor,
      action: 'task.closed',
      record: { type: 'task', id: taskId },
      before: { status: 'open' },
      after: { status: 'done', outcome: change.outcome },
      reason: change.by.kind === 'person' ? 'closed_by_person' : 'closed_by_system',
      correlationId: this.audit.newCorrelationId(actor),
    });
    return toTaskRow(row);
  }

  /**
   * Closes the open task with this dedupe key as the system; answers null when none is open (or
   * it closed between the look and the lock).
   */
  async closeByKey(
    tx: Transaction,
    dedupeKey: string,
    change: { outcome: string; by: TaskActor },
  ): Promise<TaskRow | null> {
    const found = await tx.execute<{ id: string }>(
      sql`SELECT id FROM tasks WHERE dedupe_key = ${dedupeKey} AND status = 'open'`,
    );
    const id = found.rows[0]?.id;
    if (!id) return null;
    try {
      return await this.close(tx, id, { outcome: change.outcome, by: change.by });
    } catch (error) {
      if (error instanceof TaskNotOpen) return null;
      throw error;
    }
  }
}

/** The active people wearing a hat that holds the type's required permission. */
function eligibleHolders(
  definition: TaskTypeDefinition,
  holders: ReadonlyMap<InternalHat, readonly string[]>,
): ReadonlySet<string> {
  const eligible = new Set<string>();
  for (const hat of InternalHat.options) {
    if (!HAT_PERMISSIONS[hat].includes(definition.requiredPermission)) continue;
    for (const userId of holders.get(hat) ?? []) eligible.add(userId);
  }
  return eligible;
}

/** The audit actor of a task actor: a person under a hat, or a system job with a fresh job id. */
function auditActorOf(by: TaskActor): AuditActor {
  return by.kind === 'person'
    ? personActor(by.userId, by.hat ?? 'none')
    : systemJobActor('tasks', randomUUID());
}
