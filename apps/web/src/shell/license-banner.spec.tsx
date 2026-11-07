import type { LicenseCheckOutcome } from '@ssdashboard/contracts';
import { en } from '@ssdashboard/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { activeSummary, operationsNotice } from '@/settings/license-fixtures';
import { renderWithQuery } from '@/shared/render-with-query';
import { licenseKeys } from '@/settings/license-api';
import { LicenseBanner } from './license-banner';

const api = vi.hoisted(() => ({ getLicense: vi.fn() }));
vi.mock('@/settings/license-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(() => ({ permissions: ['settings.manage'] as string[] }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['manager'], permissions: me.permissions },
  }),
}));

afterEach(() => {
  api.getLicense.mockReset();
  me.permissions = ['settings.manage'];
});

const withNotices = (...notices: ReturnType<typeof operationsNotice>[]) => ({
  ...activeSummary,
  notices,
});

/**
 * Renders the banner under a client the test can read, and waits until the license query has
 * finished (success or error) and React has drawn the answer, so a "shows nothing" case checks
 * the settled screen and not the moment before the data arrives.
 */
async function renderSettled() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <LicenseBanner />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    const state = client.getQueryState(licenseKeys.all);
    expect(state?.status).not.toBe('pending');
    expect(state?.fetchStatus).toBe('idle');
  });
  await act(async () => {});
  return { ...view, client };
}

describe('LicenseBanner (AC-17)', () => {
  it('shows nothing while no plan is near its expiry', async () => {
    api.getLicense.mockResolvedValue(activeSummary);
    const { container, client } = await renderSettled();
    // The answer arrived (so the empty screen is the settled one), and it was the active one.
    expect(client.getQueryData(licenseKeys.all)).toEqual(activeSummary);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an info notice with the days left and a link to the license section', async () => {
    api.getLicense.mockResolvedValue(withNotices(operationsNotice()));
    renderWithQuery(<LicenseBanner />);

    const region = await screen.findByRole('region', { name: 'License notice' });
    expect(region).toHaveTextContent('Notice');
    expect(region).toHaveTextContent(/The Operations plan ends on 17 Nov 2026 \(days left: 10\)/);
    expect(region).toHaveTextContent(/lapses on 2026-12-01T22:00:00.000Z unless/);
    expect(screen.getByRole('link', { name: 'Open the license settings' })).toHaveAttribute(
      'href',
      '/settings#license',
    );
  });

  it('words the warning level for grace', async () => {
    api.getLicense.mockResolvedValue(
      withNotices(operationsNotice({ phase: 'grace', level: 'warning', daysLeft: -3 })),
    );
    renderWithQuery(<LicenseBanner />);
    const region = await screen.findByRole('region', { name: 'License notice' });
    expect(region).toHaveTextContent('Warning');
    expect(region).toHaveTextContent(
      /ended on 17 Nov 2026\. It still works, and stops on 2026-12-01T22:00:00.000Z/,
    );
  });

  it('words the critical level for the wind down, with the day cash is followed until', async () => {
    api.getLicense.mockResolvedValue(
      withNotices(operationsNotice({ phase: 'wind_down', level: 'critical', daysLeft: -20 })),
    );
    renderWithQuery(<LicenseBanner />);
    const region = await screen.findByRole('region', { name: 'License notice' });
    expect(region).toHaveTextContent('Action needed');
    expect(region).toHaveTextContent(/followed until 31 Jan 2027/);
  });

  it('words an off plan, and lists one line for each plan with a notice', async () => {
    api.getLicense.mockResolvedValue(
      withNotices(
        operationsNotice({ phase: 'off', level: 'critical', daysLeft: -90, windDownEndsOn: null }),
        operationsNotice({ bundle: 'warehouse', windDownEndsOn: null }),
      ),
    );
    renderWithQuery(<LicenseBanner />);
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/The Operations plan has lapsed and is off/)).toBeVisible();
    expect(screen.getByText(/The Warehouse plan ends on/)).toBeVisible();
  });

  const check = (outcome: LicenseCheckOutcome) => ({
    checkedAt: '2026-11-07T10:00:00.000Z',
    trigger: 'daily' as const,
    outcome,
    clockBehind: false,
  });

  it.each([
    'file_missing',
    'file_unreadable',
    'bad_format',
    'bad_signature',
    'unknown_key',
    'dev_key_in_production',
    'wrong_install',
  ] as const)('names the %s outcome of the file check, with a link', async (outcome) => {
    api.getLicense.mockResolvedValue({ ...activeSummary, lastCheck: check(outcome) });
    renderWithQuery(<LicenseBanner />);

    const region = await screen.findByRole('region', { name: 'License notice' });
    expect(region).toHaveTextContent('Action needed');
    expect(region).toHaveTextContent(en.settings.license.outcomes[outcome]);
    expect(screen.getByRole('link', { name: 'Open the license settings' })).toHaveAttribute(
      'href',
      '/settings#license',
    );
  });

  it('names a damaged file even when licenses are recorded', async () => {
    api.getLicense.mockResolvedValue({ ...activeSummary, lastCheck: check('bad_signature') });
    renderWithQuery(<LicenseBanner />);
    expect(await screen.findByRole('region', { name: 'License notice' })).toHaveTextContent(
      en.settings.license.outcomes.bad_signature,
    );
  });

  it('names no file configured only while no license was ever recorded', async () => {
    api.getLicense.mockResolvedValue({
      ...activeSummary,
      licenses: [],
      lastCheck: check('none_configured'),
    });
    renderWithQuery(<LicenseBanner />);
    expect(await screen.findByRole('region', { name: 'License notice' })).toHaveTextContent(
      en.settings.license.outcomes.none_configured,
    );
  });

  it('shows nothing for no file configured once a license is recorded', async () => {
    api.getLicense.mockResolvedValue({ ...activeSummary, lastCheck: check('none_configured') });
    const { container, client } = await renderSettled();
    expect(client.getQueryData(licenseKeys.all)).toMatchObject({
      lastCheck: { outcome: 'none_configured' },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing for a check that found an already recorded license', async () => {
    api.getLicense.mockResolvedValue({ ...activeSummary, lastCheck: check('already_recorded') });
    const { container, client } = await renderSettled();
    expect(client.getQueryData(licenseKeys.all)).toMatchObject({
      lastCheck: { outcome: 'already_recorded' },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('draws no row for a notice whose phase has nothing to say', async () => {
    api.getLicense.mockResolvedValue(withNotices(operationsNotice({ phase: 'active' })));
    const { container, client } = await renderSettled();
    expect(client.getQueryData(licenseKeys.all)).toMatchObject({
      notices: [{ phase: 'active' }],
    });
    expect(container.querySelector('li')).toBeNull();
  });

  it('asks the api nothing for a person without settings.manage', async () => {
    me.permissions = ['stock.view'];
    const { container } = renderWithQuery(<LicenseBanner />);
    await Promise.resolve();
    expect(api.getLicense).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when the call fails', async () => {
    api.getLicense.mockRejectedValue(new ApiError(500, { code: 'generic' }));
    const { container, client } = await renderSettled();
    expect(client.getQueryState(licenseKeys.all)?.status).toBe('error');
    expect(container).toBeEmptyDOMElement();
  });
});
