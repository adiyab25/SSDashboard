import { CONFIG_RESPONSE_FIELDS, ConfigResponse, PUBLIC_CONFIG_KEYS } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { ConfigController } from './config.controller.js';
import type { SettingsService } from './settings/settings.service.js';

const env = { CLIENT_DISPLAY_NAME: 'Acme Home', APP_VERSION: '1.2.3', MAIL_DRIVER: 'none' } as Env;

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
      mailEnabled: false,
    });
  });

  // Spec 0009, AC-5: exactly the spec 0004 fields, and only `public_config` settings are read.
  it('answers exactly the public key set and reads only public settings', async () => {
    const values: Record<string, unknown> = { ...installed, operations_wind_down_days: 90 };
    const read = vi.fn(([key]: [string]) => Promise.resolve({ [key]: values[key] }));
    const controller = new ConfigController(env, { read } as unknown as SettingsService);

    const body = await controller.read();

    expect(Object.keys(body).sort()).toEqual([...CONFIG_RESPONSE_FIELDS].sort());
    const asked = read.mock.calls.flatMap(([keys]) => keys);
    expect(asked.sort()).toEqual([...PUBLIC_CONFIG_KEYS].sort());
  });

  it('still answers with the env fields and defaults when settings cannot be read', async () => {
    const controller = new ConfigController(env, settingsWith({}));

    expect(ConfigResponse.parse(await controller.read())).toEqual({
      clientName: 'Acme Home',
      version: '1.2.3',
      languages: ['en'],
      defaultLanguage: 'en',
      mailEnabled: false,
    });
  });

  it.each([
    ['none', false],
    ['smtp', true],
    ['postmark', true],
  ] as const)('reports mailEnabled for MAIL_DRIVER %s (AC-10)', async (driver, enabled) => {
    const controller = new ConfigController(
      { ...env, MAIL_DRIVER: driver },
      settingsWith(installed),
    );

    expect((await controller.read()).mailEnabled).toBe(enabled);
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
