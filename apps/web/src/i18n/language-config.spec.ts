import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDE_CAP_MS, languageScript } from './language-config';

/** Runs the head script the way the browser does, against the current document. */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- the test must run the real script text
const runHeadScript = () => (new Function(languageScript) as () => void)();

const setCookie = (value: string) => {
  document.cookie = `ss_lang=${value}; Path=/`;
};

// AC-3: the head script runs before first paint.
describe('languageScript', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.cookie = 'ss_lang=; Path=/; Max-Age=0';
    const html = document.documentElement;
    html.lang = '';
    html.dir = '';
    html.removeAttribute('data-i18n');
  });

  it('sets lang and dir from the cookie and hides the page until the catalog is applied', () => {
    setCookie('ar');

    runHeadScript();

    const html = document.documentElement;
    expect(html.lang).toBe('ar');
    expect(html.dir).toBe('rtl');
    expect(html.getAttribute('data-i18n')).toBe('pending');
  });

  it('never hides the page for English', () => {
    setCookie('en');

    runHeadScript();

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement).not.toHaveAttribute('data-i18n');
  });

  it('reveals the page by itself after the cap, so a failed load never leaves it blank', () => {
    setCookie('ar');
    runHeadScript();

    vi.advanceTimersByTime(HIDE_CAP_MS - 1);
    expect(document.documentElement).toHaveAttribute('data-i18n', 'pending');
    vi.advanceTimersByTime(1);

    expect(document.documentElement).not.toHaveAttribute('data-i18n');
  });

  it('treats a client language by its base code', () => {
    setCookie('fa');

    runHeadScript();

    expect(document.documentElement.dir).toBe('rtl');
  });

  it.each(['', 'A', 'arabic', 'a1', '../x', '<b>'])(
    'ignores a cookie that is not a 2 to 3 letter code (%j)',
    (value) => {
      setCookie(value);

      runHeadScript();

      expect(document.documentElement.lang).toBe('');
      expect(document.documentElement).not.toHaveAttribute('data-i18n');
    },
  );

  it('does nothing without a cookie', () => {
    runHeadScript();

    expect(document.documentElement.lang).toBe('');
  });
});
