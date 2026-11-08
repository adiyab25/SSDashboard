import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import {
  type OffImpact,
  type PutSettingAnswer,
  type PutSettingBody,
  type SettingBundle,
  type SettingDefinition,
  type SettingsListResponse,
} from '@ssdashboard/contracts';
import { type DatabaseConnection } from '@ssdashboard/db';
import { auditHttpError } from '../../audit/audit-http.js';
import { DATABASE } from '../../database/database.module.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import type { Access } from '../access/access.js';
import { CurrentAccess } from '../access/current-access.decorator.js';
import { Permission } from '../access/permission.decorator.js';
import { Audience } from '../audience/audience.decorator.js';
import { LicenseService } from '../license/license.service.js';
import { ModuleRegistry } from '../modules/module-registry.js';
import { OffImpactReader } from '../modules/off-impact.js';
import { moduleHttpError } from '../modules/module.errors.js';
import { RequiresModule } from '../modules/requires-module.decorator.js';
import { PutSettingBodyPipe } from './put-setting-body.pipe.js';
import { settingView, type SettingViewContext } from './setting-view.js';
import type { StoredSetting } from './settings-cache.js';
import { settingsHttpError } from './settings-http.js';
import { SettingsService } from './settings.service.js';

/**
 * The brand's settings for the people who manage them (spec 0009, AC-3, AC-26, AC-30): every
 * registry entry (module toggles included) with its value, one change at a time with a reason,
 * and what turning a module or a step off would drop. Staff only, `settings.manage` on every
 * route (spec 0008). Holds no rule itself; `SettingsService` and `OffImpactReader` do.
 */
@Audience('staff')
@Permission('settings.manage')
@RequiresModule('platform')
@Controller('settings')
export class SettingsController {
  /**
   * Takes the settings service, the database (fresh reads), the staff directory (names), the
   * license service (which bundles are licensed now), the module registry (the entries, module
   * toggles included), and the off impact reader.
   */
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
    @Inject(LicenseService) private readonly license: LicenseService,
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(OffImpactReader) private readonly offImpacts: OffImpactReader,
  ) {}

  /**
   * Every registry entry in screen order, then each toggleable module's switch (group `modules`),
   * read from the database, never from the cache.
   */
  @Get()
  async list(@CurrentAccess() access: Access): Promise<SettingsListResponse> {
    const definitions = this.registry.settingDefinitions();
    const stored = await this.settings.load(
      definitions.map((definition) => definition.key),
      this.connection.db,
    );
    const context = await this.context(stored, access);
    return {
      entries: definitions.map((definition, index) =>
        settingView(definition, stored[index] as StoredSetting, context),
      ),
    };
  }

  /**
   * What turning a module toggle or an executing step off would drop (AC-30): the waiting
   * commands it fails, the in flight records that stay finishable, the pieces per partner (their
   * value only for a holder of `cost.view`), and whether the dialog asks for typed confirmation.
   * 404 `SETTING_UNKNOWN` for a key that is neither; 503 `OFF_IMPACT_UNAVAILABLE` when a
   * capability could not say.
   */
  @Get(':key/off-impact')
  async offImpact(@Param('key') key: string, @CurrentAccess() access: Access): Promise<OffImpact> {
    try {
      return await this.offImpacts.read(key, { showCost: access.has('cost.view') });
    } catch (error) {
      throw settingsHttpError(error) ?? moduleHttpError(error) ?? error;
    }
  }

  /**
   * Changes one setting (AC-3), a module toggle included (AC-12): 404 `SETTING_UNKNOWN`, 422
   * `SETTING_INVALID`, 422 `REASON_REQUIRED`, 422 `REASON_TOO_LONG`, 409 `STALE_SETTING`, 409
   * `SETTING_LOCKED`, 409 `NOT_LICENSED` (the entry's bundle is not licensed now, security
   * finding S6), 409 `MODULE_REQUIRED_BY` with `dependants`, 409 `MODULE_REQUIRES` with
   * `requires`.
   */
  @Put(':key')
  async write(
    @Param('key') key: string,
    @Body(new PutSettingBodyPipe()) body: PutSettingBody,
    @CurrentAccess() access: Access,
  ): Promise<PutSettingAnswer> {
    try {
      // Read once: the write's NOT_LICENSED rule and the answer's `licensed` see the same set.
      const licensed = await this.license.licensedBundles();
      const { setting, changed } = await this.settings.write({
        key,
        value: body.value,
        ...(body.reason !== undefined && { reason: body.reason }),
        expectedUpdatedAt: body.expectedUpdatedAt,
        actor: { userId: access.userId, hat: access.actingHat('settings.manage') },
        licensed,
      });
      return {
        entry: settingView(
          this.registry.settingDefinition(key) as SettingDefinition,
          setting,
          await this.context([setting], access, licensed),
        ),
        changed,
      };
    } catch (error) {
      throw settingsHttpError(error) ?? auditHttpError(error) ?? error;
    }
  }

  private async context(
    stored: readonly StoredSetting[],
    access: Access,
    licensed?: ReadonlySet<SettingBundle>,
  ): Promise<SettingViewContext> {
    const ids = stored.flatMap((setting) => (setting.updatedBy ? [setting.updatedBy] : []));
    return {
      names: await this.staff.namesByIds(ids),
      licensedBundles: licensed ?? (await this.license.licensedBundles()),
      mayChange: (definition) =>
        definition.whoMayChange === 'settings.manage' && access.has('settings.manage'),
    };
  }
}
