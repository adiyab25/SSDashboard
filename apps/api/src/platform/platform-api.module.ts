import { Global, Module } from '@nestjs/common';
import { ReconcileModulesProducer } from './settings/reconcile-modules.queue.js';

/**
 * The api process's half of platform: the send only client that enqueues the
 * `platform.reconcile_modules` job inside each settings write (spec 0009, AC-3). Only the
 * `AppModule` imports it, so the worker, which never writes a setting, never opens that client's
 * connections (review R16). Global so `SettingsService` in `PlatformModule` can take it; never
 * import it into the worker.
 */
@Global()
@Module({
  providers: [ReconcileModulesProducer],
  exports: [ReconcileModulesProducer],
})
export class PlatformApiModule {}
