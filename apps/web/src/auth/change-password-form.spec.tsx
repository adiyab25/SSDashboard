import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangePasswordForm } from './change-password-form';

const changePassword = vi.fn();
const signOut = vi.fn();
vi.mock('./auth-client', () => ({ authClient: () => ({ changePassword, signOut }) }));

const assign = vi.fn();

function atPage(search = '') {
  vi.stubGlobal('location', { origin: 'https://erp.example.com', search, assign });
}

async function fillAndSave(current = 'Temp-Pass-123456', next = 'Brand-New-Pass-9') {
  if (current) await userEvent.type(screen.getByLabelText(/^Current password/), current);
  if (next) await userEvent.type(screen.getByLabelText(/^New password/), next);
  await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('ChangePasswordForm (AC-8, AC-14)', () => {
  beforeEach(() => atPage());
  afterEach(() => {
    changePassword.mockReset();
    signOut.mockReset();
    assign.mockReset();
    vi.unstubAllGlobals();
  });

  it('has one heading, labelled required fields, and the right autocomplete values (AC-24)', () => {
    render(<ChangePasswordForm />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText('Current password(Required)')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(screen.getByLabelText('New password(Required)')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(screen.getByRole('list', { name: 'Your password needs' })).toBeVisible();
  });

  it('does not send a missing current password or a weak new one, and focuses the field', async () => {
    render(<ChangePasswordForm />);

    await fillAndSave('', 'Brand-New-Pass-9');
    expect(screen.getByLabelText(/^Current password/)).toHaveFocus();
    expect(screen.getByLabelText(/^Current password/)).toHaveAccessibleDescription(
      'Enter your current password.',
    );

    await userEvent.type(screen.getByLabelText(/^Current password/), 'x');
    await userEvent.clear(screen.getByLabelText(/^New password/));
    await userEvent.type(screen.getByLabelText(/^New password/), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByLabelText(/^New password/)).toHaveFocus();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('changes the password, ending other sessions, then opens the page they were going to', async () => {
    atPage('?returnTo=%2Fstaff%3Fq%3Dsam');
    changePassword.mockResolvedValue({ data: {}, error: null });
    render(<ChangePasswordForm />);

    await fillAndSave();

    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'Temp-Pass-123456',
      newPassword: 'Brand-New-Pass-9',
      revokeOtherSessions: true,
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/staff?q=sam'));
  });

  it.each([
    '//evil.example',
    'https://evil.example',
    '/.//evil.example',
    '/%2e//evil.example',
    '/a/..//evil.example',
    '/%2e%2e//evil.example',
    '/stock/..//evil.example/x',
  ])('ignores an unsafe returnTo (%s)', async (returnTo) => {
    atPage(`?returnTo=${encodeURIComponent(returnTo)}`);
    changePassword.mockResolvedValue({ data: {}, error: null });
    render(<ChangePasswordForm />);

    await fillAndSave();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it.each([
    [400, 'The current password is not right. Check it and try again.'],
    [422, 'That password does not meet the rules yet. Check the list and try again.'],
    [429, 'Too many attempts. Wait a minute, then try again.'],
    [500, 'Could not change the password. Check your connection and try again.'],
  ])('shows a clear message for a %s answer and stays on the form', async (status, message) => {
    changePassword.mockResolvedValue({ data: null, error: { status } });
    render(<ChangePasswordForm />);

    await fillAndSave();

    expect(await screen.findByText(message)).toBeVisible();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^New password/)).toHaveValue('Brand-New-Pass-9');
  });

  it('lets the person sign out instead', async () => {
    signOut.mockResolvedValue({ error: null });
    render(<ChangePasswordForm />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out instead' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/sign-in'));
  });
});
