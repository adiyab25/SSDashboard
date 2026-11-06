import { describe, expect, it } from 'vitest';
import { flatten } from './catalog.js';
import { ar } from './locales/ar.js';
import { en } from './locales/en.js';

/**
 * The words a partner must never read: staff or employee in English, and in Arabic employee
 * (موظف, which also covers الموظفين), crew or staff (طاقم), the workers (العاملين), and worker
 * (عامل) as a whole word only, so words that merely contain it, like تعامل (dealing) or معاملة
 * (transaction), stay allowed. JavaScript's `\b` does not see Arabic letters, so the whole word
 * test uses Unicode letter lookarounds.
 */
const STAFF_WORDS =
  /staff|employee|موظف|الموظفين|طاقم|العاملين|(?<![\p{L}\p{M}])عامل(?![\p{L}\p{M}])/iu;

/**
 * Keys under the groups a partner can reach that stay staff only: the staff code row and the
 * administrator's longer notice are shown on the back office account page only
 * (spec 0005, AC-34).
 */
const STAFF_ONLY_KEYS = new Set(['account.profile.staffCode', 'account.profile.readOnlyStaff']);

/** Every screen a partner reaches: sign in screens, account, partner pages, and the auth mail. */
const PARTNER_GROUPS = ['auth.', 'account.', 'partner.', 'mail.'];

/**
 * The shell keys the auth screens and the partner frame render: the language and theme pickers
 * of `auth-preferences.tsx`, the skip link, the client name fallback of `client-name.tsx` in the
 * auth frame, the partner page description of `public-metadata.ts`, and the not found page any
 * unknown address shows. A key ending in `.` is a whole group.
 */
const PARTNER_SHELL_KEYS = [
  'shell.user.language',
  'shell.user.theme',
  'shell.theme.',
  'shell.skipLink',
  'shell.clientNameFallback',
  'shell.publicDescription',
  'shell.notFound.',
];

/** True for a key a partner can read. */
function partnerCanReach(key: string): boolean {
  if (STAFF_ONLY_KEYS.has(key)) return false;
  if (PARTNER_GROUPS.some((group) => key.startsWith(group))) return true;
  return PARTNER_SHELL_KEYS.some((shellKey) =>
    shellKey.endsWith('.') ? key.startsWith(shellKey) : key === shellKey,
  );
}

describe('copy a partner can reach (spec 0005, AC-34)', () => {
  it.each([
    ['English', en],
    ['Arabic', ar],
  ])('has no staff or employee wording in %s', (_language, catalog) => {
    const found = Object.entries(flatten(catalog))
      .filter(([key]) => partnerCanReach(key))
      .filter(([, text]) => STAFF_WORDS.test(text))
      .map(([key]) => key);

    expect(found).toEqual([]);
  });

  it.each([
    ['English', en],
    ['Arabic', ar],
  ])('scans every shell key the auth screens and the partner frame render in %s', (_l, catalog) => {
    const keys = Object.keys(flatten(catalog));
    for (const shellKey of PARTNER_SHELL_KEYS) {
      const matches = keys.filter((key) =>
        shellKey.endsWith('.') ? key.startsWith(shellKey) : key === shellKey,
      );
      expect(matches, shellKey).not.toEqual([]);
    }
  });

  it.each([
    'Staff',
    'an employee',
    'موظف',
    'الموظفين',
    'طاقم العمل',
    'العاملين',
    'عامل',
    'كل عامل هنا',
  ])('catches the staff word in %j', (text) => {
    expect(STAFF_WORDS.test(text)).toBe(true);
  });

  it.each(['Partner showroom', 'تعامل', 'معاملة', 'المعاملات', 'التعامل مع الطلب'])(
    'leaves the unrelated word %j alone',
    (text) => {
      expect(STAFF_WORDS.test(text)).toBe(false);
    },
  );

  it('still finds the staff words where they belong, so the pattern is live', () => {
    const flat = flatten(ar);
    expect(STAFF_WORDS.test(flat['account.profile.staffCode'] ?? '')).toBe(true);
  });
});
