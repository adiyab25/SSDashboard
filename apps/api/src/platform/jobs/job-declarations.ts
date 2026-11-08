import type { Job, Queue, WorkOptions } from 'pg-boss';

/**
 * One pg-boss queue and the capability that owns it (spec 0009, AC-10). A queue serving several
 * capabilities (a shared queue, such as spec 0015's `connector-shopify`) is owned by one of them;
 * the others' jobs carry `data.capability` and their schedules their own `key`. The supervisor
 * stops the queue's workers only when its owner stops. `ownerHandlesAll` lets the owner's handler
 * take a job of any capability (the platform's backfill queue); the gate still checks the job's
 * own capability.
 */
export interface QueueDeclaration {
  readonly name: string;
  readonly capability: string;
  readonly options: Omit<Queue, 'name'>;
  readonly work?: WorkOptions;
  readonly ownerHandlesAll?: boolean;
}

/** Declares a queue constant, freezing it. Every queue of the api and worker is one of these. */
export function defineQueue(declaration: QueueDeclaration): QueueDeclaration {
  return Object.freeze({ ...declaration, options: Object.freeze({ ...declaration.options }) });
}

/** What a handler learns from the gate: `before` when its capability is `limited`, else null. */
export interface JobGate {
  /** A `limited` handler works only on records opened before this instant (AC-10). */
  readonly before: string | null;
}

/**
 * The work of one capability's jobs on a queue (and of one step, when declared with it). Its
 * return value becomes the job's output. It runs only after the gate found the capability (and
 * the step) runnable; a stopped one's job completes with `{ skipped: 'MODULE_OFF' }` or
 * `{ skipped: 'STEP_OFF' }` without calling it.
 */
export interface JobHandlerDeclaration {
  readonly queue: string;
  readonly capability: string;
  readonly handle: (job: Job<object>, gate: JobGate) => Promise<object | undefined>;
}

/**
 * One cron schedule on a queue (AC-10, AC-22): its own `key`, the capability (and optional
 * step) it serves, the cron, and the data each job starts with. The supervisor registers it in
 * the current `timezone` setting while its capability (and step) is runnable, and removes it
 * otherwise.
 */
export interface ScheduleDeclaration {
  readonly queue: string;
  readonly key: string;
  readonly capability: string;
  readonly step?: string;
  readonly cron: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The data a job starts with, stamped with its capability and step (AC-10). */
export function stampJobData(
  data: object | null | undefined,
  capability: string,
  step?: string,
): Record<string, unknown> {
  return { ...(data ?? {}), capability, ...(step !== undefined && { step }) };
}
