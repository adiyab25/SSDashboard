import {
  Inject,
  Injectable,
  Logger,
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

/**
 * The worker's license checks (spec 0009, AC-14): one at worker start, then daily at
 * `LICENSE_CHECK_CRON`, declared through the platform `JobRegistry` (AC-10), whose supervisor
 * registers the schedule in the current `timezone` setting and re registers it when the setting
 * changes. A failed check is logged; the worker keeps running (AC-16).
 */
@Injectable()
export class LicenseCheckJob implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('License');

  /** Takes the env (cron), the job registry, and the license service. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(LicenseService) private readonly license: LicenseService,
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
    this.jobs.declareHandler({
      queue: LICENSE_CHECK_QUEUE,
      capability: LICENSE_CHECK_JOB.capability,
      handle: (job) => this.daily(job.id),
    });
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
