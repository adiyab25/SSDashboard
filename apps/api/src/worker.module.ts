import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthCleanupJob } from './identity/sign-in/auth-cleanup.job.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ReconcileJob } from './inventory/ledger/reconcile.job.js';
import { MailWorkerModule } from './mail/mail.module.js';
import { JobsModule } from './platform/jobs/jobs.module.js';
import { LicenseCheckJob } from './platform/license/license-check.job.js';
import { PlatformModule } from './platform/platform.module.js';

/**
 * The `worker` entry point's modules: no HTTP, only scheduled and queued jobs.
 * `JobsModule.forWorker()` gives it one pg-boss client, the `JobRegistry` every job here declares its queue,
 * handler, and schedule into (each with its capability), and the `ModuleJobSupervisor` that keeps
 * them in line with the module states (spec 0009, AC-10). `PlatformModule` also gives the worker
 * its settings cache and the `LISTEN` connection that keeps it fresh, and `LicenseCheckJob` checks
 * the license at worker start and daily. The event emitter carries `LicenseChanged` inside the
 * worker.
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
  ],
  providers: [ReconcileJob, AuthCleanupJob, LicenseCheckJob],
})
export class WorkerModule {}
