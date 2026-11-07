import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthCleanupJob } from './identity/sign-in/auth-cleanup.job.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ReconcileJob } from './inventory/ledger/reconcile.job.js';
import { MailWorkerModule } from './mail/mail.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { ReconcileModulesWorker } from './platform/settings/reconcile-modules.queue.js';

/**
 * The `worker` entry point's modules: no HTTP, only scheduled and queued jobs. `PlatformModule`
 * also gives the worker its settings cache and the `LISTEN` connection that keeps it fresh.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, PlatformModule, InventoryModule, MailWorkerModule],
  providers: [ReconcileJob, AuthCleanupJob, ReconcileModulesWorker],
})
export class WorkerModule {}
