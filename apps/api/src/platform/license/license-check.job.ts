import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV } from '../../config/config.module.js';
import { describeError } from '../../database/pg-error.js';
import type { Env } from '../../config/env.js';
import { defineQueue } from '../jobs/job-declarations.js';
import { JobRegistry } from '../jobs/job-registry.js';
import { LicenseService } from './license.service.js';

/** How long one check may take before pg-boss lets another start. */
export const LICENSE_CHECK_EXPIRY_SECONDS = 300;

/** The queue of the daily license check, owned by the core capability `platform.license_check`. */
export const LICENSE_CHECK_JOB = defineQueue({
  name: 'platform.license_check',
  capability: 'platform.license_check',
  options: { policy: 'singleton', expireInSeconds: LICENSE_CHECK_EXPIRY_SECONDS },
});

/** The pg-boss queue of the daily license check. */
export const LICENSE_CHECK_QUEUE = LICENSE_CHECK_JOB.name;

/** The key of its daily schedule. */
export const LICENSE_CHECK_SCHEDULE_KEY = 'daily';

/** The key of the phase watch schedule. */
export const PHASE_WATCH_SCHEDULE_KEY = 'phase-watch';

/**
 * How often the phase watch runs (spec 0009, AC-18): a check is recorded within this long of the
 * lapse instant, of the wind down's end by its length, and of its early end, so the supervisor
 * follows within minutes.
 */
export const PHASE_WATCH_CRON = '*/5 * * * *';

/**
 * The injection token of the phase watch's cron: `PHASE_WATCH_CRON` in the worker. A suite that
 * moves a fixed platform clock overrides it with a cron that never fires during the run, so no wall
 * clock boundary records a check in the middle of a case.
 */
export const PHASE_WATCH_CRON_TOKEN = Symbol('PHASE_WATCH_CRON');

/** The data the phase watch's jobs carry, telling them from the daily check. */
const PHASE_WATCH_DATA = { kind: 'phase_watch' } as const;

/**
 * The worker's license checks (spec 0009, AC-14): one at worker start, then daily at
 * `LICENSE_CHECK_CRON`, and the phase watch every 5 minutes (`PHASE_WATCH_CRON`, AC-18), which
 * records a check only when the phase a check would record differs from the latest recorded one
 * (`LicenseService.checkIfMoved`). Both are declared through the platform `JobRegistry` (AC-10),
 * whose supervisor registers the schedules in the current `timezone` setting and re registers them
 * when the setting changes. A failed check is logged; the worker keeps running (AC-16).
 */
@Injectable()
export class LicenseCheckJob implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('License');

  /** Takes the env (cron), the job registry, and the license service. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(LicenseService) private readonly license: LicenseService,
    @Optional()
    @Inject(PHASE_WATCH_CRON_TOKEN)
    private readonly watchCron: string = PHASE_WATCH_CRON,
  ) {}

  /** Declares the queue, the daily schedule, and the handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(LICENSE_CHECK_JOB);
    this.jobs.declareSchedule({
      queue: LICENSE_CHECK_QUEUE,
      key: LICENSE_CHECK_SCHEDULE_KEY,
      capability: LICENSE_CHECK_JOB.capability,
      cron: this.env.LICENSE_CHECK_CRON,
    });
    this.jobs.declareSchedule({
      queue: LICENSE_CHECK_QUEUE,
      key: PHASE_WATCH_SCHEDULE_KEY,
      capability: LICENSE_CHECK_JOB.capability,
      cron: this.watchCron,
      data: PHASE_WATCH_DATA,
    });
    this.jobs.declareHandler({
      queue: LICENSE_CHECK_QUEUE,
      capability: LICENSE_CHECK_JOB.capability,
      handle: (job) =>
        (job.data as { kind?: unknown } | null)?.kind === PHASE_WATCH_DATA.kind
          ? this.watch(job.id)
          : this.daily(job.id),
    });
  }

  /** The phase watch of the pg-boss job `jobId`: a check only when a phase moved. */
  async watch(jobId: string): Promise<{ moved: boolean }> {
    try {
      return { moved: (await this.license.checkIfMoved(jobId)) !== null };
    } catch (error) {
      this.logger.error(`The license phase watch failed: ${describeError(error)}`);
      throw new Error('The license phase watch failed');
    }
  }

  /** Runs the `worker_start` check; never throws. */
  async onApplicationBootstrap(): Promise<void> {
    await this.license.checkFile('worker_start').catch((error: unknown) =>
      // Through describeError: a failed query's message carries its params (security M2-5).
      this.logger.error(`The license check at worker start failed: ${describeError(error)}`),
    );
  }

  /** The daily check of the pg-boss job `jobId`; its output is the outcome and both phases. */
  async daily(jobId: string): Promise<{ outcome: string; operations: string; warehouse: string }> {
    try {
      const result = await this.license.checkFile('daily', jobId);
      return {
        outcome: result.outcome,
        operations: result.operations,
        warehouse: result.warehouse,
      };
    } catch (error) {
      // Logged safely here; pg-boss keeps only this plain error on the job, never the query's
      // params a failed query's own message carries (security M2-5).
      this.logger.error(`The daily license check failed: ${describeError(error)}`);
      throw new Error('The daily license check failed');
    }
  }
}
