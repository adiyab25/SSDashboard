import { describe, expect, it } from 'vitest';
import { baseKey, flatten, pickKnownKeys, requiredKeys } from './catalog';
import { createI18n } from './create-i18n';
import { pluralCategories } from './format';
import { ar } from './locales/ar';

describe('catalogs', () => {
  // AC-6: translation debt fails the build.
  it('has every English key in Arabic, with all the plural forms Arabic needs', () => {
    const have = new Set(Object.keys(flatten(ar)));

    const missing = requiredKeys('ar-EG').filter((key) => !have.has(key));

    expect(missing).toEqual([]);
  });

  it('asks Intl for the plural forms instead of hand writing them', () => {
    expect([...pluralCategories('ar-EG')].sort()).toEqual([
      'few',
      'many',
      'one',
      'other',
      'two',
      'zero',
    ]);
    expect([...pluralCategories('en-GB')].sort()).toEqual(['one', 'other']);
  });

  it('has no Arabic keys English lacks, so a removed English key is removed everywhere', () => {
    const wanted = new Set(requiredKeys('ar-EG'));

    const extra = Object.keys(flatten(ar)).filter((key) => !wanted.has(key));

    expect(extra).toEqual([]);
  });

  it('compares plural keys by their base name', () => {
    expect(baseKey('shell.locations.count_few')).toBe('shell.locations.count');
    expect(baseKey('shell.locations.all')).toBe('shell.locations.all');
  });
});

describe('client language files', () => {
  // AC-11: keys English lacks are ignored; plural forms English lacks are kept.
  it('keeps only keys English has and only string values', () => {
    const picked = pickKnownKeys({
      _meta: { nativeName: 'Français', intl: 'fr-FR' },
      shell: { skipLink: 'Aller au contenu', madeUp: 'ignored', nav: { label: 42 } },
      'home.title': 'Aperçu',
      shell_locations: 'ignored',
    });

    expect(picked).toEqual({ 'shell.skipLink': 'Aller au contenu', 'home.title': 'Aperçu' });
  });

  it('accepts plural forms a language needs even when English does not have them', () => {
    const picked = pickKnownKeys({ shell: { locations: { count_many: '{{count}} lieux' } } });

    expect(picked).toEqual({ 'shell.locations.count_many': '{{count}} lieux' });
  });
});

describe('text fallback', () => {
  // AC-6: a missing translation shows English, never the raw key.
  it('falls back to English for a key another language lacks', async () => {
    const i18n = createI18n();
    i18n.addResourceBundle('fr', 'translation', { shell: { skipLink: 'Aller au contenu' } });
    await i18n.changeLanguage('fr');

    expect(i18n.t('shell.skipLink')).toBe('Aller au contenu');
    expect(i18n.t('home.title')).toBe('Overview');
  });

  it('resolves flat dotted keys the way a client language file supplies them', async () => {
    const i18n = createI18n();
    i18n.addResourceBundle('fr', 'translation', { 'home.title': 'Aperçu' }, true, true);
    await i18n.changeLanguage('fr');

    expect(i18n.t('home.title')).toBe('Aperçu');
  });
});
