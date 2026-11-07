import type { MeResponse } from '@ssdashboard/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPage } from './account-page';

const updateProfile = vi.hoisted(() => vi.fn());
vi.mock('@/auth/account-api', () => ({ updateProfile }));

const changePassword = vi.fn();
vi.mock('@/auth/auth-client', () => ({ authClient: () => ({ changePassword }) }));

const ME: MeResponse = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam Carter',
  email: 'sam@example.com',
  hats: ['support', 'operations', 'warehouse'],
  permissions: ['stock.view'],
  partnerAccountId: null,
  phone: '+20 100 123 4567',
  staffCode: 'SC1',
  language: 'ar',
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'backoffice',
};

const me = vi.hoisted((): { current: unknown; failed: boolean; attempts: number[] } => ({
  current: null,
  failed: false,
  attempts: [],
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: (_path: string, attempt: number) => {
    me.attempts.push(attempt);
    if (me.current) return { status: 'ready', me: me.current };
    return { status: me.failed ? 'failed' : 'loading' };
  },
  setMe: () => undefined,
}));

const loadConfig = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('@/shell/client-config', () => ({ loadConfig: () => loadConfig() }));

describe('AccountPage (AC-8, AC-19)', () => {
  beforeEach(() => {
    me.current = ME;
    me.failed = false;
    me.attempts = [];
    loadConfig.mockResolvedValue({ languages: ['en', 'ar'], mailEnabled: false });
  });
  afterEach(() => {
    updateProfile.mockReset();
    changePassword.mockReset();
    loadConfig.mockReset();
  });

  it('shows a loading state until the person is known', () => {
    me.current = null;
    render(<AccountPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading your account…');
    expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument();
  });

  it('shows an inline error, not an endless loader, when the person could not be loaded', async () => {
    me.current = null;
    me.failed = true;
    render(<AccountPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your account could not be loaded.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('offers Try again on that error, which asks for the person once more', async () => {
    me.current = null;
    me.failed = true;
    render(<AccountPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(me.attempts).toContain(1);
  });

  describe('your details', () => {
    it('has one heading, shows email, hats and staff code as text, and edits only name, phone and language', async () => {
      render(<AccountPage />);

      expect(await screen.findByLabelText(/^Name/)).toHaveValue('Sam Carter');
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByLabelText('Phone')).toHaveValue('+20 100 123 4567');
      expect(screen.getByLabelText('Language')).toHaveValue('ar');
      expect(screen.getByText('sam@example.com')).toBeVisible();
      expect(screen.getByText('Support, Operations, Warehouse')).toBeVisible();
      expect(screen.getByText('SC1')).toBeVisible();
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Hats')).not.toBeInTheDocument();
      expect(screen.getByText('A manager changes your email, hats and staff code.')).toBeVisible();
    });

    it('saves the changes and says so', async () => {
      updateProfile.mockResolvedValue({ ok: true, me: ME });
      render(<AccountPage />);
      const name = await screen.findByLabelText(/^Name/);
      await userEvent.clear(name);
      await userEvent.type(name, 'Samira Ali');
      await userEvent.clear(screen.getByLabelText('Phone'));
      await userEvent.selectOptions(screen.getByLabelText('Language'), 'en');

      await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

      expect(updateProfile).toHaveBeenCalledWith(
        { name: 'Samira Ali', phone: '', language: 'en' },
        'backoffice',
      );
      expect(await screen.findByText('Your details are saved.')).toBeVisible();
    });

    it('does not send an empty name or a bad phone, and focuses the field', async () => {
      render(<AccountPage />);
      const name = await screen.findByLabelText(/^Name/);
      await userEvent.clear(name);
      await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

      expect(name).toHaveAccessibleDescription('Enter your name.');
      expect(name).toHaveFocus();

      await userEvent.type(name, 'Sam');
      await userEvent.clear(screen.getByLabelText('Phone'));
      await userEvent.type(screen.getByLabelText('Phone'), '12');
      await userEvent.click(screen.getByRole('button', { name: 'Save details' }));
      expect(screen.getByLabelText('Phone')).toHaveAccessibleDescription(
        'Use 5 to 30 digits, plus signs or spaces.',
      );
      expect(updateProfile).not.toHaveBeenCalled();
    });

    it.each([
      ['INVALID_LANGUAGE', 'That language is not enabled on this install.'],
      ['generic', 'Could not save your details. Check your connection and try again.'],
    ])('shows a clear message for %s and keeps what was typed', async (code, message) => {
      updateProfile.mockResolvedValue({ ok: false, status: 422, code });
      render(<AccountPage />);
      await screen.findByLabelText(/^Name/);

      await userEvent.click(screen.getByRole('button', { name: 'Save details' }));

      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.getByLabelText(/^Name/)).toHaveValue('Sam Carter');
    });
  });

  describe('your password', () => {
    async function change(current = 'Old-Password-1', next = 'Brand-New-Pass-9') {
      await screen.findByLabelText(/^Name/);
      if (current) await userEvent.type(screen.getByLabelText(/^Current password/), current);
      if (next) await userEvent.type(screen.getByLabelText(/^New password/), next);
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    }

    it('shows the rules before submit and suits password managers', async () => {
      render(<AccountPage />);

      await screen.findByLabelText(/^Name/);
      expect(screen.getByLabelText(/^Current password/)).toHaveAttribute(
        'autocomplete',
        'current-password',
      );
      expect(screen.getByLabelText(/^New password/)).toHaveAttribute(
        'autocomplete',
        'new-password',
      );
      expect(screen.getByRole('list', { name: 'Your password needs' })).toBeVisible();
    });

    it('changes it ending the other sessions, then clears the fields and says so', async () => {
      changePassword.mockResolvedValue({ data: {}, error: null });
      render(<AccountPage />);

      await change();

      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: 'Old-Password-1',
        newPassword: 'Brand-New-Pass-9',
        revokeOtherSessions: true,
      });
      expect(
        await screen.findByText('Your password is changed. Your other sessions were signed out.'),
      ).toBeVisible();
      expect(screen.getByLabelText(/^Current password/)).toHaveValue('');
      expect(screen.getByLabelText(/^New password/)).toHaveValue('');
    });

    it('sends nothing without the current password or with a weak one, and focuses the field', async () => {
      render(<AccountPage />);

      await change('', 'Brand-New-Pass-9');
      expect(screen.getByLabelText(/^Current password/)).toHaveFocus();

      await userEvent.type(screen.getByLabelText(/^Current password/), 'x');
      await userEvent.clear(screen.getByLabelText(/^New password/));
      await userEvent.type(screen.getByLabelText(/^New password/), 'abc');
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
      expect(screen.getByLabelText(/^New password/)).toHaveFocus();
      expect(changePassword).not.toHaveBeenCalled();
    });

    it.each([
      [400, 'The current password is not right. Check it and try again.'],
      [422, 'That password does not meet the rules yet. Check the list and try again.'],
      [429, 'Too many attempts. Wait a minute, then try again.'],
      [500, 'Could not change the password. Check your connection and try again.'],
    ])('shows a clear message for a %s answer', async (status, message) => {
      changePassword.mockResolvedValue({ data: null, error: { status } });
      render(<AccountPage />);

      await change();

      expect(await screen.findByText(message)).toBeVisible();
      await waitFor(() =>
        expect(screen.getByLabelText(/^New password/)).toHaveValue('Brand-New-Pass-9'),
      );
    });
  });
});
