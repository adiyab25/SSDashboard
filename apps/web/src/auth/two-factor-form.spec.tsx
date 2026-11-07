import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoFactorForm } from './two-factor-form';

const verifyTotp = vi.fn();
const verifyBackupCode = vi.fn();
vi.mock('./auth-client', () => ({
  authClient: () => ({ twoFactor: { verifyTotp, verifyBackupCode } }),
}));

const fetchMock = vi.fn();

const assign = vi.fn();

function atPage(search = '') {
  vi.stubGlobal('location', { origin: 'https://erp.example.com', search, assign });
}

async function verify(code = '123456') {
  if (code) await userEvent.type(screen.getByLabelText(/^(Code|Backup code)/), code);
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('TwoFactorForm (AC-20, AC-3)', () => {
  beforeEach(() => {
    atPage();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
  });
  afterEach(() => {
    verifyTotp.mockReset();
    verifyBackupCode.mockReset();
    fetchMock.mockReset();
    assign.mockReset();
    vi.unstubAllGlobals();
  });

  it('has one heading and a labelled, required code field a phone can fill (AC-24)', () => {
    render(<TwoFactorForm />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const field = screen.getByLabelText('Code(Required)');
    expect(field).toBeRequired();
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).not.toHaveAttribute('onpaste');
  });

  it('does not send an empty code, and focuses the field', async () => {
    render(<TwoFactorForm />);

    await verify('');

    const field = screen.getByLabelText(/^Code/);
    expect(field).toHaveAccessibleDescription('Enter the code.');
    expect(field).toHaveFocus();
    expect(verifyTotp).not.toHaveBeenCalled();
  });

  it('sends the app code, applies the saved language, then opens the page they were going to', async () => {
    atPage('?returnTo=%2Fstaff%3Fq%3Dsam');
    verifyTotp.mockResolvedValue({ data: {}, error: null });
    render(<TwoFactorForm />);

    await verify(' 123456 ');

    expect(verifyTotp).toHaveBeenCalledWith({ code: '123456' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/staff?q=sam'));
    expect(fetchMock).toHaveBeenCalledWith('/api/me', { cache: 'no-store' });
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
    verifyTotp.mockResolvedValue({ data: {}, error: null });
    render(<TwoFactorForm />);

    await verify();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('switches to a backup code and back, clearing what was typed', async () => {
    verifyBackupCode.mockResolvedValue({ data: {}, error: null });
    render(<TwoFactorForm />);
    await userEvent.type(screen.getByLabelText(/^Code/), '123');

    await userEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Use a backup code' })).toBeVisible();
    const field = screen.getByLabelText(/^Backup code/);
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('inputmode', 'text');

    await userEvent.type(field, 'abcde-12345');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(verifyBackupCode).toHaveBeenCalledWith({ code: 'abcde-12345' });
    expect(verifyTotp).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Use my authenticator app instead' }));
    expect(screen.getByLabelText(/^Code/)).toHaveValue('');
  });

  it.each([
    [false, 401, 'That code is not right. Check it and try again.'],
    [true, 401, 'That backup code is not right, or it was already used.'],
    [false, 429, 'Too many attempts. Wait a few minutes, then try again.'],
    [false, 500, 'Could not check the code. Check your connection and try again.'],
  ])(
    'with backup=%s shows a clear message for a %s answer and keeps the form',
    async (backup, status, message) => {
      (backup ? verifyBackupCode : verifyTotp).mockResolvedValue({ data: null, error: { status } });
      render(<TwoFactorForm />);
      if (backup)
        await userEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));

      await verify();

      expect(await screen.findByText(message)).toBeVisible();
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/^(Code|Backup code)/)).toHaveFocus();
    },
  );

  it('tells the person to start again when the sign in has ended', async () => {
    verifyTotp.mockResolvedValue({
      data: null,
      error: { status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' },
    });
    render(<TwoFactorForm />);

    await verify();

    expect(
      await screen.findByRole('heading', { level: 1, name: /expired or was stopped/ }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it.each([false, true])(
    'says the account has no access, not a connection problem, on a 403 NO_ACCESS (backup=%s, review r2)',
    async (backup) => {
      (backup ? verifyBackupCode : verifyTotp).mockResolvedValue({
        data: null,
        error: { status: 403, code: 'NO_ACCESS' },
      });
      render(<TwoFactorForm />);
      if (backup)
        await userEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));

      await verify();

      expect(
        await screen.findByText('This account has no access yet. Ask a manager to give you a hat.'),
      ).toBeVisible();
      expect(screen.queryByText(/Check your connection/)).not.toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
    },
  );
});
