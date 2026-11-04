import { beforeAll, describe, expect, it } from 'vitest';
import { createI18n } from './create-i18n';
import { ar } from './locales/ar';

// AC-7: counts pick the right form in both languages, and {{name}} interpolates.
describe('plurals and interpolation', () => {
  const i18n = createI18n();

  beforeAll(() => {
    i18n.addResourceBundle('ar', 'translation', ar, true, true);
  });

  it('picks English one and other', async () => {
    await i18n.changeLanguage('en');

    expect(i18n.t('shell.locations.count', { count: 1 })).toBe('1 location');
    expect(i18n.t('shell.locations.count', { count: 0 })).toBe('0 locations');
    expect(i18n.t('shell.locations.count', { count: 12 })).toBe('12 locations');
  });

  it.each([
    [0, 'لا توجد مواقع'],
    [1, 'موقع واحد'],
    [2, 'موقعان'],
    [3, '3 مواقع'],
    [11, '11 موقعًا'],
    [100, '100 موقع'],
  ])('picks the Arabic form for %i', async (count, expected) => {
    await i18n.changeLanguage('ar');

    expect(i18n.t('shell.locations.count', { count })).toBe(expected);
  });

  it('interpolates {{name}} in both languages, with Western digits for counts', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('shell.user.languageError', { language: 'العربية' })).toBe(
      'Could not load العربية. Try again.',
    );

    await i18n.changeLanguage('ar');
    expect(i18n.t('shell.user.languageError', { language: 'English' })).toBe(
      'تعذّر تحميل English. حاول مرة أخرى.',
    );
    expect(i18n.t('shell.locations.count', { count: 25 })).toMatch(/^25 /);
  });
});
