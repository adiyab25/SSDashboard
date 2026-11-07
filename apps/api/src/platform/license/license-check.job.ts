import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV } from '../../config/config.module.js';
import { describeError } from '../../database/pg-error.js';
import type { Env } from '../../config/env.js';
import { JOB_SCHEMA } from '../job-schema.js';
import { SettingsService } from '../settings/settings.service.js';
import { LicenseService } from './license.service.js';

/** The pg-boss queue of the daily license check. */
export const LICENSE_CHECK_QUEUE = 'platform.license_check';
/** How long one check may take before pg-boss lets another start. */
export const LICENSE_CHECK_EXPIRY_SECONDS = 300;

/**
 * The worker's license checks (spec 0009, AC-14): one at worker start, then daily at
 * `LICENSE_CHECK_CRON` in the `timezone` setting. Scheduled the way `ReconcileJob` and
 * `AuthCleanupJob` are (its own pg-boss client, the time zone read once at start) until spec 0009
 * milestone 3 moves every queue onto `JobRegistry`. A failed check is logged; the worker keeps
 * running (AC-16).
 */
@Injectable()
export class LicenseCheckJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('License');
  private boss: PgBoss | undefined;

  /** Takes the env (database URL, cron), the settings (time zone), and the license service. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(LicenseService) private readonly license: LicenseService,
  ) {}

  /** Runs the `worker_start` check, then schedules the daily one and starts its handler. */
  async onApplicationBootstrap(): Promise<void> {
    await this.license.checkFile('worker_start').catch((error: unknown) =>
      // Through describeError: a failed query's message carries its params (security M2-5).
      this.logger.error(`The license check at worker start failed: ${describeError(error)}`),
    );
    const boss = new PgBoss({
      connectionString: this.env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
      // One short check a day; the default pool of 10 would be wasted connections.
      max: 2,
    });
    boss.on('error', (error: Error) => this.logger.error(`Job queue error: ${error.message}`));
    await boss.start();
    this.boss = boss;
    await boss.createQueue(LICENSE_CHECK_QUEUE, {
      policy: 'singleton',
      expireInSeconds: LICENSE_CHECK_EXPIRY_SECONDS,
    });
    // Read once at startup: a change to the timezone setting applies after a worker restart
    // (milestone 3's supervisor re registers schedules in the current zone).
    const { timezone } = await this.settings.read(['timezone']);
    await boss.schedule(LICENSE_CHECK_QUEUE, this.env.LICENSE_CHECK_CRON, null, { tz: timezone });
    await boss.work(LICENSE_CHECK_QUEUE, async ([job]) => {
      try {
        const result = await this.license.checkFile('daily', job?.id);
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
    });
  }

  /** Stops the queue after letting a check in progress finish. */
  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
