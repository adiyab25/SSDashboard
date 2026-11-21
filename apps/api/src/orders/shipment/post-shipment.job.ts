import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import {
  AWAITING_RESTOCK_OVERDUE_CRON,
  AWAITING_RESTOCK_OVERDUE_SCHEDULE,
  POST_SHIPMENT_QUEUE,
} from './post-shipment.queue.js';
import { ShipmentPosting } from './shipment-posting.js';

/**
 * Declares the `orders.post_shipment` queue and its handler in the `worker` entry point, through
 * the platform `JobRegistry` with the core capability `orders.shipment_posting` (spec 0013
 * *Configuration required*, spec 0009 AC-10), with the daily `orders-awaiting-restock-overdue`
 * schedule (AC-27 g). The `ModuleJobSupervisor` creates the queue, registers the schedule in the
 * install `timezone`, and runs the handler behind the module gate, one job per order at a time
 * (group concurrency 1). The work
 * itself is `ShipmentPosting`'s; this class only declares and dispatches, and never posts or
 * writes anything on its own.
 */
@Injectable()
export class PostShipmentJob implements OnModuleInit {
  /** Takes the worker's job registry and the work of the queue's jobs. */
  constructor(
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
    @Inject(ShipmentPosting) private readonly posting: ShipmentPosting,
  ) {}

  /** Declares the queue, the daily awaiting restock schedule, and the one handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(POST_SHIPMENT_QUEUE);
    this.jobs.declareSchedule({
      queue: POST_SHIPMENT_QUEUE.name,
      key: AWAITING_RESTOCK_OVERDUE_SCHEDULE,
      capability: POST_SHIPMENT_QUEUE.capability,
      cron: AWAITING_RESTOCK_OVERDUE_CRON,
      data: { kind: 'awaiting_restock_overdue' },
    });
    this.jobs.declareHandler({
      queue: POST_SHIPMENT_QUEUE.name,
      capability: POST_SHIPMENT_QUEUE.capability,
      handle: (job) => this.posting.run(job),
    });
  }
}
