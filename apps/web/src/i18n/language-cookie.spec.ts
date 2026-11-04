import { afterEach, describe, expect, it } from 'vitest';
import { readLanguageCookie, writeLanguageCookie } from './language-cookie';

afterEach(() => {
  document.cookie = 'ss_lang=; Path=/; Max-Age=0';
});

// AC-1 and the cookie invariant: only a 2 to 3 letter code is ever read or written.
describe('language cookie', () => {
  it('writes and reads a language code', () => {
    writeLanguageCookie('ar');

    expect(readLanguageCookie()).toBe('ar');
  });

  it('reads null when nothing is saved', () => {
    expect(readLanguageCookie()).toBeNull();
  });

  it('refuses to write anything that is not a language code', () => {
    writeLanguageCookie('arabic');
    writeLanguageCookie('A1');
    writeLanguageCookie('');

    expect(readLanguageCookie()).toBeNull();
  });

  it('ignores a tampered cookie value', () => {
    document.cookie = 'ss_lang=<script>; Path=/';

    expect(readLanguageCookie()).toBeNull();
  });

  it('is not confused by another cookie that ends the same way', () => {
    document.cookie = 'not_ss_lang=fr; Path=/';

    expect(readLanguageCookie()).toBeNull();
    document.cookie = 'not_ss_lang=; Path=/; Max-Age=0';
  });
});
