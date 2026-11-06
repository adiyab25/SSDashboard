import { describe, expect, it } from 'vitest';
import { isAuthPath, isInAudience, safeReturnTo, signInUrl } from './return-to';

const ORIGIN = 'https://erp.example.com';

describe('safeReturnTo (AC-7)', () => {
  it.each([
    ['/', '/'],
    ['/design', '/design'],
    ['/staff?q=sam&status=active', '/staff?q=sam&status=active'],
    ['/inventory/stock#top', '/inventory/stock#top'],
  ])('keeps the path on this site: %s', (value, expected) => {
    expect(safeReturnTo(value, ORIGIN)).toBe(expected);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a full URL', 'https://evil.example/steal'],
    ['our own full URL', `${ORIGIN}/design`],
    ['a protocol relative URL', '//evil.example'],
    ['a protocol relative URL with a path', '//evil.example/design'],
    ['a slash and a backslash', '/\\evil.example'],
    ['a backslash in the path', '/design\\..\\evil'],
    ['a tab that the browser would strip', '/\t/evil.example'],
    ['a newline that the browser would strip', '/\n/evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a relative path with no slash', 'design'],
    ['a data URL', 'data:text/html,hi'],
  ])('falls back to / for %s', (_case, value) => {
    expect(safeReturnTo(value, ORIGIN)).toBe('/');
  });

  it.each([
    '/sign-in',
    '/sign-in?returnTo=%2F',
    '/forgot-password',
    '/reset-password/abc',
    '/two-factor',
    '/change-password',
  ])('never returns to the auth screen %s', (value) => {
    expect(safeReturnTo(value, ORIGIN)).toBe('/');
  });

  it('does not mistake a longer page name for an auth screen', () => {
    expect(safeReturnTo('/sign-in-help', ORIGIN)).toBe('/sign-in-help');
  });
});

describe('signInUrl', () => {
  it('carries the page to come back to', () => {
    expect(signInUrl('/staff?q=a b')).toBe('/sign-in?returnTo=%2Fstaff%3Fq%3Da%20b');
  });

  it('leaves returnTo off when the page is the home page', () => {
    expect(signInUrl('/')).toBe('/sign-in');
  });
});

describe('isAuthPath', () => {
  it.each(['/sign-in', '/forgot-password', '/reset-password', '/two-factor', '/change-password'])(
    'is true for %s',
    (path) => expect(isAuthPath(path)).toBe(true),
  );

  it.each(['/', '/staff', '/signin', '/reset-passwords', '/account/change-password'])(
    'is false for %s',
    (path) => expect(isAuthPath(path)).toBe(false),
  );
});

describe('safeReturnTo for the audience of the person (AC-28)', () => {
  it.each([
    ['/stock', '/partner'],
    ['/staff', '/partner'],
    ['/account', '/partner'],
    ['/en/returns', '/partner'],
    ['/', '/partner'],
    ['/partner-help', '/partner'],
    ['/skus/partner', '/partner'],
    ['/partner/../stock', '/partner'],
    ['//evil.example', '/partner'],
    ['https://evil.example', '/partner'],
    ['/sign-in', '/partner'],
    [undefined, '/partner'],
  ])('sends a partner user asking for %s to %s', (value, expected) => {
    expect(safeReturnTo(value, ORIGIN, 'partner')).toBe(expected);
  });

  it.each(['/partner', '/partner/account?tab=1', '/en/partner', '/ar/partner/account#top'])(
    'keeps the partner page %s for a partner user',
    (value) => {
      expect(safeReturnTo(value, ORIGIN, 'partner')).toBe(value);
    },
  );

  it.each([
    ['/partner', '/'],
    ['/partner/orders', '/'],
    ['/en/partner', '/'],
    ['/ar/partner/account', '/'],
    ['/ar/returns', '/'],
    ['/returns', '/'],
  ])('sends a staff person asking for %s to %s', (value, expected) => {
    expect(safeReturnTo(value, ORIGIN, 'backoffice')).toBe(expected);
  });

  it.each(['/stock', '/staff?q=sam', '/account', '/skus/partner', '/partners'])(
    'keeps the back office page %s for staff',
    (value) => {
      expect(safeReturnTo(value, ORIGIN, 'backoffice')).toBe(value);
      expect(safeReturnTo(value, ORIGIN)).toBe(value);
    },
  );

  it('names the audience of a path', () => {
    expect(isInAudience('/en/partner/account', 'partner')).toBe(true);
    expect(isInAudience('/en/partner/account', 'backoffice')).toBe(false);
    expect(isInAudience('/stock', 'partner')).toBe(false);
  });
});

