import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { ModuleRegistry } from '../../platform/modules/module-registry.js';
import {
  RECONCILE_EXPIRY_SECONDS,
  RECONCILE_QUEUE,
  RECONCILE_SCHEDULE_KEY,
  ReconcileJob,
} from './reconcile.job.js';
import type { ReconciliationService } from './reconciliation.service.js';

const env = { LEDGER_RECONCILE_CRON: '30 3 * * *' } as Env;

function makeJob(found = 0) {
  const reconcile = vi.fn().mockResolvedValue(found);
  const jobs = new JobRegistry(new ModuleRegistry());
  const job = new ReconcileJob(env, jobs, { reconcile } as unknown as ReconciliationService);
  return { job, reconcile, jobs };
}

// Spec 0002, AC-11: the nightly reconciliation runs in the worker on LEDGER_RECONCILE_CRON; spec
// 0009, AC-10: declared through the JobRegistry with the capability inventory.reconcile.
describe('ReconcileJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  it('declares one reconciliation at a time on LEDGER_RECONCILE_CRON (covers: AC-11)', () => {
    const { job, jobs } = makeJob();
    job.onModuleInit();

    expect(jobs.queue(RECONCILE_QUEUE)).toEqual({
      name: RECONCILE_QUEUE,
      capability: 'inventory.reconcile',
      options: { policy: 'singleton', expireInSeconds: RECONCILE_EXPIRY_SECONDS },
    });
    expect(jobs.schedulesOf(RECONCILE_QUEUE)).toEqual([
      {
        queue: RECONCILE_QUEUE,
        key: RECONCILE_SCHEDULE_KEY,
        capability: 'inventory.reconcile',
        cron: '30 3 * * *',
      },
    ]);
  });

  it('reconciles when a job arrives and returns how many it found (covers: AC-11)', async () => {
    const { job, jobs, reconcile } = makeJob(3);
    job.onModuleInit();
    const handler = jobs.handlerFor(RECONCILE_QUEUE, 'inventory.reconcile');

    const output = await handler?.handle({ id: 'j', data: {} } as never, { before: null });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(output).toEqual({ found: 3 });
  });
});
