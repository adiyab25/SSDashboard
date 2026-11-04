import { UnprocessableEntityException } from '@nestjs/common';
import type { SettingsService } from './settings.service.js';

/**
 * Refuses a language the install has not enabled (422 `INVALID_LANGUAGE`). The allowed set is
 * the `languages` setting, the same list `GET /api/config` serves (spec 0004). When settings
 * cannot be read, only the built in English is certain.
 */
export async function assertLanguageEnabled(
  settings: Pick<SettingsService, 'read'>,
  language: string | null | undefined,
): Promise<void> {
  if (language === undefined || language === null) return;
  let enabled: string[] = ['en'];
  try {
    enabled = (await settings.read(['languages'])).languages;
  } catch {
    // keep the English fallback
  }
  if (!enabled.includes(language)) {
    throw new UnprocessableEntityException({
      code: 'INVALID_LANGUAGE',
      message: `Language "${language}" is not enabled on this install`,
    });
  }
}
