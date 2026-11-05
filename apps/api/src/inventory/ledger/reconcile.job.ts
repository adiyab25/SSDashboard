import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { SettingsService } from '../../platform/settings.service.js';
import { ReconciliationService } from './reconciliation.service.js';

/** The pg-boss queue that carries the nightly reconciliation job. */
export const RECONCILE_QUEUE = 'ledger.reconcile';
/** How long a reconciliation run may take (one hour) before pg-boss lets another start. */
export const RECONCILE_EXPIRY_SECONDS = 3_600;

/** pg-boss keeps its tables in this schema, created by migration and owned by the app role. */
export const JOB_SCHEMA = 'pgboss';

/** Runs the nightly ledger reconciliation in the `worker` entry point (spec 0002, AC-11). */
@Injectable()
export class ReconcileJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('LedgerReconcile');
  private boss: PgBoss | undefined;

  /**
   * Takes the env for the database URL and cron, the settings for the time zone, and the
   * reconciliation service that does the work.
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  /**
   * Starts the queue, registers the nightly schedule in the install's timezone, and starts the
   * handler. Runs only in the `worker` entry point.
   */
  async onApplicationBootstrap(): Promise<void> {
    const boss = new PgBoss({
      connectionString: this.env.DATABASE_URL,
      schema: JOB_SCHEMA,
      // The application role cannot create schemas; the migration made this one for it.
      createSchema: false,
    });
    boss.on('error', (error: Error) =>
      this.logger.error(`Job queue error: ${error.message}`, error.stack),
    );
    await boss.start();
    this.boss = boss;
    // One run at a time: two overlapping runs would race to record the same discrepancy.
    // An hour before expiry, so a slow run on a large ledger is not retried while it runs.
    await boss.createQueue(RECONCILE_QUEUE, {
      policy: 'singleton',
      expireInSeconds: RECONCILE_EXPIRY_SECONDS,
    });
    // Read once at startup: a change to the timezone setting applies after a worker restart.
    const { timezone } = await this.settings.read(['timezone']);
    await boss.schedule(RECONCILE_QUEUE, this.env.LEDGER_RECONCILE_CRON, null, { tz: timezone });
    await boss.work(RECONCILE_QUEUE, async () => {
      const found = await this.reconciliation.reconcile();
      console.log(`Ledger reconciliation: ${found} discrepancies found.`);
      return { found };
    });
  }

  /** Stops the queue after letting a run in progress finish. */
  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
