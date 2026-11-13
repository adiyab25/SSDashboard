import { Module } from '@nestjs/common';
import { MODULE_REGISTRY } from '@ssdashboard/contracts';
import { AuditModule } from '../audit/audit.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { ConfigController } from './config.controller.js';
import { CostRulesController } from './cost-rules.controller.js';
import { CostRulesService } from './cost-rules.service.js';
import { DomainEvents } from './events/domain-events.js';
import { LICENSE_KEY_SET, LICENSE_KEYS } from './license/license-keys.js';
import { LicenseVerifier } from './license/license-verifier.js';
import { LicenseController } from './license/license.controller.js';
import { LicenseService } from './license/license.service.js';
import { PlatformClock } from './license/platform-clock.js';
import { PreLapseItems } from './license/pre-lapse-items.js';
import { CapabilityHooks } from './modules/capability-hooks.js';
import { MODULE_ROWS, ModuleRegistry, STEP_SETTING_ROWS } from './modules/module-registry.js';
import { ModuleStateService } from './modules/module-state.service.js';
import { ModulesController } from './modules/modules.controller.js';
import { OffImpactReader } from './modules/off-impact.js';
import { StepTurnOnCheck } from './modules/step-turn-on.js';
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
 * per process cache and the `LISTEN` connection that keeps it fresh), the license (its verifier
 * with the keys built into the image, the platform clock, and `LicenseService`), document
 * numbering, the per order cost rules, and the module registry with its states and capability
 * hooks (`ModuleStateService`, `CapabilityHooks`; the rows come from `MODULE_ROWS`, which tests may
 * override with fixture modules, and `STEP_SETTING_ROWS`, empty but for a test's fixture step), and `DomainEvents`, the in transaction domain events (its
 * handlers run whatever their owner module's state; see spec 0009's Follow-ups before a toggleable
 * module subscribes). It writes `setting.changed` and `license.added` audit
 * entries through `AuditService` and reads names through the staff directory, never another
 * module's tables. The reconcile job producer a settings write needs, and the license check at api
 * start, come from `PlatformApiModule`, which only the api imports; the worker's license checks
 * are `LicenseCheckJob` in `WorkerModule`.
 */
@Module({
  imports: [AuditModule, StaffDirectoryModule],
  controllers: [
    ConfigController,
    SettingsController,
    LicenseController,
    ModulesController,
    CostRulesController,
  ],
  providers: [
    { provide: MODULE_ROWS, useValue: MODULE_REGISTRY },
    { provide: STEP_SETTING_ROWS, useValue: [] },
    ModuleRegistry,
    CapabilityHooks,
    ModuleStateService,
    OffImpactReader,
    StepTurnOnCheck,
    SettingsCache,
    { provide: LISTENER_RETRY, useValue: DEFAULT_LISTENER_RETRY },
    PlatformChangesListener,
    SettingsService,
    { provide: LICENSE_KEY_SET, useValue: LICENSE_KEYS },
    LicenseVerifier,
    PlatformClock,
    PreLapseItems,
    LicenseService,
    NumberingService,
    CostRulesService,
    DomainEvents,
  ],
  exports: [
    SettingsService,
    SettingsCache,
    PlatformChangesListener,
    LicenseService,
    PlatformClock,
    NumberingService,
    CostRulesService,
    ModuleRegistry,
    CapabilityHooks,
    ModuleStateService,
    DomainEvents,
  ],
})
export class PlatformModule {}
