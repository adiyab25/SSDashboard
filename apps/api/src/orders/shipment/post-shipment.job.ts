import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { POST_SHIPMENT_QUEUE } from './post-shipment.queue.js';
import { ShipmentPosting } from './shipment-posting.js';

/**
 * Declares the `orders.post_shipment` queue and its handler in the `worker` entry point, through
 * the platform `JobRegistry` with the core capability `orders.shipment_posting` (spec 0013
 * *Configuration required*, spec 0009 AC-10). The `ModuleJobSupervisor` creates the queue and runs
 * the handler behind the module gate, one job per order at a time (group concurrency 1). The work
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

  /** Declares the queue and its one handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(POST_SHIPMENT_QUEUE);
    this.jobs.declareHandler({
      queue: POST_SHIPMENT_QUEUE.name,
      capability: POST_SHIPMENT_QUEUE.capability,
      handle: (job) => this.posting.run(job),
    });
  }
}
