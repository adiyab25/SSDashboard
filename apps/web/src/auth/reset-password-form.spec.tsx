import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResetPasswordForm } from './reset-password-form';

const resetPassword = vi.fn();
vi.mock('./auth-client', () => ({ authClient: () => ({ resetPassword }) }));

function atPage(search: string) {
  vi.stubGlobal('location', { origin: 'https://erp.example.com', search });
}

async function save(password = 'Brand-New-Pass-9') {
  const field = await screen.findByLabelText(/^New password/);
  if (password) await userEvent.type(field, password);
  await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
}

describe('ResetPasswordForm (AC-8, AC-9, AC-13)', () => {
  afterEach(() => {
    resetPassword.mockReset();
    vi.unstubAllGlobals();
  });

  describe('a dead link', () => {
    it.each([
      ['an INVALID_TOKEN redirect', '?error=INVALID_TOKEN'],
      ['no token at all', ''],
    ])('shows the invalid link screen before any typing for %s', async (_name, search) => {
      atPage(search);
      render(<ResetPasswordForm />);

      const heading = await screen.findByRole('heading', {
        level: 1,
        name: 'This link is no longer valid',
      });
      expect(heading).toHaveFocus();
      expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
        'href',
        '/forgot-password',
      );
      expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument();
    });
  });

  describe('the form', () => {
    it('has one heading, a new password field that suits password managers, and no paste block', async () => {
      atPage('?token=abc');
      render(<ResetPasswordForm />);

      const field = await screen.findByLabelText(/^New password/);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Choose a new password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
      expect(field).toBeRequired();
      expect(field).not.toHaveAttribute('onpaste');
    });

    it('uses the invite wording for ?invite=1', async () => {
      atPage('?token=abc&invite=1');
      render(<ResetPasswordForm />);

      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
        'Set your password',
      );
    });

    it('shows the rules before submit and ticks them off as the person types', async () => {
      atPage('?token=abc');
      render(<ResetPasswordForm />);
      const field = await screen.findByLabelText(/^New password/);

      const rules = screen.getByRole('list', { name: 'Your password needs' });
      expect(rules).toHaveTextContent('At least 8 characters');
      expect(rules).toHaveTextContent('A lowercase letter');
      expect(rules).toHaveTextContent('An uppercase letter');
      expect(rules).toHaveTextContent('A number');
      expect(rules).not.toHaveTextContent('Done');

      await userEvent.type(field, 'Abcdefg1');

      const items = screen.getAllByRole('listitem');
      expect(items.every((item) => item.textContent?.includes('Done'))).toBe(true);
      expect(field).toHaveAccessibleDescription(/Your password needs/);
    });

    it('lets the person see what they typed', async () => {
      atPage('?token=abc');
      render(<ResetPasswordForm />);
      const field = await screen.findByLabelText(/^New password/);
      expect(field).toHaveAttribute('type', 'password');

      await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

      expect(field).toHaveAttribute('type', 'text');
      expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('does not send a weak password, and says so with focus on the field', async () => {
      atPage('?token=abc');
      render(<ResetPasswordForm />);

      await save('abc');

      expect(resetPassword).not.toHaveBeenCalled();
      const field = screen.getByLabelText(/^New password/);
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveFocus();
      expect(field).toHaveAccessibleDescription(/does not meet the rules/);
    });
  });

  describe('saving', () => {
    it('sends the token and the password as typed, then shows the done screen', async () => {
      atPage('?token=abc123');
      resetPassword.mockResolvedValue({ data: { status: true }, error: null });
      render(<ResetPasswordForm />);

      await save('Brand-New-Pass-9');

      expect(resetPassword).toHaveBeenCalledWith({
        newPassword: 'Brand-New-Pass-9',
        token: 'abc123',
      });
      const heading = await screen.findByRole('heading', {
        level: 1,
        name: 'Your password is set',
      });
      expect(heading).toHaveFocus();
      expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
        'href',
        '/sign-in',
      );
    });

    it('switches to the invalid link screen when the token turns out to be used', async () => {
      atPage('?token=abc');
      resetPassword.mockResolvedValue({
        data: null,
        error: { status: 400, code: 'INVALID_TOKEN' },
      });
      render(<ResetPasswordForm />);

      await save();

      expect(
        await screen.findByRole('heading', { level: 1, name: 'This link is no longer valid' }),
      ).toBeVisible();
    });

    it.each([
      [422, 'That password does not meet the rules yet. Check the list and try again.'],
      [429, 'Too many attempts. Wait a few minutes, then try again.'],
      [500, 'Could not save the password. Check your connection and try again.'],
    ])(
      'shows a clear message for a %s answer and keeps the form and the password',
      async (status, message) => {
        atPage('?token=abc');
        resetPassword.mockResolvedValue({ data: null, error: { status } });
        render(<ResetPasswordForm />);

        await save('Brand-New-Pass-9');

        expect(await screen.findByText(message)).toBeVisible();
        await waitFor(() =>
          expect(screen.getByLabelText(/^New password/)).toHaveValue('Brand-New-Pass-9'),
        );
      },
    );

    it('shows the failure message when the request cannot be sent', async () => {
      atPage('?token=abc');
      resetPassword.mockRejectedValue(new Error('offline'));
      render(<ResetPasswordForm />);

      await save();

      expect(
        await screen.findByText(
          'Could not save the password. Check your connection and try again.',
        ),
      ).toBeVisible();
    });
  });
});
