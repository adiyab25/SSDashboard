import { describe, expect, it } from 'vitest';
import { localizedText } from './localized-text';

// AC-9
describe('localizedText', () => {
  const order = { active: 'en', fallback: 'ar', enabled: ['en', 'ar', 'fr'] };

  it('shows the active language', () => {
    expect(localizedText({ en: 'Main', ar: 'المخزن' }, order, 'WH-A')).toBe('Main');
    expect(localizedText({ en: 'Main', ar: 'المخزن' }, { ...order, active: 'ar' }, 'WH-A')).toBe(
      'المخزن',
    );
  });

  it('trims values first, so blank text counts as empty', () => {
    expect(localizedText({ en: ' ', ar: 'المستودع' }, order, 'WH-A')).toBe('المستودع');
    expect(localizedText({ en: ' Main ' }, order, 'WH-A')).toBe('Main');
  });

  it('falls to the install default language, then any other language in enabled order', () => {
    const active = { ...order, active: 'fr', fallback: 'en' };
    expect(localizedText({ en: 'Main', ar: 'المخزن' }, active, 'WH-A')).toBe('Main');
    expect(localizedText({ ar: 'المخزن', fr: 'Principal' }, { ...order, active: 'de' }, 'X')).toBe(
      'المخزن',
    );
    expect(localizedText({ fr: 'Principal' }, { ...order, active: 'de' }, 'X')).toBe('Principal');
  });

  it('shows the code when there is no text at all', () => {
    expect(localizedText({}, order, 'WH-A')).toBe('WH-A');
    expect(localizedText({ en: '  ', ar: '' }, order, 'WH-A')).toBe('WH-A');
  });
});
