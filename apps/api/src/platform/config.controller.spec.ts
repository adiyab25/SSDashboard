import { ConfigResponse } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { ConfigController } from './config.controller.js';
import type { SettingsService } from './settings.service.js';

const env = { CLIENT_DISPLAY_NAME: 'Acme Home', APP_VERSION: '1.2.3' } as Env;

/** A settings service holding these values; a key left out reads as missing. */
function settingsWith(values: Record<string, unknown>): SettingsService {
  return {
    read: vi.fn(([key]: [string]) =>
      key in values
        ? Promise.resolve({ [key]: values[key] })
        : Promise.reject(new Error(`Setting "${key}" is missing`)),
    ),
  } as unknown as SettingsService;
}

const installed = {
  currency: 'EGP',
  timezone: 'Africa/Cairo',
  languages: ['en', 'ar'],
  default_language: 'en',
};

describe('ConfigController', () => {
  it('answers with the install name, version, money and language settings', async () => {
    const controller = new ConfigController(env, settingsWith(installed));

    expect(ConfigResponse.parse(await controller.read())).toEqual({
      clientName: 'Acme Home',
      version: '1.2.3',
      currency: 'EGP',
      timezone: 'Africa/Cairo',
      languages: ['en', 'ar'],
      defaultLanguage: 'en',
    });
  });

  it('still answers with the env fields and defaults when settings cannot be read', async () => {
    const controller = new ConfigController(env, settingsWith({}));

    expect(ConfigResponse.parse(await controller.read())).toEqual({
      clientName: 'Acme Home',
      version: '1.2.3',
      languages: ['en'],
      defaultLanguage: 'en',
    });
  });

  it('keeps the settings it can read when one is missing', async () => {
    const { currency: _currency, ...withoutCurrency } = installed;
    const controller = new ConfigController(env, settingsWith(withoutCurrency));

    const body = await controller.read();

    expect(body.currency).toBeUndefined();
    expect(body.timezone).toBe('Africa/Cairo');
    expect(body.languages).toEqual(['en', 'ar']);
  });

  it('uses the first language when the default is not enabled, instead of failing', async () => {
    const controller = new ConfigController(
      env,
      settingsWith({ ...installed, languages: ['ar', 'fr'], default_language: 'en' }),
    );

    expect((await controller.read()).defaultLanguage).toBe('ar');
  });
});
