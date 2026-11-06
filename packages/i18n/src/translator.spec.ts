import { describe, expect, it } from 'vitest';
import { flatten } from './catalog.js';
import { createTranslator, createTranslatorSync } from './translator.js';

// AC-15: one non React translator, English fallback, typed keys.
describe('createTranslator', () => {
  it('speaks English left to right', async () => {
    const translator = await createTranslator('en');

    expect(translator.language).toBe('en');
    expect(translator.dir).toBe('ltr');
    expect(translator.t('home.title')).toBe('Overview');
  });

  it('loads Arabic on demand and reports right to left', async () => {
    const translator = await createTranslator('ar');

    expect(translator.language).toBe('ar');
    expect(translator.dir).toBe('rtl');
    expect(translator.t('shell.skipLink')).toBe('انتقل إلى المحتوى الرئيسي');
  });

  it('reads a regional tag by its base language', async () => {
    const translator = await createTranslator('AR-EG');

    expect(translator.language).toBe('ar');
  });

  it('gives English, left to right, for a language it does not have', async () => {
    for (const code of ['fr', 'he', 'xx', '', 'zz-ZZ']) {
      const translator = await createTranslator(code);

      expect(translator.language, code).toBe('en');
      expect(translator.dir, code).toBe('ltr');
      expect(translator.t('home.title'), code).toBe('Overview');
    }
  });

  it('returns the same Arabic text on every call (cached load)', async () => {
    const [first, second] = await Promise.all([createTranslator('ar'), createTranslator('ar')]);

    expect(first.t('home.title')).toBe(second.t('home.title'));
  });

  it('interpolates values and picks plural forms', async () => {
    const english = await createTranslator('en');
    const arabic = await createTranslator('ar');

    expect(english.t('shell.user.languageError', { language: 'X' })).toBe(
      'Could not load X. Try again.',
    );
    expect(english.t('shell.locations.count', { count: 2 })).toBe('2 locations');
    expect(arabic.t('shell.locations.count', { count: 2 })).toBe('موقعان');
  });
});

describe('createTranslatorSync', () => {
  it('uses a catalog the caller holds, with no loading', () => {
    const translator = createTranslatorSync('fr', { fr: { home: { title: 'Aperçu' } } });

    expect(translator.language).toBe('fr');
    expect(translator.dir).toBe('ltr');
    expect(translator.t('home.title')).toBe('Aperçu');
  });

  // AC-15: a key missing from another language gives English, never the raw key.
  it('falls back to English for a key the held catalog lacks', () => {
    const translator = createTranslatorSync('fr', { fr: { home: { title: 'Aperçu' } } });

    expect(translator.t('shell.skipLink')).toBe('Skip to main content');
  });

  it('gives English when the language has no catalog, and says so', () => {
    const translator = createTranslatorSync('he');

    expect(translator.language).toBe('en');
    expect(translator.dir).toBe('ltr');
    expect(translator.t('home.title')).toBe('Overview');
  });

  it('reports right to left only for a language it really holds', () => {
    const translator = createTranslatorSync('he', { he: { home: { title: 'סקירה' } } });

    expect(translator.dir).toBe('rtl');
    expect(translator.t('home.title')).toBe('סקירה');
  });
});

describe('typed keys', () => {
  it('rejects a key English does not have', async () => {
    const { t } = await createTranslator('en');

    // @ts-expect-error not a key in the English catalog
    t('mail.nope');
    expect(true).toBe(true);
  });
});

describe('catalog groups', () => {
  // The parity test walks every group; this pins that nesting depth does not hide keys.
  it('flattens groups at any depth', () => {
    expect(flatten({ mail: { reset: { subject: 'a' } }, export: { label: 'b' } })).toEqual({
      'mail.reset.subject': 'a',
      'export.label': 'b',
    });
  });
});
