import { createTranslatorSync } from '@ssdashboard/i18n';
import { describe, expect, it } from 'vitest';

// Spec 0004 AC-5 in the api: a wrong catalog key fails `tsc`. The directive below is itself an
// error if the call stops being one, so `pnpm typecheck` catches a loosened key type.
describe('mail keys are typed', () => {
  const { t } = createTranslatorSync('en');

  it('accepts a real key', () => {
    expect(t('mail.reset.action')).toBe('Choose a new password');
  });

  it('rejects a key the catalog does not have', () => {
    // @ts-expect-error not a key in the English catalog
    t('mail.reset.nope');
    expect(true).toBe(true);
  });
});
