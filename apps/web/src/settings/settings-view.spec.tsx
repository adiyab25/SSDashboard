import type { SettingEntryView } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { SettingsView } from './settings-view';

const api = vi.hoisted(() => ({ listSettings: vi.fn(), putSetting: vi.fn() }));
vi.mock('./settings-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const entry = (overrides: Partial<SettingEntryView>): SettingEntryView => ({
  key: 'operations_wind_down_days',
  group: 'policies',
  bundle: 'core',
  label: 'settings.entries.operationsWindDownDays.label',
  description: 'settings.entries.operationsWindDownDays.description',
  warning: null,
  confirm: null,
  reason: 'required',
  value: 60,
  default: 60,
  isDefault: true,
  invalid: false,
  updatedAt: null,
  updatedBy: null,
  canChange: true,
  licensed: true,
  ...overrides,
});

const currency = entry({
  key: 'currency',
  group: 'brand',
  label: 'settings.entries.currency.label',
  description: 'settings.entries.currency.description',
  value: 'EGP',
  default: 'EGP',
  canChange: false,
});
const vat = entry({
  key: 'prices_include_vat',
  group: 'brand',
  label: 'settings.entries.pricesIncludeVat.label',
  description: 'settings.entries.pricesIncludeVat.description',
  warning: 'settings.warnings.pricesIncludeVat',
  confirm: 'typed',
  value: false,
  default: true,
  isDefault: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
  updatedBy: { id: '00000000-0000-4000-8000-000000000001', name: 'Nour Admin' },
});
const winding = entry({ bundle: 'operations', licensed: false });

afterEach(() => {
  api.listSettings.mockReset();
  api.putSetting.mockReset();
});

