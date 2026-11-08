import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { defineQueue } from '../../platform/jobs/job-declarations.js';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { ReconciliationService } from './reconciliation.service.js';

/** How long a reconciliation run may take (one hour) before pg-boss lets another start. */
export const RECONCILE_EXPIRY_SECONDS = 3_600;

/**
 * The queue of the nightly reconciliation, owned by the core capability `inventory.reconcile`
 * (spec 0009, *Module registry*). One run at a time (`singleton`): two overlapping runs would race
 * to record the same discrepancy. An hour before expiry, so a slow run on a large ledger is not
 * retried while it runs.
 */
export const RECONCILE_JOB = defineQueue({
  name: 'ledger.reconcile',
  capability: 'inventory.reconcile',
  options: { policy: 'singleton', expireInSeconds: RECONCILE_EXPIRY_SECONDS },
});

/** The pg-boss queue that carries the nightly reconciliation job. */
export const RECONCILE_QUEUE = RECONCILE_JOB.name;

/** The key of its nightly schedule. */
export const RECONCILE_SCHEDULE_KEY = 'nightly';

/**
 * Declares the nightly ledger reconciliation (spec 0002, AC-11) in the `worker` entry point: its
 * queue, its schedule on `LEDGER_RECONCILE_CRON`, and its handler, through the platform
 * `JobRegistry` (spec 0009, AC-10). The `ModuleJobSupervisor` creates the queue, registers the
 * schedule in the current `timezone` setting (again after every change of it), and runs the
 * handler behind the module gate.
 */
@Injectable()
export class ReconcileJob implements OnModuleInit {
  private readonly logger = new Logger('LedgerReconcile');

  /** Takes the env for the cron, the job registry, and the reconciliation service that does the work. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  /** Declares the queue, the nightly schedule, and the handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(RECONCILE_JOB);
    this.jobs.declareSchedule({
      queue: RECONCILE_QUEUE,
      key: RECONCILE_SCHEDULE_KEY,
      capability: RECONCILE_JOB.capability,
      cron: this.env.LEDGER_RECONCILE_CRON,
    });
    this.jobs.declareHandler({
      queue: RECONCILE_QUEUE,
      capability: RECONCILE_JOB.capability,
      handle: () => this.run(),
    });
  }

  /** Reconciles once and returns how many discrepancies it found. */
  async run(): Promise<{ found: number }> {
    const found = await this.reconciliation.reconcile();
    this.logger.log(`Ledger reconciliation: ${found} discrepancies found.`);
    return { found };
  }
}
