import type { SettingDefinition, SettingEntryView, SettingJson } from '@ssdashboard/contracts';
import type { StoredSetting } from './settings-cache.js';
import { canonicalJson } from './settings.service.js';

/** What the view needs to know about the caller and the install besides the setting itself. */
export interface SettingViewContext {
  /** Display names by user id, for `updatedBy`. */
  names: ReadonlyMap<string, string>;
  /** Whether the caller holds the permission the entry's `whoMayChange` names. */
  mayChange: (definition: SettingDefinition) => boolean;
  /**
   * The bundles licensed now (`LicenseService.licensedBundles`): `core` always, and each bundle
   * whose live phase is `active`, `expiring`, or `grace` (spec 0009, *Effective
   * state*). With no license ever recorded, only core (AC-16).
   */
  licensedBundles: ReadonlySet<SettingDefinition['bundle']>;
}

/**
 * One entry of `GET /api/settings` (spec 0009, AC-26), from its registry entry and its stored
 * state. `canChange` (may this caller change it) and `licensed` (is its bundle licensed) stay two
 * fields on purpose (review R12): the web disables an entry when either is false and says which
 * ("needs the Operations plan" for `licensed: false`). Pure: it reads nothing and never logs.
 */
export function settingView(
  definition: SettingDefinition,
  setting: StoredSetting,
  context: SettingViewContext,
): SettingEntryView {
  return {
    key: definition.key,
    group: definition.group,
    bundle: definition.bundle,
    label: definition.label,
    description: definition.description,
    warning: definition.warning ?? null,
    confirm: definition.confirm ?? null,
    reason: definition.reason,
    value: setting.value as SettingJson,
    default: definition.default as SettingJson,
    isDefault: canonicalJson(setting.value) === canonicalJson(definition.default),
    invalid: setting.invalid,
    updatedAt: setting.updatedAt,
    updatedBy: setting.updatedBy
      ? { id: setting.updatedBy, name: context.names.get(setting.updatedBy) ?? null }
      : null,
    canChange: definition.whoMayChange !== 'nobody' && context.mayChange(definition),
    licensed: context.licensedBundles.has(definition.bundle),
  };
}
