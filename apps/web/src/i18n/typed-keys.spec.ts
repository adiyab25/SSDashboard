import { describe, expect, it } from 'vitest';
import { createI18n } from './create-i18n';

// AC-5: a wrong key fails the type check. `tsc` runs over this file, and the directive
// below is itself an error if the call stops being one.
describe('typed keys', () => {
  const { t } = createI18n();

  it('accepts a real key', () => {
    expect(t('home.title')).toBe('Overview');
  });

  it('rejects a key English does not have', () => {
    // @ts-expect-error not a key in the English catalog
    t('home.nope');
    expect(true).toBe(true);
  });
});