describe('SettingsView (AC-25)', () => {
  it('shows the Brand and Policies sections under one h1, with who changed what', async () => {
    api.listSettings.mockResolvedValue({ entries: [currency, vat, winding] });
    renderWithQuery(<SettingsView enabled />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Brand' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Policies' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/Last changed by Nour Admin/)).toBeVisible();
    expect(screen.getAllByText('Never changed').length).toBeGreaterThan(0);
  });

  it('has no Change action for the read only currency and disables an unlicensed item with its plan', async () => {
    api.listSettings.mockResolvedValue({ entries: [currency, vat, winding] });
    renderWithQuery(<SettingsView enabled />);
    await screen.findByRole('heading', { level: 2, name: 'Brand' });

    expect(screen.getByRole('button', { name: 'Change Currency' })).toBeDisabled();
    expect(screen.getByText('Needs the Operations plan')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change Wind down length in days' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change Prices include VAT' })).toBeEnabled();
  });

  it('asks for nothing before access is known', () => {
    renderWithQuery(<SettingsView enabled={false} />);
    expect(api.listSettings).not.toHaveBeenCalled();
  });

  it('shows the no access state when the api answers 403', async () => {
    api.listSettings.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' }));
    renderWithQuery(<SettingsView enabled />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('shows an error with Try again when the list cannot load', async () => {
    api.listSettings.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    renderWithQuery(<SettingsView enabled />);
    expect(await screen.findByText(/could not be loaded/)).toBeVisible();

    api.listSettings.mockResolvedValue({ entries: [vat] });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Brand' })).toBeVisible();
  });
});

describe('the change dialog (AC-25)', () => {
  async function open(target: SettingEntryView, name: string) {
    api.listSettings.mockResolvedValue({ entries: [target] });
    renderWithQuery(<SettingsView enabled />);
    await userEvent.click(await screen.findByRole('button', { name }));
    return screen.getByRole('dialog');
  }

  it('refuses to save without a reason where one is required', async () => {
    const dialog = await open(entry({}), 'Change Wind down length in days');
    await userEvent.clear(within(dialog).getByLabelText(/New value/));
    await userEvent.type(within(dialog).getByLabelText(/New value/), '90');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Say why you are making this change.')).toBeVisible();
    expect(within(dialog).getByLabelText(/^Reason/)).toHaveFocus();
    expect(api.putSetting).not.toHaveBeenCalled();
  });

  it('sends the value, the reason, and the updatedAt it was shown, then reloads the list', async () => {
    const shown = entry({ updatedAt: '2026-11-07T10:15:30.123456Z', value: 70, isDefault: false });
    api.putSetting.mockResolvedValue({ entry: shown, changed: true });
    const dialog = await open(shown, 'Change Wind down length in days');
    await userEvent.clear(within(dialog).getByLabelText(/New value/));
    await userEvent.type(within(dialog).getByLabelText(/New value/), '90');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Longer cash window');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('operations_wind_down_days', {
        value: 90,
        reason: 'Longer cash window',
        expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.listSettings).toHaveBeenCalledTimes(2);
  });

  it('shows the warning and needs the setting name typed where the registry says so', async () => {
    api.putSetting.mockResolvedValue({ entry: vat, changed: true });
    const dialog = await open(vat, 'Change Prices include VAT');
    expect(within(dialog).getByText(/split net and tax differently/)).toBeVisible();

    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Prices now net');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Type the name exactly as shown to confirm.'),
    ).toBeVisible();
    expect(api.putSetting).not.toHaveBeenCalled();

    await userEvent.type(
      within(dialog).getByLabelText(/Type “Prices include VAT”/),
      'Prices include VAT',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('prices_include_vat', {
        value: false,
        reason: 'Prices now net',
        expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
      }),
    );
  });

  it('shows a refused document prefix on that prefix input', async () => {
    const prefixes = entry({
      key: 'document_prefixes',
      group: 'brand',
      label: 'settings.entries.documentPrefixes.label',
      description: 'settings.entries.documentPrefixes.description',
      reason: 'optional',
      value: { PO: 'PO', stock_receipt: 'SR' },
      default: { PO: 'PO', stock_receipt: 'SR' },
    });
    const dialog = await open(prefixes, 'Change Document prefixes');
    await userEvent.clear(within(dialog).getByLabelText('PO'));
    await userEvent.type(within(dialog).getByLabelText('PO'), 'SR');
    api.putSetting.mockRejectedValueOnce(
      new ApiError(422, {
        code: 'SETTING_INVALID',
        issues: [{ path: 'PO', message: 'Prefixes must differ' }],
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/Use 1 to 8 capital letters or digits/)).toBeVisible();
    expect(within(dialog).getByLabelText('PO')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByLabelText('PO')).toHaveFocus();
    expect(within(dialog).getByLabelText('stock_receipt')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('takes a number typed in Arabic digits and sends it as a number', async () => {
    const shown = entry({ updatedAt: '2026-11-07T10:15:30.123456Z' });
    api.putSetting.mockResolvedValue({ entry: shown, changed: true });
    const dialog = await open(shown, 'Change Wind down length in days');
    await userEvent.clear(within(dialog).getByLabelText(/New value/));
    await userEvent.type(within(dialog).getByLabelText(/New value/), '٩٠');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Longer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith(
        'operations_wind_down_days',
        expect.objectContaining({ value: 90 }),
      ),
    );
  });

  it('names the refused language code from the index path', async () => {
    const languages = entry({
      key: 'languages',
      group: 'brand',
      label: 'settings.entries.languages.label',
      description: 'settings.entries.languages.description',
      reason: 'optional',
      value: ['en', 'ar'],
      default: ['en', 'ar'],
    });
    const dialog = await open(languages, 'Change Languages');
    await userEvent.clear(within(dialog).getByLabelText(/New value/));
    await userEvent.type(within(dialog).getByLabelText(/New value/), 'en, zz');
    api.putSetting.mockRejectedValueOnce(
      new ApiError(422, {
        code: 'SETTING_INVALID',
        issues: [{ path: '1', message: 'Not a catalog language' }],
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/The language code .zz. is not available/),
    ).toBeVisible();
  });

  it('focuses the confirmation before the reason when both are missing', async () => {
    const dialog = await open(vat, 'Change Prices include VAT');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByLabelText(/Type .Prices include VAT./)).toHaveFocus();
  });

  it('shows the api refusals on the field they belong to and offers a reload when stale', async () => {
    const dialog = await open(entry({}), 'Change Wind down length in days');
    await userEvent.clear(within(dialog).getByLabelText(/New value/));
    await userEvent.type(within(dialog).getByLabelText(/New value/), '10');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Because');

    api.putSetting.mockRejectedValueOnce(new ApiError(422, { code: 'SETTING_INVALID' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/This value is not allowed/)).toBeVisible();
    expect(within(dialog).getByLabelText(/New value/)).toHaveAttribute('aria-invalid', 'true');

    api.putSetting.mockRejectedValueOnce(new ApiError(409, { code: 'STALE_SETTING' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Someone else changed this setting/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
