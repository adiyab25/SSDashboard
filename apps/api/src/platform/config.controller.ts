import { Controller, Get, Inject, Logger } from '@nestjs/common';
import type { ConfigResponse } from '@ssdashboard/contracts';
import { Public } from '../identity/sign-in/public.decorator.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { Audience } from './audience/audience.decorator.js';
import { SettingsService, type Settings } from './settings.service.js';

const FALLBACK_LANGUAGE = 'en';

/** Public by design: the shell and the sign in page need it, and it holds nothing secret. */
@Audience('public')
@Public()
@Controller('config')
export class ConfigController {
  private readonly logger = new Logger(ConfigController.name);

  /** Takes the env and the settings service. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Returns the install's currency, time zone, enabled languages and default language, for the
   * shell and sign in page.
   */
  @Get()
  async read(): Promise<ConfigResponse> {
    const { currency, timezone, languages, default_language } = await this.readSettings();
    const enabled = languages ?? [FALLBACK_LANGUAGE];
    let defaultLanguage = default_language ?? enabled[0] ?? FALLBACK_LANGUAGE;
    if (!enabled.includes(defaultLanguage)) {
      this.logger.warn(
        `default_language "${defaultLanguage}" is not in languages; using "${enabled[0]}"`,
      );
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
   * Each setting on its own, so one bad or missing value costs only that field. A setting
   * that cannot be read is logged and left out; the endpoint still answers.
   */
  private async readSettings(): Promise<
    Partial<Pick<Settings, 'currency' | 'timezone' | 'languages' | 'default_language'>>
  > {
    const keys = ['currency', 'timezone', 'languages', 'default_language'] as const;
    const results = await Promise.allSettled(keys.map((key) => this.settings.read([key])));
    const found: Partial<Settings> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') Object.assign(found, result.value);
      else this.logger.error(`Could not read setting "${keys[index]}"`, result.reason);
    });
    return found;
  }
}
