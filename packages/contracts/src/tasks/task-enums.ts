import { z } from 'zod';

/** The task primitive's closed lists, matching the `tasks` database enums (spec 0002 customers, credit, and tasks). */

/** Where a task stands. Matches `tasks.status`. */
export const TaskStatus = z.enum(['open', 'done', 'cancelled']);
/** One TaskStatus value. */
export type TaskStatus = z.infer<typeof TaskStatus>;

/** The kind of record a task points at (no foreign key). Matches `tasks.linked_type`. */
export const TaskLinkedType = z.enum([
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
/** One TaskLinkedType value. */
export type TaskLinkedType = z.infer<typeof TaskLinkedType>;

/** Who opened a task. Matches `tasks.created_by_type`. */
export const TaskCreatedByType = z.enum(['person', 'system_job']);
/** One TaskCreatedByType value. */
export type TaskCreatedByType = z.infer<typeof TaskCreatedByType>;
