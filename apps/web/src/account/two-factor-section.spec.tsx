import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwoFactorSection } from './two-factor-section';

const enable = vi.fn();
const verifyTotp = vi.fn();
const disable = vi.fn();
const generateBackupCodes = vi.fn();
vi.mock('@/auth/auth-client', () => ({
  authClient: () => ({ twoFactor: { enable, verifyTotp, disable, generateBackupCodes } }),
}));

const URI =
  'otpauth://totp/Acme%20Home:sam%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Home';
const CODES = ['aaaaa-11111', 'bbbbb-22222', 'ccccc-33333'];

afterEach(() => {
  for (const mock of [enable, verifyTotp, disable, generateBackupCodes]) mock.mockReset();
});

describe('TwoFactorSection (AC-20)', () => {
  it('shows the state and the buttons that fit it', () => {
    const { rerender } = render(<TwoFactorSection enabled={false} onChange={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Two factor sign in' })).toBeVisible();
    expect(screen.getByText('Off')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();

    rerender(<TwoFactorSection enabled onChange={vi.fn()} />);

    expect(screen.getByText('On')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New backup codes' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
  });

  describe('turning on, step by step', () => {
    async function toScanStep(onChange = vi.fn()) {
      enable.mockResolvedValue({ data: { totpURI: URI, backupCodes: CODES }, error: null });
      render(<TwoFactorSection enabled={false} onChange={onChange} />);
      await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
      const dialog = await screen.findByRole('dialog', { name: 'Turn on two factor' });
      await userEvent.type(within(dialog).getByLabelText(/^Password/), 'Correct-Horse-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
      return { dialog, onChange };
    }

    it('asks for the password first, and shows nothing secret until it is right', async () => {
      enable.mockResolvedValue({ data: null, error: { status: 400 } });
      render(<TwoFactorSection enabled={false} onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
      const dialog = await screen.findByRole('dialog');

      await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
      expect(within(dialog).getByLabelText(/^Password/)).toHaveAccessibleDescription(
        'Enter your password.',
      );
      expect(enable).not.toHaveBeenCalled();

      await userEvent.type(within(dialog).getByLabelText(/^Password/), 'Wrong-Password-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

      expect(
        await within(dialog).findByText('The password is not right. Check it and try again.'),
      ).toBeVisible();
      expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
    });

    it('shows the QR code and the setup key, but not the backup codes yet', async () => {
      const { dialog } = await toScanStep();

      expect(
        await screen.findByRole('dialog', { name: 'Scan with your authenticator app' }),
      ).toBeVisible();
      expect(
        within(dialog).getByRole('img', { name: 'QR code for your authenticator app' }),
      ).toBeVisible();
      expect(within(dialog).getByText('JBSW Y3DP EHPK 3PXP')).toBeVisible();
      expect(within(dialog).queryByText('aaaaa-11111')).not.toBeInTheDocument();
      expect(enable).toHaveBeenCalledWith({ password: 'Correct-Horse-1' });
    });

    it('keeps two factor off and says so when the first code is wrong', async () => {
      verifyTotp.mockResolvedValue({ data: null, error: { status: 401 } });
      const { dialog, onChange } = await toScanStep();

      await userEvent.type(await within(dialog).findByLabelText(/^Code from the app/), '000000');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));

      expect(
        await within(dialog).findByText(
          'That code is not right. Check the time on your phone and try again.',
        ),
      ).toBeVisible();
      expect(onChange).not.toHaveBeenCalled();
      expect(within(dialog).queryByText('aaaaa-11111')).not.toBeInTheDocument();
    });

    it('shows the backup codes only after the first code is confirmed, and reports it', async () => {
      verifyTotp.mockResolvedValue({ data: {}, error: null });
      const { dialog, onChange } = await toScanStep();

      await userEvent.type(await within(dialog).findByLabelText(/^Code from the app/), ' 123456 ');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));

      expect(verifyTotp).toHaveBeenCalledWith({ code: '123456' });
      expect(await screen.findByRole('dialog', { name: 'Save your backup codes' })).toBeVisible();
      const list = screen.getByRole('list', { name: 'Backup codes' });
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(CODES);
      expect(onChange).toHaveBeenCalledWith(true);

      await userEvent.click(screen.getByRole('button', { name: 'I saved them' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('copies the codes to the clipboard', async () => {
      verifyTotp.mockResolvedValue({ data: {}, error: null });
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const { dialog } = await toScanStep();
      await userEvent.type(await within(dialog).findByLabelText(/^Code from the app/), '123456');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Copy codes' }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODES.join('\n')));
      vi.unstubAllGlobals();
    });
  });

  describe('turning off and new backup codes', () => {
    it('turns off only with the password, and reports it', async () => {
      disable.mockResolvedValueOnce({ data: null, error: { status: 400 } });
      disable.mockResolvedValueOnce({ data: { status: true }, error: null });
      const onChange = vi.fn();
      render(<TwoFactorSection enabled onChange={onChange} />);
      await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
      const dialog = await screen.findByRole('dialog', { name: 'Turn off two factor?' });

      await userEvent.type(within(dialog).getByLabelText(/^Password/), 'Wrong-Password-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
      expect(
        await within(dialog).findByText('The password is not right. Check it and try again.'),
      ).toBeVisible();
      expect(onChange).not.toHaveBeenCalled();

      await userEvent.clear(within(dialog).getByLabelText(/^Password/));
      await userEvent.type(within(dialog).getByLabelText(/^Password/), 'Correct-Horse-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));

      await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
      expect(disable).toHaveBeenLastCalledWith({ password: 'Correct-Horse-1' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('makes new backup codes with the password and shows them once', async () => {
      generateBackupCodes.mockResolvedValue({ data: { backupCodes: CODES }, error: null });
      render(<TwoFactorSection enabled onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'New backup codes' }));
      const dialog = await screen.findByRole('dialog', { name: 'Make new backup codes?' });

      await userEvent.type(within(dialog).getByLabelText(/^Password/), 'Correct-Horse-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Make new codes' }));

      const list = await within(dialog).findByRole('list', { name: 'Backup codes' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(3);
      expect(generateBackupCodes).toHaveBeenCalledWith({ password: 'Correct-Horse-1' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'I saved them' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it.each([
      [429, 'Too many attempts. Wait a minute, then try again.'],
      [500, 'Something went wrong. Check your connection and try again.'],
    ])('shows a clear message for a %s answer', async (status, text) => {
      disable.mockResolvedValue({ data: null, error: { status } });
      render(<TwoFactorSection enabled onChange={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
      const dialog = await screen.findByRole('dialog');

      await userEvent.type(within(dialog).getByLabelText(/^Password/), 'x');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));

      expect(await within(dialog).findByText(text)).toBeVisible();
    });
  });
});
