import { Hat, Permission } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { describe, expect, it } from 'vitest';

const i18n = createI18n({ catalogs: { ar } });
const text = (language: 'en' | 'ar', key: string): unknown =>
  i18n.getResource(language, 'translation', key);

describe('access catalog keys (spec 0008, AC-11 and AC-18)', () => {
  it.each(Hat.options)('names and describes the %s hat in English and Arabic', (hat) => {
    for (const language of ['en', 'ar'] as const) {
      expect(text(language, `access.hats.${hat}.name`)).toEqual(expect.any(String));
      expect(text(language, `access.hats.${hat}.description`)).toEqual(expect.any(String));
    }
  });

  it.each(Permission.options)('describes %s in English and Arabic', (permission) => {
    for (const language of ['en', 'ar'] as const) {
      expect(text(language, `access.permissions.${permission}`)).toEqual(expect.any(String));
    }
  });
});
