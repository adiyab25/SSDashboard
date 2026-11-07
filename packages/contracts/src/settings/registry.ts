import type { z } from 'zod';
import { BRAND_SETTINGS } from './brand-settings.js';
import { POLICY_SETTINGS } from './policy-settings.js';
import type { SettingDefinition } from './setting-definition.js';

/**
 * Every brand setting, in settings screen order (spec 0009, AC-1). The one list the api reads,
 * validates, and writes by, and the web renders from. A later feature adds its keys to its
 * group's file in its own build; `registry.spec.ts` checks every entry.
 */
export const SETTING_DEFINITIONS = [...BRAND_SETTINGS, ...POLICY_SETTINGS] as const;

type AnySettingDefinition = (typeof SETTING_DEFINITIONS)[number];

/** The key of one registered setting. Reading any other key fails `tsc` (AC-2). */
export type SettingKey = AnySettingDefinition['key'];

/** The registry entry of one key, with its schema's exact type. */
export type SettingDefinitionOf<K extends SettingKey> = Extract<AnySettingDefinition, { key: K }>;

/** The type a setting's value parses to. */
export type SettingValue<K extends SettingKey> = z.output<SettingDefinitionOf<K>['schema']>;

/** Every setting with the type its value parses to. */
export type SettingValues = { [K in SettingKey]: SettingValue<K> };

/** The registry by key. */
export const SETTINGS_REGISTRY = Object.freeze(
  Object.fromEntries(SETTING_DEFINITIONS.map((definition) => [definition.key, definition])),
) as { readonly [K in SettingKey]: SettingDefinitionOf<K> };

/** Every registered key, in screen order. */
export const SETTING_KEYS: readonly SettingKey[] = SETTING_DEFINITIONS.map(
  (definition) => definition.key,
);

/** Whether a string is a registered key. Pure; never throws. */
export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS_REGISTRY, key);
}

/** The registry entry of a key, or undefined for an unknown one. */
export function settingDefinitionOf(key: string): SettingDefinition | undefined {
  return isSettingKey(key) ? SETTINGS_REGISTRY[key] : undefined;
}
