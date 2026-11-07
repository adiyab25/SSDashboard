import { Global, Module } from '@nestjs/common';
import { LicenseStartCheck } from './license/license-start-check.js';
import { PlatformModule } from './platform.module.js';
import { ReconcileModulesProducer } from './settings/reconcile-modules.queue.js';

/**
 * The api process's half of platform: the send only client that enqueues the
 * `platform.reconcile_modules` job inside each settings write (spec 0009, AC-3), and the license
 * check at api start (AC-14). Only the `AppModule` imports it, so the worker, which never writes a
 * setting, never opens that client's connections (review R16) and runs its own start check.
 * Global so `SettingsService` in `PlatformModule` can take the producer; never import it into the
 * worker.
 */
@Global()
@Module({
  imports: [PlatformModule],
  providers: [ReconcileModulesProducer, LicenseStartCheck],
  exports: [ReconcileModulesProducer],
})
export class PlatformApiModule {}
