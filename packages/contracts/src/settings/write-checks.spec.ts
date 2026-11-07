import { describe, expect, it } from 'vitest';
import { nestsDeeperThan, PutSettingBody, SETTING_VALUE_MAX_DEPTH } from './settings-api.js';
import { isCrossChecked, settingWriteIssues } from './write-checks.js';

// Review R2: the language settings are checked against each other and the shipped catalogs.
describe('settingWriteIssues', () => {
  it('lets languages keep the default language and only shipped catalogs', () => {
    expect(settingWriteIssues('languages', ['ar', 'en'], { default_language: 'en' })).toEqual([]);
    expect(settingWriteIssues('languages', ['en', 'fr'], { default_language: 'en' })).toEqual([
      { path: '1', message: 'No catalog ships for the language fr' },
    ]);
    const dropped = settingWriteIssues('languages', ['ar'], { default_language: 'en' });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.message).toContain('must stay enabled');
  });

  // Review R17: a client language already in force may stay; only new ones need a catalog.
  it('keeps a stored language without a catalog but adds only shipped ones', () => {
    const current = { default_language: 'en', languages: ['en', 'fr'] };
    expect(settingWriteIssues('languages', ['fr', 'en', 'ar'], current)).toEqual([]);
    expect(settingWriteIssues('languages', ['en', 'fr', 'de'], current)).toEqual([
      { path: '2', message: 'No catalog ships for the language de' },
    ]);
  });

  it('keeps the default language among the enabled ones', () => {
    expect(settingWriteIssues('default_language', 'ar', { languages: ['en', 'ar'] })).toEqual([]);
    expect(settingWriteIssues('default_language', 'ar', { languages: ['en'] })).toHaveLength(1);
  });

  it('checks no other key', () => {
    expect(settingWriteIssues('operations_wind_down_days', 90, {})).toEqual([]);
    expect(isCrossChecked('languages')).toBe(true);
    expect(isCrossChecked('timezone')).toBe(false);
  });
});

// Security review S3: a hostile nesting is refused without recursion.
describe('nestsDeeperThan', () => {
  const nested = (depth: number): unknown => {
    let value: unknown = 1;
    for (let level = 0; level < depth; level += 1) value = [value];
    return value;
  };

  it('counts arrays and objects, not scalars', () => {
    expect(nestsDeeperThan(5, 0)).toBe(false);
    expect(nestsDeeperThan({ a: [1] }, 2)).toBe(false);
    expect(nestsDeeperThan({ a: [1] }, 1)).toBe(true);
    expect(nestsDeeperThan(nested(SETTING_VALUE_MAX_DEPTH), SETTING_VALUE_MAX_DEPTH)).toBe(false);
    expect(nestsDeeperThan(nested(SETTING_VALUE_MAX_DEPTH + 1), SETTING_VALUE_MAX_DEPTH)).toBe(
      true,
    );
  });

  it('refuses a 10,000 level value in the body schema without overflowing the stack', () => {
    const result = PutSettingBody.safeParse({ value: nested(10_000), expectedUpdatedAt: null });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['value']);
  });

  // Security review S4, review R15: the reason is trimmed and capped like the audit entry's.
  it('trims the reason and caps it at 500 characters', () => {
    expect(
      PutSettingBody.parse({ value: 1, reason: '  why  ', expectedUpdatedAt: null }).reason,
    ).toBe('why');
    const long = PutSettingBody.safeParse({
      value: 1,
      reason: 'x'.repeat(501),
      expectedUpdatedAt: null,
    });
    expect(long.success).toBe(false);
  });
});
