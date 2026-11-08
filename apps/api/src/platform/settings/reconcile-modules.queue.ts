import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import type { Transaction } from '../../database/sql.js';
import { defineQueue } from '../jobs/job-declarations.js';
import { JobSender } from '../jobs/job-sender.js';

/**
 * The queue of the job that brings module jobs and schedules in line with the settings (spec
 * 0009, AC-3, AC-12), owned by the core capability `platform.reconcile_modules`. Every settings
 * write enqueues one in its own transaction; the worker's `ModuleJobSupervisor` works it.
 * `short`: at most one plain job waits, so a burst of changes queues one reconcile, not one per
 * change (a second send while one waits is refused by pg-boss and returns null, which is fine). A
 * job that carries a resumed module's gap has its own singleton key, so it is never folded away.
 */
export const RECONCILE_MODULES_JOB = defineQueue({
  name: 'platform.reconcile_modules',
  capability: 'platform.reconcile_modules',
  options: { policy: 'short', retryLimit: 2 },
});

/** The queue name, for tests and logs. */
export const RECONCILE_MODULES_QUEUE = RECONCILE_MODULES_JOB.name;

/**
 * A module turned back on and the gap it was off for (AC-11): `key` is its toggle setting,
 * `from` the instant of the write that turned it off, `to` that of the write that turned it on.
 */
export const ResumedGap = z.object({
  key: z.string(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});
/** One resumed gap. */
export type ResumedGap = z.infer<typeof ResumedGap>;

/** The data of a reconcile job: optionally the gap of a module turned back on. */
export const ReconcileModulesData = z.object({ resumed: ResumedGap.optional() });

/**
 * Puts the reconcile job on the queue from the api, inside the caller's transaction, through the
 * api's one send only pg-boss client (`JobSender`): the job exists if and only if the settings
 * change commits. The client and the queue are made ready at bootstrap (5 second connect
 * timeout), so the first write never starts pg-boss while it holds a settings row lock (security
 * review S5); a start that fails is logged and tried again by the next write. Unlike the mail
 * producer it never swallows an enqueue error: a failed enqueue rolls the change back.
 */
@Injectable()
export class ReconcileModulesProducer implements OnApplicationBootstrap {
  private readonly logger = new Logger('ReconcileModules');

  /** Takes the process's job sender. */
  constructor(@Inject(JobSender) private readonly jobs: JobSender) {}

  /** Makes the client and the queue ready before the first request; a failure is only logged. */
  async onApplicationBootstrap(): Promise<void> {
    await this.jobs
      .prepare(RECONCILE_MODULES_JOB)
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not start the reconcile queue client: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /** Enqueues one reconcile job through `tx`, with a resumed module's gap when given. */
  async enqueueIn(tx: Transaction, resumed?: ResumedGap): Promise<void> {
    await this.jobs.sendIn(
      tx,
      RECONCILE_MODULES_JOB,
      resumed ? { resumed } : {},
      resumed ? { singletonKey: `resume:${resumed.key}:${resumed.from}` } : {},
    );
  }
}
