import { describe, expect, it } from 'vitest';
import { isAuthPath, safeReturnTo, signInUrl } from './return-to';

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
