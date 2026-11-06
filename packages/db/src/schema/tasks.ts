import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, id, reasonCodeShape, tenantId, updatedAt } from './columns.js';

// The tasks module (spec 0002, customers, credit, and tasks child): one small record every process
// opens and closes. Only the tasks module writes this table. Tasks are mutable (assign, reschedule,
// close) but never deleted: a task is cancelled, and the app role has no DELETE or TRUNCATE. The
// rules migration (0002) stamps `operating_day` from `created_at` and refuses any other change of
// the stamped day.

/** Where a task stands. */
export const taskStatus = pgEnum('task_status', ['open', 'done', 'cancelled']);

/** The kind of record a task points at. Polymorphic, so there is no foreign key. */
export const taskLinkedType = pgEnum('task_linked_type', [
  'order',
  'customer',
  'exchange',
  'refund',
  'shipment',
  'settlement_line',
  'settlement_statement',
  'settlement_period',
  'outbound_command',
  'party',
  'location',
]);

/** Who opened a task. */
export const taskCreatedByType = pgEnum('task_created_by_type', ['person', 'system_job']);

/**
 * One task on one record: a type from the code registry, an owner (a person, or one of the four
 * internal hats whose queue holds it), an optional due time, and an outcome code set exactly when it
 * is done. At most one open task per dedupe key. `note` is free text: personal data, never logged.
 * `operatingDay` is stamped from `createdAt` by trigger; writers never pass it.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    tenantId: tenantId(),
    /** A registry code, for example `confirmation.call`. */
    type: text('type').notNull(),
    linkedType: taskLinkedType('linked_type').notNull(),
    linkedId: uuid('linked_id').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** The internal hat whose queue holds the task when nobody is assigned. */
    ownerHat: text('owner_hat'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: taskStatus('status').notNull().default('open'),
    outcomeCode: text('outcome_code'),
    /** Free text: personal data, redacted from logs. */
    note: text('note'),
    /** One open task per cause, for example `outbound_command_failed:<command id>`. */
    dedupeKey: text('dedupe_key'),
    createdByType: taskCreatedByType('created_by_type').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** The brand's Cairo day of `createdAt`, stamped by trigger `ssd_stamp_operating_day`; never passed by a writer. */
    operatingDay: date('operating_day').notNull(),
  },
  (t) => [
    // External hats never own a task (spec 0008 AC-17).
    check(
      'tasks_owner_hat_internal',
      sql`${t.ownerHat} IS NULL OR ${t.ownerHat} IN ('support', 'operations', 'warehouse', 'manager')`,
    ),
    // A person or an internal hat always holds the task (AC-26).
    check('tasks_has_owner', sql`${t.ownerUserId} IS NOT NULL OR ${t.ownerHat} IS NOT NULL`),
    check('tasks_outcome_when_done', sql`(${t.status} = 'done') = (${t.outcomeCode} IS NOT NULL)`),
    // A done or cancelled task records when it closed; an open one has not closed.
    check('tasks_closed_at_when_closed', sql`(${t.status} = 'open') = (${t.closedAt} IS NULL)`),
    check('tasks_closed_by_when_closed', sql`${t.closedBy} IS NULL OR ${t.status} <> 'open'`),
    check(
      'tasks_person_has_creator',
      sql`${t.createdByType} <> 'person' OR ${t.createdBy} IS NOT NULL`,
    ),
    check('tasks_type_shape', reasonCodeShape(t.type)),
    check('tasks_outcome_code_shape', reasonCodeShape(t.outcomeCode)),
    // A key is built from ids, never from a phone or a name (security review n4).
    check(
      'tasks_dedupe_key_shape',
      sql`${t.dedupeKey} IS NULL OR ${t.dedupeKey} ~ '^[A-Za-z0-9:_.-]{1,200}$'`,
    ),
    uniqueIndex('tasks_open_dedupe_key_unique')
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.status} = 'open'`),
    // My work for a person.
    index('tasks_open_owner_user_idx')
      .on(t.ownerUserId, t.dueAt)
      .where(sql`${t.status} = 'open'`),
    // My work for a hat: unassigned open tasks in its queue.
    index('tasks_open_owner_hat_idx')
      .on(t.ownerHat, t.dueAt)
      .where(sql`${t.status} = 'open' AND ${t.ownerUserId} IS NULL`),
    index('tasks_linked_idx').on(t.linkedType, t.linkedId),
    index('tasks_operating_day_idx').on(t.operatingDay),
    index('tasks_owner_user_idx').on(t.ownerUserId),
    index('tasks_created_by_idx').on(t.createdBy),
    index('tasks_closed_by_idx').on(t.closedBy),
  ],
);