describe('safeReturnTo after URL normalization (AC-7, review finding 1)', () => {
  const HOMES = [
    ['backoffice', '/'],
    ['partner', '/partner'],
  ] as const;

  // Each of these is a single slash path as typed, but the URL parser collapses its dot segments
  // into `//evil.example`, which a browser follows to another site.
  const COLLAPSING = [
    '/.//evil.example',
    '/%2e//evil.example',
    '/%2E//evil.example',
    '/a/..//evil.example',
    '/%2e%2e//evil.example',
    '/stock/..//evil.example/x',
    '/x/%2E%2E//evil.example',
  ];

  // Refused on the raw text already: a backslash, a tab, or a newline anywhere in the path.
  const RAW_UNSAFE = [
    '/./\\evil.example',
    '/\\evil.example',
    '/\tevil',
    '/st\tock',
    '/\nevil',
    '/sto\nck',
  ];

  for (const [home, fallback] of HOMES) {
    it.each([...COLLAPSING, ...RAW_UNSAFE])(
      `falls back to ${fallback} for ${home}: %j`,
      (value) => {
        expect(safeReturnTo(value, ORIGIN, home)).toBe(fallback);
      },
    );

    it(`never answers a protocol relative path for ${home}, whatever the dot prefix`, () => {
      const prefixes = [
        '/.',
        '/%2e',
        '/%2E',
        '/./.',
        '/a/..',
        '/a/%2e%2e',
        '/a/b/../..',
        '/stock/..',
      ];
      const targets = [
        '//evil.example',
        '//evil.example/x?q=1#h',
        '/\\evil.example',
        '///evil.example',
      ];
      for (const prefix of prefixes) {
        for (const target of targets) {
          const answer = safeReturnTo(`${prefix}${target}`, ORIGIN, home);
          expect(answer, `${prefix}${target}`).toBe(fallback);
          expect(answer.startsWith('//') || answer.includes('\\')).toBe(false);
        }
      }
    });
  }

  // An escaped slash is not a path separator: the browser asks this site for the literal path
  // `/%2F%2Fevil.example` (or `/.%2f/evil.example`), which is a same origin page that does not
  // exist. Staff keep it as a relative path; a partner user falls back because it is not a
  // partner page.
  it.each(['/%2F%2Fevil.example', '/%2f%2fevil.example', '/.%2f/evil.example'])(
    'keeps the escaped slash path %s on this site for staff, and sends a partner user home',
    (value) => {
      expect(safeReturnTo(value, ORIGIN, 'backoffice')).toBe(value);
      expect(safeReturnTo(value, ORIGIN, 'partner')).toBe('/partner');
    },
  );
});

describe('isInAudience reads the decoded, lowercased path (review finding 7)', () => {
  it.each(['/EN/partner', '/%70artner', '/%72eturns', '/en/%50ARTNER/account', '/AR/Returns'])(
    'refuses the partner or portal path %s to staff',
    (value) => {
      expect(isInAudience(value, 'backoffice')).toBe(false);
      expect(safeReturnTo(value, ORIGIN, 'backoffice')).toBe('/');
    },
  );

  it.each(['/EN/partner', '/%70artner'])(
    'sends a partner user asking for the unusual spelling %s to the plain partner home',
    (value) => {
      expect(isInAudience(value, 'partner')).toBe(false);
      expect(safeReturnTo(value, ORIGIN, 'partner')).toBe('/partner');
    },
  );

  it('refuses a malformed escape to both audiences', () => {
    expect(isInAudience('/stock%zz', 'backoffice')).toBe(false);
    expect(isInAudience('/partner/%E0%A4%A', 'partner')).toBe(false);
    expect(safeReturnTo('/stock%zz', ORIGIN, 'backoffice')).toBe('/');
    expect(safeReturnTo('/partner/%E0%A4%A', ORIGIN, 'partner')).toBe('/partner');
  });

  it('still keeps escaped text that is not a partner or portal page for staff', () => {
    expect(safeReturnTo('/skus/a%20b', ORIGIN, 'backoffice')).toBe('/skus/a%20b');
  });
});
