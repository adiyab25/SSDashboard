import { ar } from '@ssdashboard/i18n/ar';
import { en, flatten } from '@ssdashboard/i18n';
import { describe, expect, it } from 'vitest';

// The catalogs live in packages/i18n (parity and plural tests run there). This only checks
// the web resolves them from the package, so a copy cannot sneak back in.
describe('web catalogs', () => {
  it('come from @ssdashboard/i18n', () => {
    expect(en.home.title).toBe('Overview');
    expect(Object.keys(flatten(ar)).length).toBeGreaterThan(0);
  });
});
