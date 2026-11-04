import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/i18n/language-provider';
import { resetLanguageState, settle, stubNetwork } from '@/i18n/language-test-utils';
import { UserMenu } from './user-menu';

const saveLanguageToAccount = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/auth/account-api', () => ({ saveLanguageToAccount }));
vi.mock('@/auth/use-me', () => ({ useMe: () => null }));

describe('UserMenu account link and language sync (AC-19, AC-25)', () => {
  beforeEach(() => {
    resetLanguageState();
    stubNetwork({ config: { languages: ['en', 'ar'], defaultLanguage: 'en' } });
  });
  afterEach(() => {
    resetLanguageState();
    saveLanguageToAccount.mockClear();
  });

  it('has an Account link to /account', async () => {
    render(
      <LanguageProvider>
        <UserMenu />
      </LanguageProvider>,
    );
    await settle();

    await userEvent.click(screen.getByRole('button', { name: /User menu/ }));

    expect(await screen.findByRole('menuitem', { name: 'Account' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('saves a language chosen in the menu to the account', async () => {
    render(
      <LanguageProvider>
        <UserMenu />
      </LanguageProvider>,
    );
    await settle();
    await userEvent.click(screen.getByRole('button', { name: /User menu/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Language' }));

    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'العربية' }));

    await waitFor(() => expect(saveLanguageToAccount).toHaveBeenCalledWith('ar'));
  });
});
