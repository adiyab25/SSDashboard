import { isCoreLanguage } from '@ssdashboard/i18n';
import type { SettingKey, SettingValues } from './registry.js';

/** One way a new value breaks a rule: the path inside the value and plain words. */
export interface SettingWriteIssue {
  path: string;
  message: string;
}

/**
 * The keys whose write is checked against other settings, and the keys each one needs to see
 * (review R2). The api reads those keys in the write transaction, under one lock per group, so two
 * writes cannot each pass alone and break the rule together.
 */
export const SETTING_WRITE_DEPENDENCIES = {
  languages: ['default_language', 'languages'],
  default_language: ['languages'],
} as const satisfies Partial<Record<SettingKey, readonly SettingKey[]>>;

/** A key whose write is checked against other settings. */
export type CrossCheckedSettingKey = keyof typeof SETTING_WRITE_DEPENDENCIES;

/** Whether a key's write is checked against other settings. Pure. */
export function isCrossChecked(key: string): key is CrossCheckedSettingKey {
  return Object.hasOwn(SETTING_WRITE_DEPENDENCIES, key);
}

/**
 * The rules a new, schema valid value must keep beyond its own schema (spec 0009 AC-3, review
 * R2, R17): `languages` may keep any code already in force but may add only languages that ship a
 * catalog (`CORE_LANGUAGES` of `@ssdashboard/i18n`), and must keep `default_language`; `default_language` must be one of
 * `languages`. `current` holds the values in force of the keys `SETTING_WRITE_DEPENDENCIES` names.
 * An empty list means the write may go ahead. Pure: the api answers 422 `SETTING_INVALID` with
 * these issues, and the screen may show them before sending.
 */
export function settingWriteIssues(
  key: SettingKey,
  value: unknown,
  current: Partial<Pick<SettingValues, 'languages' | 'default_language'>>,
): SettingWriteIssue[] {
  if (key === 'languages') {
    const codes = value as SettingValues['languages'];
    const kept = new Set(current.languages ?? []);
    const issues = codes.flatMap((code, index) =>
      isCoreLanguage(code) || kept.has(code)
        ? []
        : [{ path: String(index), message: `No catalog ships for the language ${code}` }],
    );
    const fallback = current.default_language;
    if (fallback !== undefined && !codes.includes(fallback)) {
      issues.push({
        path: '',
        message: `The default language ${fallback} must stay enabled; change it first`,
      });
    }
    return issues;
  }
  if (key === 'default_language') {
    const enabled = current.languages;
    return enabled !== undefined && !enabled.includes(value as string)
      ? [{ path: '', message: 'The default language must be one of the enabled languages' }]
      : [];
  }
  return [];
}
