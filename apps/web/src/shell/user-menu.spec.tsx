import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/i18n/language-provider';
import { resetLanguageState, settle, stubNetwork } from '@/i18n/language-probe';
import { UserMenu } from './user-menu';

// The Arabic chunk cannot be fetched, as on a dropped connection.
vi.mock('@ssdashboard/i18n/ar', () => {
  throw new Error('chunk blocked');
});

const cookie = () => /(?:^|;\s*)ss_lang=([^;]*)/.exec(document.cookie)?.[1];

async function openLanguageMenu() {
  await userEvent.click(screen.getByRole('button', { name: /User menu/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Language' }));
}

describe('UserMenu language switch', () => {
  beforeEach(() => {
    resetLanguageState();
    stubNetwork({ config: { languages: ['en', 'ar'], defaultLanguage: 'en' } });
  });
  afterEach(resetLanguageState);

  // AC-1: each option is in its own language and direction.
  it('lists every enabled language by its own name, with its own lang and dir', async () => {
    render(
      <LanguageProvider>
        <UserMenu />
      </LanguageProvider>,
    );
    await settle();

    await openLanguageMenu();

    const english = await screen.findByRole('menuitemradio', { name: 'English' });
    const arabic = screen.getByRole('menuitemradio', { name: 'العربية' });
    expect(english).toHaveAttribute('lang', 'en');
    expect(english).toHaveAttribute('dir', 'ltr');
    expect(arabic).toHaveAttribute('lang', 'ar');
    expect(arabic).toHaveAttribute('dir', 'rtl');
    expect(english).toBeChecked();
  });

  // AC-13
  it('keeps the current language and shows an inline error when the catalog fails to load', async () => {
    render(
      <LanguageProvider>
        <UserMenu />
      </LanguageProvider>,
    );
    await settle();
    await waitFor(() => expect(cookie()).toBe('en'));

    await openLanguageMenu();
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'العربية' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load العربية');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(cookie()).toBe('en');
  });
});
