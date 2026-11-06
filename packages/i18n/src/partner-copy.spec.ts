import { describe, expect, it } from 'vitest';
import { flatten } from './catalog.js';
import { ar } from './locales/ar.js';
import { en } from './locales/en.js';

/** The words a partner must never read: staff or employee, in English and in Arabic. */
const STAFF_WORDS = /staff|employee|موظف/i;

/**
 * Keys under the groups a partner can reach that stay staff only: the staff code row and the
 * administrator's longer notice are shown on the back office account page only
 * (spec 0005, AC-34).
 */
const STAFF_ONLY_KEYS = new Set(['account.profile.staffCode', 'account.profile.readOnlyStaff']);

/** Every screen a partner reaches: sign in screens, account, partner pages, and the auth mail. */
const PARTNER_GROUPS = ['auth.', 'account.', 'partner.', 'mail.'];

describe('copy a partner can reach (spec 0005, AC-34)', () => {
  it.each([
    ['English', en],
    ['Arabic', ar],
  ])('has no staff or employee wording in %s', (_language, catalog) => {
    const found = Object.entries(flatten(catalog))
      .filter(([key]) => PARTNER_GROUPS.some((group) => key.startsWith(group)))
      .filter(([key]) => !STAFF_ONLY_KEYS.has(key))
      .filter(([, text]) => STAFF_WORDS.test(text))
      .map(([key]) => key);

    expect(found).toEqual([]);
  });
});
