import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { ConfigController } from './config.controller.js';
import { CostRulesService } from './cost-rules.service.js';
import { NumberingService } from './numbering.service.js';
import {
  DEFAULT_LISTENER_RETRY,
  LISTENER_RETRY,
  PlatformChangesListener,
} from './settings/platform-changes-listener.js';
import { SettingsCache } from './settings/settings-cache.js';
import { SettingsController } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';

/**
 * Install wide services other modules use, in the api and the worker alike: settings (with their
 * per process cache and the `LISTEN` connection that keeps it fresh), document numbering, and the
 * per order cost rules. It writes `setting.changed` audit entries through `AuditService` and reads
 * names through the staff directory, never another module's tables. The reconcile job producer a
 * settings write needs comes from `PlatformApiModule`, which only the api imports.
 */
@Module({
  imports: [AuditModule, StaffDirectoryModule],
  controllers: [ConfigController, SettingsController],
  providers: [
    SettingsCache,
    { provide: LISTENER_RETRY, useValue: DEFAULT_LISTENER_RETRY },
    PlatformChangesListener,
    SettingsService,
    NumberingService,
    CostRulesService,
  ],
  exports: [SettingsService, NumberingService, CostRulesService],
})
export class PlatformModule {}
