import type { LicenseSummary } from '@ssdashboard/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { activeSummary, emptySummary, recordedLicense } from './license-fixtures';
import { LicenseSection } from './license-section';

const api = vi.hoisted(() => ({ getLicense: vi.fn(), uploadLicense: vi.fn() }));
vi.mock('./license-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

afterEach(() => {
  api.getLicense.mockReset();
  api.uploadLicense.mockReset();
});

const withCheck = (check: LicenseSummary['lastCheck']): LicenseSummary => ({
  ...activeSummary,
  lastCheck: check,
});

describe('LicenseSection (AC-25, AC-26)', () => {
  it('shows Core always on and each plan with its phase and expiry', async () => {
    api.getLicense.mockResolvedValue(activeSummary);
    renderWithQuery(<LicenseSection enabled />);

    await screen.findByRole('heading', { name: 'Operations' });
    expect(screen.getByRole('heading', { level: 2, name: 'Modules and license' })).toBeVisible();
    const core = screen.getByRole('heading', { name: 'Core' }).closest('li');
    expect(within(core as HTMLElement).getByText('Always on')).toBeVisible();

    const warehouse = screen.getByRole('heading', { name: 'Warehouse' }).closest('li');
    expect(within(warehouse as HTMLElement).getByText('Active')).toBeVisible();
    expect(within(warehouse as HTMLElement).getByText('Never ends')).toBeVisible();

    const operations = screen.getByRole('heading', { name: 'Operations' }).closest('li');
    expect(within(operations as HTMLElement).getByText('Active')).toBeVisible();
    expect(within(operations as HTMLElement).getByText(/Ends on 7 Nov 2027/)).toBeVisible();
    expect(within(operations as HTMLElement).getByText('Days left: 365')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Modules and license' })).toHaveAttribute(
      'id',
      'license',
    );
  });

  it('words every phase and says when a plan that is in grace stops', async () => {
    api.getLicense.mockResolvedValue({
      ...activeSummary,
      bundles: [
        { ...activeSummary.bundles[0], phase: 'off' },
        {
          bundle: 'operations',
          phase: 'grace',
          perpetual: false,
          expiresOn: '2026-11-01',
          daysLeft: -6,
          lapsesAt: '2026-11-15T22:00:00.000Z',
        },
      ],
    });
    renderWithQuery(<LicenseSection enabled />);

    const operations = (await screen.findByRole('heading', { name: 'Operations' })).closest('li');
    expect(within(operations as HTMLElement).getByText('Grace period')).toBeVisible();
    expect(within(operations as HTMLElement).getByText(/Ended on 1 Nov 2026/)).toBeVisible();
    expect(within(operations as HTMLElement).getByText(/Stops on/)).toBeVisible();
    const warehouse = screen.getByRole('heading', { name: 'Warehouse' }).closest('li');
    expect(within(warehouse as HTMLElement).getByText('Off')).toBeVisible();
    expect(within(warehouse as HTMLElement).getByText(/Stopped\. Record a renewal/)).toBeVisible();
  });

  it('names the steps waiting for a renewal, and nothing when none wait', async () => {
    api.getLicense.mockResolvedValue({ ...activeSummary, resumingSteps: ['currency'] });
    const view = renderWithQuery(<LicenseSection enabled />);
    expect(
      await screen.findByText(/resume when the license is renewed, acting only on new events/),
    ).toBeVisible();
    view.unmount();

    api.getLicense.mockResolvedValue({ ...activeSummary, resumingSteps: [] });
    renderWithQuery(<LicenseSection enabled />);
    await screen.findByRole('heading', { name: 'Operations' });
    expect(screen.queryByText(/resume when the license is renewed/)).toBeNull();
  });

  it('lists the recorded licenses with source, dates, and what each grants', async () => {
    api.getLicense.mockResolvedValue(activeSummary);
    renderWithQuery(<LicenseSection enabled />);

    const row = (await screen.findByText(recordedLicense.licenseId)).closest('li');
    expect(
      within(row as HTMLElement).getByText('From the license file on the server'),
    ).toBeVisible();
    expect(within(row as HTMLElement).getByText(/Issued on 7 Nov 2026/)).toBeVisible();
    expect(within(row as HTMLElement).getByText('Warehouse: never ends')).toBeVisible();
    expect(within(row as HTMLElement).getByText('Operations: until 7 Nov 2027')).toBeVisible();
  });

  it('shows the empty state for an install with no license, and the unlicensed plans', async () => {
    api.getLicense.mockResolvedValue(emptySummary);
    renderWithQuery(<LicenseSection enabled />);

    expect(await screen.findByText(/No license has been recorded yet/)).toBeVisible();
    expect(screen.getByText('The license file has not been checked yet.')).toBeVisible();
    expect(screen.getAllByText('Not licensed')).toHaveLength(2);
  });

  it('shows a problem check as an alert that says recorded licenses keep counting', async () => {
    api.getLicense.mockResolvedValue(
      withCheck({
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'daily',
        outcome: 'file_missing',
        clockBehind: false,
      }),
    );
    renderWithQuery(<LicenseSection enabled />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The license file is missing from the server.')).toBeVisible();
    expect(within(alert).getByText(/keep counting/)).toBeVisible();
  });

  it('shows a damaged file as an alert even when licenses are recorded', async () => {
    api.getLicense.mockResolvedValue(
      withCheck({
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'daily',
        outcome: 'bad_signature',
        clockBehind: false,
      }),
    );
    renderWithQuery(<LicenseSection enabled />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/changed after it was issued/)).toBeVisible();
  });

  it('shows no file configured as an alert while no license was ever recorded', async () => {
    api.getLicense.mockResolvedValue({
      ...emptySummary,
      lastCheck: {
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'api_start',
        outcome: 'none_configured',
        clockBehind: false,
      },
    });
    renderWithQuery(<LicenseSection enabled />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('No license file is set up on this install.')).toBeVisible();
  });

  it('on a fresh install the problem hint does not claim recorded licenses keep counting', async () => {
    api.getLicense.mockResolvedValue({
      ...emptySummary,
      lastCheck: {
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'api_start',
        outcome: 'file_missing',
        clockBehind: false,
      },
    });
    renderWithQuery(<LicenseSection enabled />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/No plan is licensed yet/)).toBeVisible();
    expect(within(alert).queryByText(/keep counting/)).toBeNull();
  });

  it('shows no file configured as plain information once a license is recorded', async () => {
    api.getLicense.mockResolvedValue(
      withCheck({
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'api_start',
        outcome: 'none_configured',
        clockBehind: false,
      }),
    );
    renderWithQuery(<LicenseSection enabled />);

    expect(await screen.findByText('No license file is set up on this install.')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/keep counting/)).toBeNull();
  });

  it('words each trigger in one sentence with the date', async () => {
    api.getLicense.mockResolvedValue(
      withCheck({
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'worker_start',
        outcome: 'valid',
        clockBehind: false,
      }),
    );
    renderWithQuery(<LicenseSection enabled />);
    expect(await screen.findByText(/when the background worker started\./)).toBeVisible();
  });

  it('shows a valid check as plain text, and a clock found behind as information, not an alert', async () => {
    api.getLicense.mockResolvedValue(
      withCheck({
        checkedAt: '2026-11-07T10:00:00.000Z',
        trigger: 'api_start',
        outcome: 'valid',
        clockBehind: true,
      }),
    );
    renderWithQuery(<LicenseSection enabled />);

    expect(await screen.findByText('A valid license was found and recorded.')).toBeVisible();
    expect(screen.getByText(/more than a day behind/)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a loading shape, then an error with Try again that loads it', async () => {
    api.getLicense.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    const { container } = renderWithQuery(<LicenseSection enabled />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText(/license could not be loaded/)).toBeVisible();

    api.getLicense.mockResolvedValue(activeSummary);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeVisible();
  });

  it('says there is no permission on a 403 and offers no retry or upload', async () => {
    api.getLicense.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' }));
    renderWithQuery(<LicenseSection enabled />);

    expect(await screen.findByText('You do not have permission to change settings.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload a license file' })).toBeDisabled();
  });

  it('asks for nothing before access is known', () => {
    renderWithQuery(<LicenseSection enabled={false} />);
    expect(api.getLicense).not.toHaveBeenCalled();
  });

  it('opens the upload dialog from its button', async () => {
    api.getLicense.mockResolvedValue(activeSummary);
    renderWithQuery(<LicenseSection enabled />);
    await userEvent.click(await screen.findByRole('button', { name: 'Upload a license file' }));
    expect(screen.getByRole('dialog', { name: 'Upload a license file' })).toBeVisible();
  });
});
