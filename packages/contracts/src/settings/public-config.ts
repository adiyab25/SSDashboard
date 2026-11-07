import type { ConfigResponse } from '../platform.js';
import type { SettingKey } from './registry.js';

/**
 * The `public_config` settings and the `GET /api/config` field each one fills (spec 0009, AC-5;
 * spec 0004, AC-4). `registry.spec.ts` fails when a registry entry is `public_config` but not
 * here, or listed here but not `public_config`, so nothing reaches the public endpoint by
 * accident. A new public entry adds its field to `ConfigResponse` in the same change.
 */
export const PUBLIC_CONFIG_FIELDS = {
  currency: 'currency',
  timezone: 'timezone',
  languages: 'languages',
  default_language: 'defaultLanguage',
} as const satisfies Partial<Record<SettingKey, keyof ConfigResponse>>;

/** A setting `GET /api/config` serves. */
export type PublicConfigKey = keyof typeof PUBLIC_CONFIG_FIELDS;

/** The public settings in a stable order, for the config endpoint to read. */
export const PUBLIC_CONFIG_KEYS = Object.keys(PUBLIC_CONFIG_FIELDS) as PublicConfigKey[];

/**
 * Exactly the fields `GET /api/config` answers (spec 0004 AC-4, spec 0009 AC-5): the env fields
 * and the `public_config` settings. Nothing about bundles, licenses, modules, steps, or policies.
 */
export const CONFIG_RESPONSE_FIELDS = [
  'clientName',
  'version',
  'currency',
  'timezone',
  'languages',
  'defaultLanguage',
  'mailEnabled',
] as const satisfies readonly (keyof ConfigResponse)[];
