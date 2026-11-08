import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { ConnectJob, type ConnectOutcome } from './connect.job.js';
import { CONNECTOR_SHOPIFY_QUEUE, ShopifyJobData } from './connector-shopify.queue.js';
import { InboxJob, type InboxOutcome } from './inbox.job.js';

/**
 * The worker side of the `connector-shopify` queue (spec 0015 Inbound processing item 2): declares
 * the queue and its one handler through `JobRegistry`, and runs each job by its kind: `connect`
 * (`ConnectJob`, task 6) or `inbox` (`InboxJob`, task 7). Later tasks add their kinds to
 * `ShopifyJobData` and a case here. Data it cannot read is skipped, never retried. The inbox job
 * gets the pg-boss `retryCount`, so it knows its last retry (code review M1).
 */
@Injectable()
export class ConnectorShopifyWorker implements OnModuleInit {
  /** Takes the job registry and the jobs it runs. */
  constructor(
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(ConnectJob) private readonly connect: ConnectJob,
    @Inject(InboxJob) private readonly inbox: InboxJob,
  ) {}

  /** Declares the `connector-shopify` queue and its handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(CONNECTOR_SHOPIFY_QUEUE);
    this.jobs.declareHandler({
      queue: CONNECTOR_SHOPIFY_QUEUE.name,
      capability: CONNECTOR_SHOPIFY_QUEUE.capability,
      handle: (job) => this.handle(job),
    });
  }

  /** Runs one job of the queue by its kind. */
  async handle(job: Job<object>): Promise<ConnectOutcome | InboxOutcome> {
    const data = ShopifyJobData.safeParse(job.data);
    if (!data.success) return { skipped: 'INVALID_JOB_DATA' };
    switch (data.data.kind) {
      case 'connect':
        return this.connect.connect(data.data.connectionId);
      case 'inbox':
        return this.inbox.run(data.data, job.id, job.retryCount);
    }
  }
}
