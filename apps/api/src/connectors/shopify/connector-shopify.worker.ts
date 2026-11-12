import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { InboxPurgeJob } from '../inbox/inbox-purge.job.js';
import { BackfillJob } from './backfill.job.js';
import { ConnectJob } from './connect.job.js';
import {
  CONNECTOR_SCHEDULES,
  CONNECTOR_SHOPIFY_QUEUE,
  CONNECTORS_INBOX_CAPABILITY,
  ShopifyJobData,
} from './connector-shopify.queue.js';
import { GatewayScanJob } from './gateway-scan.job.js';
import { HourlyCheckJob } from './hourly-check.job.js';
import { InboxJob } from './inbox.job.js';
import { SweepJob } from './sweep.job.js';

/**
 * The worker side of the `connector-shopify` queue (spec 0015 Inbound processing item 2; spec
 * 0009 *Connector jobs and the shared queue*): declares, through the worker's `JobRegistry`, the
 * queue (owned by `connectors.shopify.sync`), its four keyed schedules (`CONNECTOR_SCHEDULES`: the
 * orders and products sweeps and the hourly check under `connectors.shopify.sync`, the inbox purge
 * under `connectors.inbox`), and one handler per capability; it never schedules, starts work, or
 * reads the time zone itself (the `ModuleJobSupervisor` does). Each job runs by its kind:
 * `connect` (`ConnectJob`, task 6), `inbox` (`InboxJob`, task 7, with the pg-boss `retryCount`, so
 * it knows its last retry), and task 12's ticks, sweeps, hourly check, gateway scan, backfill, and
 * purge. Data it cannot read, or a kind sent under the other capability, is skipped, never retried.
 */
@Injectable()
export class ConnectorShopifyWorker implements OnModuleInit {
  /** Takes the job registry and the jobs it runs. */
  constructor(
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(ConnectJob) private readonly connect: ConnectJob,
    @Inject(InboxJob) private readonly inbox: InboxJob,
    @Inject(SweepJob) private readonly sweeps: SweepJob,
    @Inject(HourlyCheckJob) private readonly hourly: HourlyCheckJob,
    @Inject(GatewayScanJob) private readonly gatewayScan: GatewayScanJob,
    @Inject(BackfillJob) private readonly backfill: BackfillJob,
    @Inject(InboxPurgeJob) private readonly purge: InboxPurgeJob,
  ) {}

  /** Declares the `connector-shopify` queue, its schedules, and its two handlers. */
  onModuleInit(): void {
    this.jobs.declareQueue(CONNECTOR_SHOPIFY_QUEUE);
    for (const schedule of CONNECTOR_SCHEDULES) {
      this.jobs.declareSchedule({ queue: CONNECTOR_SHOPIFY_QUEUE.name, ...schedule });
    }
    this.jobs.declareHandler({
      queue: CONNECTOR_SHOPIFY_QUEUE.name,
      capability: CONNECTOR_SHOPIFY_QUEUE.capability,
      handle: (job) => this.handle(job),
    });
    this.jobs.declareHandler({
      queue: CONNECTOR_SHOPIFY_QUEUE.name,
      capability: CONNECTORS_INBOX_CAPABILITY,
      handle: (job) => this.handleInbox(job),
    });
  }

  /** Runs one `connectors.shopify.sync` job by its kind. */
  async handle(job: Job<object>): Promise<object> {
    const data = ShopifyJobData.safeParse(job.data);
    if (!data.success) return { skipped: 'INVALID_JOB_DATA' };
    const work = data.data;
    switch (work.kind) {
      case 'connect':
        return this.connect.connect(work.connectionId);
      case 'inbox':
        return this.inbox.run(work, job.id, job.retryCount);
      case 'orders_sweep_tick':
        return this.sweeps.tick('orders');
      case 'products_sweep_tick':
        return this.sweeps.tick('products');
      case 'hourly_check_tick':
        return this.hourly.tick();
      case 'sweep_orders':
        return this.sweeps.sweep('orders', work);
      case 'sweep_products':
        return this.sweeps.sweep('products', work);
      case 'hourly_check':
        return this.hourly.check(work.connectionId, job.id);
      case 'gateway_scan':
        return this.gatewayScan.run(work, job.retryCount);
      case 'backfill':
        return this.backfill.run(work, job.id, job.retryCount);
      case 'inbox_purge':
        return { skipped: 'WRONG_CAPABILITY' };
    }
  }

  /** Runs one `connectors.inbox` job: the purge only. */
  async handleInbox(job: Job<object>): Promise<object> {
    const data = ShopifyJobData.safeParse(job.data);
    if (!data.success || data.data.kind !== 'inbox_purge') return { skipped: 'INVALID_JOB_DATA' };
    return this.purge.run();
  }
}
