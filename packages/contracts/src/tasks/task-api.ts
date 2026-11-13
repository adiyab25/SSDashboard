import { z } from 'zod';
import { InternalHat } from '../access.js';
import { ReasonCode } from '../orders/order-states.js';
import { TaskCreatedByType, TaskLinkedType, TaskStatus } from './task-enums.js';

/**
 * A time as the tasks api writes it: UTC ISO text with microseconds (`2026-11-12T10:00:00.123456Z`).
 * `updatedAt` in this form is the concurrency token a person sends back as `expectedUpdatedAt`.
 */
const TaskInstant = z.iso.datetime({ offset: true });

/** The longest free text a task or a close note keeps (spec 0016, `tasks_note_length`). */
export const TASK_NOTE_MAX = 1000;

/**
 * One task as `TasksService` returns it (spec 0016, *Interface for other modules*): ids, codes,
 * and times only. The free text note is never part of it.
 */
export const TaskRow = z.object({
  id: z.uuid(),
  type: z.string(),
  linkedType: TaskLinkedType,
  linkedId: z.uuid(),
  subjectKey: z.string().nullable(),
  ownerUserId: z.uuid().nullable(),
  ownerHat: InternalHat,
  dueAt: TaskInstant.nullable(),
  status: TaskStatus,
  outcomeCode: z.string().nullable(),
  createdByType: TaskCreatedByType,
  createdAt: TaskInstant,
  updatedAt: TaskInstant,
  closedAt: TaskInstant.nullable(),
});
/** The validated shape of `TaskRow`. */
export type TaskRow = z.infer<typeof TaskRow>;

/**
 * A non personal label of the record a row points at (spec 0016 AC-12): an order shows its number
 * and store code, never a phone, a name, or an address.
 */
export const TaskLinkLabel = z.object({
  kind: z.literal('order'),
  number: z.string(),
  storeCode: z.string(),
});
/** The validated shape of `TaskLinkLabel`. */
export type TaskLinkLabel = z.infer<typeof TaskLinkLabel>;

/**
 * The record a row points at, without personal data: the kind, the id, the web path that opens
 * it, and a label when the owner can give one. Milestone 1 has no link resolvers, so only an
 * order has a label (read through the orders module's `OrderQueries.summaryOf`), and `label` is
 * null for every other kind; the path of an order is `/orders/<id>`.
 */
export const TaskLink = z.object({
  kind: TaskLinkedType,
  id: z.uuid(),
  path: z.string().startsWith('/'),
  label: TaskLinkLabel.nullable(),
});
/** The validated shape of `TaskLink`. */
export type TaskLink = z.infer<typeof TaskLink>;

/**
 * One row of My work (spec 0016 AC-5, API surface): the task, whether it is overdue now, who
 * holds it, the link to its record, and the outcomes a person may close it with (empty for a type
 * only the system closes). `heldBy` is null in milestone 1: the "overdue, held by someone else"
 * rows arrive with milestone 2.
 */
export const TaskListRow = TaskRow.extend({
  overdue: z.boolean(),
  ownerName: z.string().nullable(),
  heldBy: z.object({ userId: z.uuid(), name: z.string() }).nullable(),
  link: TaskLink,
  allowedOutcomes: z.array(z.string()),
});
/** The validated shape of `TaskListRow`. */
export type TaskListRow = z.infer<typeof TaskListRow>;

/** `GET /api/tasks` query: `view` is `mine` in milestone 1 (`team` answers 400 `INVALID_QUERY`). */
export const TaskListQuery = z.object({
  view: z.literal('mine').default('mine'),
  cursor: z.string().min(1).max(300).optional(),
});
/** The validated shape of `TaskListQuery`. */
export type TaskListQuery = z.infer<typeof TaskListQuery>;

/** The page size of My work. */
export const TASK_PAGE_SIZE = 50;

/** `GET /api/tasks` answer: a page of rows and the cursor of the next page, or null. */
export const TaskListResponse = z.object({
  rows: z.array(TaskListRow),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `TaskListResponse`. */
export type TaskListResponse = z.infer<typeof TaskListResponse>;

/** `GET /api/tasks/summary` answer (AC-7): `unsyncedEdits` only for a holder of `orders.confirm`. */
export const TaskSummary = z.object({
  mine: z.object({
    open: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    dueToday: z.number().int().nonnegative(),
  }),
  unsyncedEdits: z.number().int().nonnegative().optional(),
});
/** The validated shape of `TaskSummary`. */
export type TaskSummary = z.infer<typeof TaskSummary>;

/**
 * `POST /api/tasks/:id/close` body (AC-3): an outcome code, an optional note (1 to 1,000
 * characters, personal data, never echoed), and the `updatedAt` the row showed.
 */
export const CloseTaskBody = z.strictObject({
  outcome: ReasonCode,
  note: z.string().trim().min(1).max(TASK_NOTE_MAX).optional(),
  expectedUpdatedAt: TaskInstant,
});
/** The validated shape of `CloseTaskBody`. */
export type CloseTaskBody = z.infer<typeof CloseTaskBody>;

/**
 * The error codes of the tasks routes (spec 0016 API surface). The api answers each with the
 * status named beside it: 404 `TASK_NOT_FOUND`, 409 `TASK_CHANGED` and `TASK_NOT_OPEN`, 422
 * `OUTCOME_INVALID`, `OUTCOME_NOT_FOR_PERSON`, `NOTE_REQUIRED`, and `VALIDATION_FAILED`, 400
 * `INVALID_QUERY`.
 */
export const TaskErrorCode = z.enum([
  'TASK_NOT_FOUND',
  'TASK_CHANGED',
  'TASK_NOT_OPEN',
  'OUTCOME_INVALID',
  'OUTCOME_NOT_FOR_PERSON',
  'NOTE_REQUIRED',
  'VALIDATION_FAILED',
  'INVALID_QUERY',
]);
/** One TaskErrorCode value. */
export type TaskErrorCode = z.infer<typeof TaskErrorCode>;
