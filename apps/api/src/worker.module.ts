import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from './config/config.module.js';
import { ConnectorsWorkerModule } from './connectors/connectors-worker.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthCleanupJob } from './identity/sign-in/auth-cleanup.job.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ReconcileJob } from './inventory/ledger/reconcile.job.js';
import { MailWorkerModule } from './mail/mail.module.js';
import { OrdersWorkerModule } from './orders/orders-worker.module.js';
import { JobsModule } from './platform/jobs/jobs.module.js';
import {
  LicenseCheckJob,
  PHASE_WATCH_CRON,
  PHASE_WATCH_CRON_TOKEN,
} from './platform/license/license-check.job.js';
import { PlatformModule } from './platform/platform.module.js';
import { TasksModule } from './tasks/tasks.module.js';

/**
 * The `worker` entry point's modules: no HTTP, only scheduled and queued jobs.
 * `JobsModule.forWorker()` gives it one pg-boss client, the `JobRegistry` every job here declares its queue,
 * handler, and schedule into (each with its capability), and the `ModuleJobSupervisor` that keeps
 * them in line with the module states (spec 0009, AC-10). `PlatformModule` also gives the worker
 * its settings cache and the `LISTEN` connection that keeps it fresh, and `LicenseCheckJob` checks
 * the license at worker start and daily. `ConnectorsWorkerModule` runs the Shopify jobs of the
 * `connector-shopify` queue (spec 0015: the connect check and the inbox job, which loads the orders module), and `OrdersWorkerModule` the `orders.post_shipment`
 * jobs (spec 0013 task 15: the shipment posting and the after cancel job). The event emitter carries
 * `LicenseChanged` inside the worker.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule,
    DatabaseModule,
    PlatformModule,
    JobsModule.forWorker(),
    InventoryModule,
    MailWorkerModule,
    ConnectorsWorkerModule,
    OrdersWorkerModule,
    TasksModule,
  ],
  providers: [
    ReconcileJob,
    AuthCleanupJob,
    LicenseCheckJob,
    { provide: PHASE_WATCH_CRON_TOKEN, useValue: PHASE_WATCH_CRON },
  ],
})
export class WorkerModule {}
