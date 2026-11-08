import { LICENSE_ENVELOPE_MAX_BYTES } from '@ssdashboard/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { activeSummary } from './license-fixtures';
import { LicenseUploadDialog } from './license-upload-dialog';

const api = vi.hoisted(() => ({ uploadLicense: vi.fn() }));
vi.mock('./license-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  api.uploadLicense.mockReset();
  toast.success.mockReset();
});

const licenseFile = (text = '{"keyId":"dev-1"}', name = 'license.json') =>
  new File([text], name, { type: 'application/json' });

async function pick(file: File) {
  const input = screen.getByLabelText('License file');
  await userEvent.upload(input, file);
}

const send = () => userEvent.click(screen.getByRole('button', { name: 'Upload' }));

function open(onClose = vi.fn()) {
  renderWithQuery(<LicenseUploadDialog onClose={onClose} />);
  return onClose;
}

describe('LicenseUploadDialog (AC-20)', () => {
  it('reads the chosen file as text, sends it, and says it was recorded', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: true,
      resumingSteps: [],
    });
    const onClose = open();
    await pick(licenseFile('{"keyId":"dev-1","payload":"x"}'));
    expect(screen.getByText('license.json')).toBeVisible();
    await send();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.uploadLicense).toHaveBeenCalledWith('{"keyId":"dev-1","payload":"x"}');
    expect(toast.success).toHaveBeenCalledWith('License recorded.');
  });

  it('keeps the dialog open to name the steps that resume after a renewal', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: true,
      resumingSteps: ['currency'],
    });
    const onClose = open();
    await pick(licenseFile());
    await send();

    expect(await screen.findByText('These steps will start working again:')).toBeVisible();
    expect(screen.getByText(/They act only on new events/)).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'License recorded' })).toHaveAccessibleDescription(
      /These steps will start working again:.*Currency.*They act only on new events/,
    );
    expect(onClose).not.toHaveBeenCalled();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toHaveFocus();
    await userEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it('says nothing changed when the license adds nothing new', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: false,
      resumingSteps: [],
    });
    const onClose = open();
    await pick(licenseFile());
    await send();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Nothing changed: this license adds nothing new.');
  });

  it('asks for a file before sending anything, and focuses the file input', async () => {
    open();
    await send();

    const input = screen.getByLabelText('License file');
    expect(await screen.findByText('Choose a license file.')).toBeVisible();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Choose a license file.');
    expect(api.uploadLicense).not.toHaveBeenCalled();
  });

  it('refuses a file over 16 KB without sending it', async () => {
    open();
    await pick(licenseFile('x'.repeat(LICENSE_ENVELOPE_MAX_BYTES + 1)));
    await send();

    expect(
      await screen.findByText('This file is larger than 16 KB, so it is not a license file.'),
    ).toBeVisible();
    expect(api.uploadLicense).not.toHaveBeenCalled();
  });

  it('measures bytes, not characters: a multibyte file over 16 KB is refused unsent', async () => {
    open();
    // 8193 two byte characters are 16386 bytes, though only 8193 characters.
    await pick(licenseFile('é'.repeat(LICENSE_ENVELOPE_MAX_BYTES / 2 + 1)));
    await send();

    expect(await screen.findByText(/larger than 16 KB/)).toBeVisible();
    expect(api.uploadLicense).not.toHaveBeenCalled();
  });

  it('sends a multibyte file that is exactly at the limit', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: true,
      resumingSteps: [],
    });
    const onClose = open();
    await pick(licenseFile('é'.repeat(LICENSE_ENVELOPE_MAX_BYTES / 2)));
    await send();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.uploadLicense).toHaveBeenCalledTimes(1);
  });

  it('never sends a byte order mark', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: true,
      resumingSteps: [],
    });
    open();
    await pick(licenseFile('\uFEFF{"keyId":"dev-1"}'));
    await send();
    await waitFor(() => expect(api.uploadLicense).toHaveBeenCalled());
    const sent = api.uploadLicense.mock.calls[0]?.[0] as string;
    expect(sent.includes('\uFEFF')).toBe(false);
    expect(sent).toBe('{"keyId":"dev-1"}');
  });

  it('refuses an empty file and a file of blanks without sending them', async () => {
    open();
    await pick(licenseFile(''));
    await send();
    expect(
      await screen.findByText('This is not a license file. Choose the file you received.'),
    ).toBeVisible();
    await pick(licenseFile('  \n '));
    await send();
    expect(api.uploadLicense).not.toHaveBeenCalled();
  });

  it('sends once when Upload is pressed twice while the file is still being read', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: true,
      resumingSteps: [],
    });
    open();
    const slow = licenseFile();
    Object.defineProperty(slow, 'text', {
      value: () => new Promise<string>((resolve) => setTimeout(() => resolve('{"a":1}'), 50)),
    });
    await pick(slow);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(api.uploadLicense).toHaveBeenCalledTimes(1));
  });

  it('blocks Cancel and Escape while the file is being read, and the upload still goes through', async () => {
    api.uploadLicense.mockResolvedValue({
      summary: activeSummary,
      changed: true,
      resumingSteps: [],
    });
    const onClose = open();
    const slow = licenseFile();
    Object.defineProperty(slow, 'text', {
      value: () => new Promise<string>((resolve) => setTimeout(() => resolve('{"a":1}'), 80)),
    });
    await pick(slow);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();

    await waitFor(() => expect(api.uploadLicense).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['bad_format', 'This file is not in the license format. Choose the file you received.'],
    [
      'bad_signature',
      'This license was changed after it was issued, so it was refused. Ask for a new file.',
    ],
    [
      'unknown_key',
      'This license was signed with a key this install does not know. Ask for a new file.',
    ],
    ['dev_key_in_production', 'This is a development license. A live install does not accept it.'],
    ['wrong_install', 'This license was issued for a different install. Ask for the right file.'],
    ['file_missing', 'The license was refused. Nothing was changed.'],
  ])('gives the %s outcome its own sentence on the file field', async (outcome, sentence) => {
    api.uploadLicense.mockRejectedValue(new ApiError(422, { code: 'LICENSE_INVALID', outcome }));
    const onClose = open();
    await pick(licenseFile());
    await send();

    expect(await screen.findByText(sentence)).toBeVisible();
    expect(screen.getByLabelText('License file')).toHaveFocus();
    expect(screen.getByLabelText('License file')).toHaveAccessibleDescription(sentence);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('words 413 and a body that is not a license', async () => {
    api.uploadLicense.mockRejectedValueOnce(new ApiError(413, { code: 'LICENSE_TOO_LARGE' }));
    open();
    await pick(licenseFile());
    await send();
    expect(await screen.findByText(/larger than 16 KB/)).toBeVisible();

    api.uploadLicense.mockRejectedValueOnce(new ApiError(422, { code: 'VALIDATION_FAILED' }));
    await send();
    expect(
      await screen.findByText('This is not a license file. Choose the file you received.'),
    ).toBeVisible();
  });

  it('shows a general failure in an alert, and a missing permission in its own words', async () => {
    api.uploadLicense.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    open();
    await pick(licenseFile());
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The license was not uploaded. Try again.',
    );

    api.uploadLicense.mockRejectedValueOnce(new ApiError(403, { code: 'FORBIDDEN' }));
    await send();
    expect(
      await screen.findByText('You do not have permission to upload a license.'),
    ).toBeVisible();
  });

  it('clears a file error when another file is chosen, and Cancel closes', async () => {
    const onClose = open();
    await send();
    expect(await screen.findByText('Choose a license file.')).toBeVisible();
    await pick(licenseFile());
    expect(screen.queryByText('Choose a license file.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
