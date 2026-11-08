import { Controller, Get, Inject, Logger } from '@nestjs/common';
import {
  PUBLIC_CONFIG_KEYS,
  type ConfigResponse,
  type PublicConfigKey,
  type SettingValues,
} from '@ssdashboard/contracts';
import { Public } from '../identity/sign-in/public.decorator.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { Audience } from './audience/audience.decorator.js';
import { SettingsService } from './settings/settings.service.js';
import { RequiresModule } from './modules/requires-module.decorator.js';

const FALLBACK_LANGUAGE = 'en';

/**
 * Public by design: the shell and the sign in page need it, and it holds nothing secret. It reads
 * only the registry entries marked `public_config` (spec 0009, AC-5): never bundles, licenses,
 * module states, steps, policies, owner policies, or cost rules.
 */
@Audience('public')
@Public()
@RequiresModule('platform')
@Controller('config')
export class ConfigController {
  private readonly logger = new Logger(ConfigController.name);

  /** Takes the env and the settings service. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * Returns exactly the spec 0004 fields: the install's name, version, currency, time zone,
   * enabled languages and default language, and whether mail is on.
   */
  @Get()
  async read(): Promise<ConfigResponse> {
    const { currency, timezone, languages, default_language } = await this.readSettings();
    const enabled = languages ?? [FALLBACK_LANGUAGE];
    let defaultLanguage = default_language ?? enabled[0] ?? FALLBACK_LANGUAGE;
    if (!enabled.includes(defaultLanguage)) {
      // Names the keys only, never a value (security review S8).
      this.logger.warn('default_language is not in languages; using the first enabled language');
      defaultLanguage = enabled[0] ?? FALLBACK_LANGUAGE;
    }
    return {
      clientName: this.env.CLIENT_DISPLAY_NAME,
      version: this.env.APP_VERSION,
      ...(currency !== undefined && { currency }),
      ...(timezone !== undefined && { timezone }),
      languages: enabled,
      defaultLanguage,
      mailEnabled: this.env.MAIL_DRIVER !== 'none',
    };
  }

  /**
   * Each public setting on its own, so a read that fails costs only that field. A missing or
   * invalid row already reads as its default; only a database error leaves a field out, and the
   * endpoint still answers.
   */
  private async readSettings(): Promise<Partial<Pick<SettingValues, PublicConfigKey>>> {
    const results = await Promise.allSettled(
      PUBLIC_CONFIG_KEYS.map((key) => this.settings.read([key])),
    );
    const found: Partial<Pick<SettingValues, PublicConfigKey>> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') Object.assign(found, result.value);
      else
        this.logger.error(`Could not read setting "${PUBLIC_CONFIG_KEYS[index]}"`, result.reason);
    });
    return found;
  }
}
