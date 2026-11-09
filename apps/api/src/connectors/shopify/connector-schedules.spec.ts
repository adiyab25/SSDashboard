import type { Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { stampJobData } from '../../platform/jobs/job-declarations.js';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { ModuleRegistry } from '../../platform/modules/module-registry.js';
import type { InboxPurgeJob } from '../inbox/inbox-purge.job.js';
import type { BackfillJob } from './backfill.job.js';
import type { ConnectJob } from './connect.job.js';
import {
  CONNECTOR_SCHEDULES,
  CONNECTOR_SHOPIFY_QUEUE,
  CONNECTORS_INBOX_CAPABILITY,
} from './connector-shopify.queue.js';
import { ConnectorShopifyWorker } from './connector-shopify.worker.js';
import type { GatewayScanJob } from './gateway-scan.job.js';
import type { HourlyCheckJob } from './hourly-check.job.js';
import type { InboxJob } from './inbox.job.js';
import type { SweepJob } from './sweep.job.js';

/** The worker with stub jobs, declared into a real `JobRegistry` over the real module registry. */
function declared() {
  const jobs = new JobRegistry(new ModuleRegistry());
  const purge = { run: vi.fn().mockResolvedValue({ inboundEvents: 0 }) };
  const sweeps = { tick: vi.fn().mockResolvedValue({ connections: 0 }) };
  const worker = new ConnectorShopifyWorker(
    jobs,
    {} as ConnectJob,
    {} as InboxJob,
    sweeps as unknown as SweepJob,
    { tick: vi.fn().mockResolvedValue({ connections: 0 }) } as unknown as HourlyCheckJob,
    {} as GatewayScanJob,
    {} as BackfillJob,
    purge as unknown as InboxPurgeJob,
  );
  worker.onModuleInit();
  return { jobs, purge, sweeps };
}

const job = (data: object) => ({ id: 'job-1', data, retryCount: 0 }) as unknown as Job<object>;

// Spec 0015 task 12 and *Settings requested from feature 9*, jobs row; spec 0009 *Connector jobs
// and the shared queue* (AC-10): every connector-shopify schedule is declared through the
// JobRegistry with its own key and capability, no stock schedule yet.
describe('the connector-shopify schedules', () => {
  it('declares exactly the four task 12 schedules, each with its own key, capability, and cron', () => {
    const { jobs } = declared();
    expect(
      jobs.schedulesOf(CONNECTOR_SHOPIFY_QUEUE.name).map((s) => [s.key, s.capability, s.cron]),
    ).toEqual([
      ['shopify-orders-sweep', 'connectors.shopify.sync', '*/5 * * * *'],
      ['shopify-products-sweep', 'connectors.shopify.sync', '*/30 * * * *'],
      ['shopify-hourly-check', 'connectors.shopify.sync', '0 * * * *'],
      ['connector-inbox-purge', 'connectors.inbox', '0 4 * * *'],
    ]);
    expect(new Set(CONNECTOR_SCHEDULES.map((s) => s.key)).size).toBe(CONNECTOR_SCHEDULES.length);
  });

  it('starts every scheduled job with its kind; the supervisor stamps data.capability', () => {
    const { jobs } = declared();
    for (const schedule of jobs.schedulesOf(CONNECTOR_SHOPIFY_QUEUE.name)) {
      expect(schedule.queue).toBe(CONNECTOR_SHOPIFY_QUEUE.name);
      expect(typeof schedule.data?.['kind']).toBe('string');
      expect(schedule.step).toBeUndefined();
      // What the supervisor sends for the schedule (`stampJobData`): the kind and the capability.
      expect(stampJobData(schedule.data, schedule.capability)).toEqual({
        kind: schedule.data?.['kind'],
        capability: schedule.capability,
      });
    }
  });

  it('declares no stock schedule before milestone 3', () => {
    const keys = CONNECTOR_SCHEDULES.map((s) => s.key);
    expect(keys).not.toContain('shopify-stock-push');
    expect(keys).not.toContain('shopify-stock-reconcile');
  });

  it('owns the queue under connectors.shopify.sync and runs one handler per capability', async () => {
    const { jobs, purge, sweeps } = declared();
    expect(jobs.queue(CONNECTOR_SHOPIFY_QUEUE.name)?.capability).toBe('connectors.shopify.sync');
    const sync = jobs.handlerFor(CONNECTOR_SHOPIFY_QUEUE.name, 'connectors.shopify.sync');
    const inbox = jobs.handlerFor(CONNECTOR_SHOPIFY_QUEUE.name, CONNECTORS_INBOX_CAPABILITY);
    expect(sync).toBeDefined();
    expect(inbox).toBeDefined();

    // The purge runs only under connectors.inbox; the sync handler refuses it, and the inbox
    // handler refuses every other kind.
    expect(await sync?.handle(job({ kind: 'inbox_purge' }), { before: null })).toEqual({
      skipped: 'WRONG_CAPABILITY',
    });
    expect(await inbox?.handle(job({ kind: 'orders_sweep_tick' }), { before: null })).toEqual({
      skipped: 'INVALID_JOB_DATA',
    });
    expect(purge.run).not.toHaveBeenCalled();
    await inbox?.handle(job({ kind: 'inbox_purge', capability: 'connectors.inbox' }), {
      before: null,
    });
    expect(purge.run).toHaveBeenCalledOnce();
    await sync?.handle(job({ kind: 'orders_sweep_tick' }), { before: null });
    expect(sweeps.tick).toHaveBeenCalledWith('orders');
  });
});
