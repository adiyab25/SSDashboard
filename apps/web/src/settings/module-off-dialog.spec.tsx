import type { OffImpact, SettingEntryView } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { ModuleOffDialog } from './module-off-dialog';

const api = vi.hoisted(() => ({ getOffImpact: vi.fn(), putSetting: vi.fn() }));
vi.mock('./settings-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

/** A fixture module switch: no real module is toggleable yet, so its label is a catalog key we own. */
const entry: SettingEntryView = {
  key: 'module.platform.enabled',
  group: 'modules',
  bundle: 'operations',
  label: 'modules.platform.label',
  description: 'modules.platform.description',
  warning: null,
  confirm: null,
  reason: 'required',
  value: true,
  default: true,
  isDefault: true,
  invalid: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
  updatedBy: null,
  canChange: true,
  licensed: true,
};

const empty: OffImpact = {
  waitingCommands: [],
  inFlight: [],
  partnerStock: [],
  typedConfirmation: false,
};

const busy: OffImpact = {
  waitingCommands: [{ kind: 'bosta.create_shipment', count: 3 }],
  inFlight: [{ area: 'exchanges.approved', count: 2 }],
  partnerStock: [
    {
      partnerId: '00000000-0000-4000-8000-0000000000a1',
      partnerName: 'Nile Showroom',
      pieces: 1200,
      totalValue: '45000.00',
      lastConfirmedSalesDay: '2026-11-01',
    },
    {
      partnerId: '00000000-0000-4000-8000-0000000000a2',
      partnerName: 'Delta Boutique',
      pieces: 1,
      lastConfirmedSalesDay: null,
    },
  ],
  typedConfirmation: true,
};

afterEach(() => {
  api.getOffImpact.mockReset();
  api.putSetting.mockReset();
});

const saveButton = () => screen.getByRole('button', { name: 'Turn off' });

describe('ModuleOffDialog (spec 0009, AC-12, AC-30)', () => {
  it('shows the impact first: waiting commands, in flight work, and per partner stock with value only when sent', async () => {
    api.getOffImpact.mockResolvedValue(busy);
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'Turn off Platform' });
    expect(await within(dialog).findByText('Waiting requests that will fail')).toBeVisible();
    expect(within(dialog).getByText('bosta.create_shipment')).toBeVisible();
    expect(within(dialog).getByText('Work in progress that can still be finished')).toBeVisible();
    expect(within(dialog).getByText('Nile Showroom')).toBeVisible();
    expect(within(dialog).getByText(/1,200 pieces\./)).toBeVisible();
    expect(within(dialog).getByText(/Value at cost: /)).toBeVisible();
    expect(within(dialog).getByText('Last confirmed sales day: 1 Nov 2026.')).toBeVisible();
    // The second partner came without a value (no cost.view) and with no confirmed day.
    expect(within(dialog).getByText('Delta Boutique')).toBeVisible();
    expect(within(dialog).getAllByText(/Value at cost: /)).toHaveLength(1);
    expect(within(dialog).getByText('No sales day confirmed yet.')).toBeVisible();
    expect(within(dialog).getByText('1 piece.')).toBeVisible();
  });

  it('says plainly when nothing is affected, and asks for no typed confirmation', async () => {
    api.getOffImpact.mockResolvedValue(empty);
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={vi.fn()} />);

    expect(await screen.findByText(/stops nothing right now/)).toBeVisible();
    expect(screen.queryByLabelText(/to confirm/)).not.toBeInTheDocument();
  });

  it('keeps the button off until the impact is in, and offers Try again when it fails', async () => {
    api.getOffImpact.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/);
    expect(saveButton()).toBeDisabled();

    api.getOffImpact.mockResolvedValue(empty);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/stops nothing right now/)).toBeVisible();
    expect(saveButton()).toBeEnabled();
  });

  it('has its own sentence when the impact cannot be worked out (503 OFF_IMPACT_UNAVAILABLE)', async () => {
    api.getOffImpact.mockRejectedValueOnce(new ApiError(503, { code: 'OFF_IMPACT_UNAVAILABLE' }));
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be worked out right now/);
    expect(saveButton()).toBeDisabled();
  });

  it('requires the typed name and a reason, focusing the first fault, and writes false with the reason', async () => {
    api.getOffImpact.mockResolvedValue(busy);
    api.putSetting.mockResolvedValue({ entry: { ...entry, value: false }, changed: true });
    const onClose = vi.fn();
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={onClose} />);
    const confirm = await screen.findByLabelText('Type “Platform” to confirm');

    await userEvent.click(saveButton());
    expect(await screen.findByText('Type the name exactly as shown to confirm.')).toBeVisible();
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(api.putSetting).not.toHaveBeenCalled();

    await userEvent.type(confirm, 'platform');
    await userEvent.click(saveButton());
    const reason = screen.getByRole('textbox', { name: /Reason/ });
    expect(await screen.findByText('Say why you are making this change.')).toBeVisible();
    expect(reason).toHaveFocus();
    expect(reason).toHaveAccessibleDescription('Say why you are making this change.');
    expect(api.putSetting).not.toHaveBeenCalled();

    await userEvent.type(reason, '  Closing the showroom line ');
    await userEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.putSetting).toHaveBeenCalledExactlyOnceWith('module.platform.enabled', {
      value: false,
      reason: 'Closing the showroom line',
      expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
    });
  });

  it('words MODULE_REQUIRED_BY with the dependants labels and writes nothing else', async () => {
    api.getOffImpact.mockResolvedValue(empty);
    api.putSetting.mockRejectedValue(
      new ApiError(409, { code: 'MODULE_REQUIRED_BY', dependants: ['catalog', 'inventory'] }),
    );
    const onClose = vi.fn();
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={onClose} />);
    await screen.findByText(/stops nothing right now/);

    await userEvent.type(screen.getByRole('textbox', { name: /Reason/ }), 'Trying');
    await userEvent.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'It cannot be turned off yet. It is needed by Catalog, Stock. Turn those off first.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('words NOT_LICENSED and a stale answer with a reload', async () => {
    api.getOffImpact.mockResolvedValue(empty);
    api.putSetting.mockRejectedValueOnce(new ApiError(409, { code: 'STALE_SETTING' }));
    renderWithQuery(<ModuleOffDialog entry={entry} onClose={vi.fn()} />);
    await screen.findByText(/stops nothing right now/);
    await userEvent.type(screen.getByRole('textbox', { name: /Reason/ }), 'Trying');
    await userEvent.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/Someone else changed this setting/);
    expect(screen.getByRole('button', { name: 'Reload settings' })).toBeVisible();

    api.putSetting.mockRejectedValueOnce(new ApiError(409, { code: 'NOT_LICENSED' }));
    await userEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /needs a plan this install does not have/,
      ),
    );
  });

  it('reads in Arabic', async () => {
    api.getOffImpact.mockResolvedValue(busy);
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <ModuleOffDialog entry={entry} onClose={vi.fn()} />
        </I18nextProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('dialog', { name: 'إيقاف المنصة' })).toBeVisible();
    expect(await screen.findByText('مخزون لدى الشركاء')).toBeVisible();
    expect(screen.getByText('قطعة واحدة.')).toBeVisible();
  });
});
