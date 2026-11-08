import { z } from 'zod';
import { defineSetting, type SettingDefinition } from '../settings/setting-definition.js';
import type { ModuleDefinition } from './module-definition.js';

/** The shape of a module toggle's settings key: `module.<module key>.enabled`. */
const TOGGLE_KEY = /^module\.([a-z][a-z0-9]*)\.enabled$/;

/** The setting that switches a toggleable module (spec 0009, AC-12): `module.<key>.enabled`. */
export function moduleToggleKey(moduleKey: string): string {
  return `module.${moduleKey}.enabled`;
}

/** The module key a toggle setting key names, or undefined for any other key. Pure. */
export function moduleKeyOfToggle(settingKey: string): string | undefined {
  return TOGGLE_KEY.exec(settingKey)?.[1];
}

/**
 * The settings entry of a toggleable module's switch (spec 0009, AC-12): a boolean, default
 * `true`, in the module's bundle (so turning an unlicensed module on or off answers 409
 * `NOT_LICENSED` through the one write path), changed only by a holder of `settings.manage` with a
 * required reason, shown in the Modules and license section. Derived, never written by hand, so
 * every toggleable module has exactly one. Undefined for a module without a toggle.
 */
export function moduleToggleSetting(
  module: ModuleDefinition,
): SettingDefinition<string, z.ZodBoolean> | undefined {
  if (!module.toggle) return undefined;
  return defineSetting({
    key: moduleToggleKey(module.key),
    schema: z.boolean(),
    default: true,
    bundle: module.bundle,
    group: 'modules',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: module.label,
    description: module.description,
  });
}

/** Every toggleable module's switch, in registry order. Pure. */
export function moduleToggleSettings(
  modules: readonly ModuleDefinition[],
): SettingDefinition<string, z.ZodBoolean>[] {
  return modules.flatMap((module) => {
    const setting = moduleToggleSetting(module);
    return setting ? [setting] : [];
  });
}
