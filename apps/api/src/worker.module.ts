import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ReconcileJob } from './inventory/ledger/reconcile.job.js';
import { PlatformModule } from './platform/platform.module.js';

/** The `worker` entry point's modules: no HTTP, only scheduled and queued jobs. */
@Module({
  imports: [ConfigModule, DatabaseModule, PlatformModule, InventoryModule],
  providers: [ReconcileJob],
})
export class WorkerModule {}
