import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgotPasswordForm } from './forgot-password-form';

const requestPasswordReset = vi.fn();
vi.mock('./auth-client', () => ({ authClient: () => ({ requestPasswordReset }) }));

const loadConfig = vi.fn<() => Promise<unknown>>();
vi.mock('@/shell/client-config', () => ({ loadConfig: () => loadConfig() }));

const config = (mailEnabled: boolean) => ({ clientName: 'Acme', version: '1', mailEnabled });

async function submit(email = 'sam@example.com') {
  if (email) await userEvent.type(screen.getByLabelText(/^Email/), email);
  await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
}

describe('ForgotPasswordForm (AC-9, AC-10)', () => {
  beforeEach(() => loadConfig.mockResolvedValue(config(true)));
  afterEach(() => {
    requestPasswordReset.mockReset();
    loadConfig.mockReset();
  });

  it('has one top level heading and a required, labelled email field (AC-24)', async () => {
    render(<ForgotPasswordForm />);

    await waitFor(() => expect(loadConfig).toHaveBeenCalled());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText('Email(Required)')).toBeRequired();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('on an empty or mistyped email, names the problem and focuses the field', async () => {
    render(<ForgotPasswordForm />);

    await submit('');
    expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(
      'Enter your email address.',
    );
    expect(screen.getByLabelText(/^Email/)).toHaveFocus();

    await submit('sam@example');
    expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(
      'Enter a valid email address, like name@example.com.',
    );
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('asks for a reset with the trimmed email, then shows one neutral confirmation', async () => {
    requestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });
    render(<ForgotPasswordForm />);

    await submit('  Sam@Example.com ');

    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: 'Sam@Example.com',
      redirectTo: '/reset-password',
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Check your email' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('If that email belongs to an account');
  });

  it('says to ask an administrator, and offers no form, when the install sends no mail (AC-10)', async () => {
    loadConfig.mockResolvedValue(config(false));
    render(<ForgotPasswordForm />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ask an administrator' }),
    ).toBeVisible();
    expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('still offers the form when the settings cannot be loaded', async () => {
    loadConfig.mockResolvedValue(null);
    render(<ForgotPasswordForm />);

    expect(await screen.findByLabelText(/^Email/)).toBeVisible();
  });

  it.each([
    [429, 'Too many requests. Wait a few minutes, then try again.'],
    [500, 'Could not send the request. Check your connection and try again.'],
  ])('shows a clear message for a %s answer and keeps the form', async (status, message) => {
    requestPasswordReset.mockResolvedValue({ data: null, error: { status } });
    render(<ForgotPasswordForm />);

    await submit();

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByLabelText(/^Email/)).toBeVisible();
  });

  it('shows the same message when the request cannot be sent at all', async () => {
    requestPasswordReset.mockRejectedValue(new Error('offline'));
    render(<ForgotPasswordForm />);

    await submit();

    expect(
      await screen.findByText('Could not send the request. Check your connection and try again.'),
    ).toBeVisible();
  });
});
