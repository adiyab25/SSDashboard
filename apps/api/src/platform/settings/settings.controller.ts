import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import {
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  settingDefinitionOf,
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
import { PutSettingBodyPipe } from './put-setting-body.pipe.js';
import { settingView, type SettingViewContext } from './setting-view.js';
import type { StoredSetting } from './settings-cache.js';
import { settingsHttpError } from './settings-http.js';
import { SettingsService } from './settings.service.js';

/**
 * The brand's settings for the people who manage them (spec 0009, AC-3, AC-26): every registry
 * entry with its value, and one change at a time with a reason. Staff only, `settings.manage`
 * on every route (spec 0008). Holds no rule itself; `SettingsService` does.
 */
@Audience('staff')
@Permission('settings.manage')
@Controller('settings')
export class SettingsController {
  /**
   * Takes the settings service, the database (fresh reads), the staff directory (names), and the
   * license service (which bundles are licensed now).
   */
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
    @Inject(LicenseService) private readonly license: LicenseService,
  ) {}

  /** Every registry entry in screen order, read from the database, never from the cache. */
  @Get()
  async list(@CurrentAccess() access: Access): Promise<SettingsListResponse> {
    const stored = await this.settings.load(SETTING_KEYS, this.connection.db);
    const context = await this.context(stored, access);
    return {
      entries: SETTING_DEFINITIONS.map((definition, index) =>
        settingView(definition as SettingDefinition, stored[index] as StoredSetting, context),
      ),
    };
  }

  /**
   * Changes one setting (AC-3): 404 `SETTING_UNKNOWN`, 422 `SETTING_INVALID`, 422
   * `REASON_REQUIRED`, 422 `REASON_TOO_LONG`, 409 `STALE_SETTING`, 409 `SETTING_LOCKED`, 409
   * `NOT_LICENSED` (the entry's bundle is not licensed now, security finding S6).
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
          settingDefinitionOf(key) as SettingDefinition,
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
