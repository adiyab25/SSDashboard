import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from './language-provider';
import { LanguageProbe, readout, resetLanguageState, settle, stubNetwork } from './language-probe';

const cookie = () => /(?:^|;\s*)ss_lang=([^;]*)/.exec(document.cookie)?.[1];

const renderProvider = () =>
  render(
    <LanguageProvider>
      <LanguageProbe />
    </LanguageProvider>,
  );

const french = {
  _meta: { nativeName: 'Français', intl: 'fr-FR' },
  shell: { skipLink: 'Aller au contenu principal' },
  unknown: { key: 'ignored' },
};

describe('LanguageProvider', () => {
  beforeEach(resetLanguageState);
  afterEach(resetLanguageState);

  it('starts in English left to right before anything loads', () => {
    stubNetwork({ config: {} });

    renderProvider();

    expect(readout('language')).toBe('en');
    expect(readout('direction')).toBe('ltr');
    expect(readout('radix')).toBe('ltr');
  });

  // AC-3: the first visit uses the install default, then writes the cookie.
  it('opens a first visit in the install default language and remembers it', async () => {
    stubNetwork({ config: { defaultLanguage: 'ar' } });

    renderProvider();

    await waitFor(() => expect(readout('language')).toBe('ar'));
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(readout('radix')).toBe('rtl');
    expect(cookie()).toBe('ar');
  });

  // AC-3: a returning user: the cookie wins, and the hidden body is revealed once applied.
  it('applies the saved language and reveals the page', async () => {
    document.cookie = 'ss_lang=ar; Path=/';
    document.documentElement.setAttribute('data-i18n', 'pending');
    stubNetwork({ config: {} });

    renderProvider();

    await waitFor(() => expect(readout('language')).toBe('ar'));
    expect(document.documentElement).not.toHaveAttribute('data-i18n');
  });

  // AC-4
  it('uses the default and rewrites the cookie when the saved language is not enabled', async () => {
    document.cookie = 'ss_lang=fr; Path=/';
    stubNetwork({ config: { languages: ['en', 'ar'], defaultLanguage: 'en' } });

    renderProvider();

    await waitFor(() => expect(cookie()).toBe('en'));
    expect(readout('language')).toBe('en');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });

  // AC-4
  it('keeps the saved language when the config call fails, and does not rewrite the cookie', async () => {
    document.cookie = 'ss_lang=ar; Path=/';
    stubNetwork({ config: 'fail' });

    renderProvider();

    await waitFor(() => expect(readout('language')).toBe('ar'));
    expect(cookie()).toBe('ar');
  });

  // AC-4
  it('falls back to English left to right when config fails and nothing is saved', async () => {
    const calls = stubNetwork({ config: 'fail' });

    renderProvider();
    await settle();

    expect(readout('language')).toBe('en');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(cookie()).toBeUndefined();
    expect(calls).toContain('/api/config');
  });

  // AC-4: an installed default whose file is missing falls to the next loadable language.
  it('skips a default language whose catalog is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNetwork({ config: { languages: ['fr', 'ar'], defaultLanguage: 'fr' }, locales: {} });

    renderProvider();

    await waitFor(() => expect(readout('language')).toBe('ar'));
    expect(cookie()).toBe('ar');
    expect(readout('options')).toBe('ar');
    warn.mockRestore();
  });

  // AC-1
  it('switches language, html lang and dir, and Radix direction together without a reload', async () => {
    stubNetwork({ config: {} });
    renderProvider();
    await waitFor(() => expect(cookie()).toBe('en'));

    await userEvent.click(screen.getByRole('button', { name: 'choose ar' }));
    await waitFor(() => expect(readout('language')).toBe('ar'));
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(readout('radix')).toBe('rtl');
    expect(cookie()).toBe('ar');

    await userEvent.click(screen.getByRole('button', { name: 'choose en' }));
    await waitFor(() => expect(readout('language')).toBe('en'));
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(cookie()).toBe('en');
  });

  // AC-11
  it('lists a client language only after its file has loaded and validated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNetwork({
      config: { languages: ['en', 'ar', 'fr', 'de'], defaultLanguage: 'en' },
      locales: { fr: french, de: { shell: {} } },
    });

    renderProvider();

    await waitFor(() => expect(readout('options')).toBe('en,ar,fr'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"de"'));
    warn.mockRestore();
  });

  // AC-13: the last choice wins, a stale load is dropped.
  it('ends on the last choice when two choices overlap', async () => {
    let releaseFrench: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFrench = resolve;
    });
    stubNetwork({ config: { languages: ['en', 'fr'] }, locales: { fr: french } });
    const network = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === '/locales/fr.json') await gate;
        return network(input);
      }),
    );
    render(
      <LanguageProvider>
        <LanguageProbe choices={['en', 'fr']} />
      </LanguageProvider>,
    );
    await settle();

    await userEvent.click(screen.getByRole('button', { name: 'choose fr' }));
    await userEvent.click(screen.getByRole('button', { name: 'choose en' }));
    releaseFrench?.();
    await settle();

    expect(readout('language')).toBe('en');
    expect(cookie()).toBe('en');
  });
});
