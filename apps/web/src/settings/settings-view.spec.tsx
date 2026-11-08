import type { SettingEntryView } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { activeSummary } from './license-fixtures';
import { SettingsView } from './settings-view';

const api = vi.hoisted(() => ({ listSettings: vi.fn(), putSetting: vi.fn() }));
vi.mock('./settings-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const owners = vi.hoisted(() => ({ listOwnerPolicies: vi.fn() }));
vi.mock('./owner-policies-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...owners,
}));

const license = vi.hoisted(() => ({ getLicense: vi.fn() }));
vi.mock('./license-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...license,
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
const sourceStore = entry({
  key: 'catalog.source_store_id',
  group: 'catalog',
  label: 'settings.entries.catalogSourceStoreId.label',
  description: 'settings.entries.catalogSourceStoreId.description',
  reason: 'optional',
  value: '00000000-0000-4000-8000-0000000000c1',
  default: null,
  isDefault: false,
});
const giftTags = entry({
  key: 'shopify_gift_tags',
  label: 'settings.entries.shopifyGiftTags.label',
  description: 'settings.entries.shopifyGiftTags.description',
  reason: 'optional',
  value: { influencer: 'GIFT_INFLUENCER' },
  default: {},
  isDefault: false,
});
const riskSignal = entry({
  key: 'customer_risk_signal',
  label: 'settings.entries.customerRiskSignal.label',
  description: 'settings.entries.customerRiskSignal.description',
  reason: 'optional',
  value: { windowDays: 180, refusalsToSuggest: 2, returnsToSuggest: 3 },
  default: { windowDays: 180, refusalsToSuggest: 2, returnsToSuggest: 2 },
  isDefault: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
});
const buffer = entry({
  key: 'shopify_stock_safety_buffer',
  bundle: 'warehouse',
  label: 'settings.entries.shopifyStockSafetyBuffer.label',
  description: 'settings.entries.shopifyStockSafetyBuffer.description',
  warning: 'settings.warnings.shopifyStockSafetyBuffer',
  value: 0,
  default: 0,
});
const taxRate = entry({
  key: 'sales_tax_rate',
  group: 'brand',
  label: 'settings.entries.salesTaxRate.label',
  description: 'settings.entries.salesTaxRate.description',
  warning: 'settings.warnings.salesTaxRate',
  confirm: 'typed',
  value: '14.00',
  default: '14.00',
});

beforeEach(() => {
  license.getLicense.mockResolvedValue(activeSummary);
  owners.listOwnerPolicies.mockResolvedValue({ policies: [] });
});

afterEach(() => {
  owners.listOwnerPolicies.mockReset();
  license.getLicense.mockReset();
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
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2 })).toBeNull());
  });

  it('keeps the Modules and license section while the settings list fails', async () => {
    api.listSettings.mockRejectedValue(new ApiError(500, { code: 'generic' }));
    renderWithQuery(<SettingsView enabled />);

    expect(await screen.findByText(/settings could not be loaded/)).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Modules and license' })).toBeVisible();
  });

  it('orders the sections as the spec lists them, Catalog only when it has entries', async () => {
    api.listSettings.mockResolvedValue({ entries: [currency, vat, winding, sourceStore] });
    renderWithQuery(<SettingsView enabled />);
    await screen.findByRole('heading', { name: 'Operations' });

    const names = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual([
      'Brand',
      'Modules and license',
      'Automations',
      'Policies',
      'Catalog',
      'Location owner types',
    ]);
  });

  it('shows an error with Try again when the list cannot load', async () => {
    api.listSettings.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    renderWithQuery(<SettingsView enabled />);
    expect(await screen.findByText(/could not be loaded/)).toBeVisible();

    api.listSettings.mockResolvedValue({ entries: [vat] });
    const alert = screen.getByText(/settings could not be loaded/);
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
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

  it.each(['', ' '])(
    'does not blame a typed language code for a list wide issue (path %j)',
    async (path) => {
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
      await userEvent.type(within(dialog).getByLabelText(/New value/), 'ar, fr');
      api.putSetting.mockRejectedValueOnce(
        new ApiError(422, {
          code: 'SETTING_INVALID',
          issues: [{ path, message: 'The default language en must stay enabled' }],
        }),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(
        await within(dialog).findByText(/This value is not allowed|must stay in the list/),
      ).toBeVisible();
      expect(within(dialog).queryByText(/language code/)).toBeNull();
    },
  );

  it('refuses a repeated language locally, with no request', async () => {
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
    await userEvent.type(within(dialog).getByLabelText(/New value/), 'en, ar, ar');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Each language can appear only once.')).toBeVisible();
    expect(api.putSetting).not.toHaveBeenCalled();
  });

  it('says the default language must stay when the api refuses a list without it', async () => {
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
    await userEvent.type(within(dialog).getByLabelText(/New value/), 'ar');
    api.putSetting.mockRejectedValueOnce(
      new ApiError(422, {
        code: 'SETTING_INVALID',
        issues: [{ path: '', message: 'The default language en must stay enabled' }],
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/default language must stay in the list/)).toBeVisible();
  });

  it('names a stored last editor with no name as someone no longer listed', async () => {
    api.listSettings.mockResolvedValue({
      entries: [{ ...vat, updatedBy: { id: '00000000-0000-4000-8000-000000000002', name: null } }],
    });
    renderWithQuery(<SettingsView enabled />);
    expect(
      await screen.findByText(/Last changed by someone who is no longer listed/),
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

  it('words 409 NOT_LICENSED in its own sentence and keeps the dialog open', async () => {
    const dialog = await open(entry({}), 'Change Wind down length in days');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Because');
    api.putSetting.mockRejectedValueOnce(new ApiError(409, { code: 'NOT_LICENSED' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText(
        'This setting needs a plan this install does not have. Nothing was changed.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
  });
});

describe('the rows requested by specs 0012 to 0015 (AC-25, AC-31)', () => {
  it('shows the Catalog keys and the gift tags with value and default, set elsewhere, with no Change', async () => {
    api.listSettings.mockResolvedValue({ entries: [sourceStore, giftTags] });
    renderWithQuery(<SettingsView enabled />);

    const catalog = await screen.findByRole('region', { name: 'Catalog' });
    expect(within(catalog).getByText('Catalog source store')).toBeVisible();
    expect(within(catalog).getByText('00000000-0000-4000-8000-0000000000c1')).toBeVisible();
    expect(within(catalog).getByText('Not set')).toBeVisible();
    expect(
      within(catalog).getByText('Changed from its own page once that page is built.'),
    ).toBeVisible();
    expect(within(catalog).queryByRole('button', { name: /Change/ })).toBeNull();

    const policies = screen.getByRole('region', { name: 'Policies' });
    expect(within(policies).getByText(/never a person’s name/)).toBeVisible();
    expect(within(policies).getByText('influencer: GIFT_INFLUENCER')).toBeVisible();
    // An empty map default reads as a word, never a blank line.
    expect(within(policies).getByText('None')).toBeVisible();
    expect(within(policies).queryByRole('button', { name: /Change/ })).toBeNull();
  });

  it('keeps the sales tax rate in the Brand section', async () => {
    api.listSettings.mockResolvedValue({ entries: [taxRate] });
    renderWithQuery(<SettingsView enabled />);
    const brand = await screen.findByRole('region', { name: 'Brand' });
    expect(within(brand).getByRole('button', { name: 'Change Sales tax rate (%)' })).toBeEnabled();
  });

  it('writes the customer risk signal as a sentence and edits it in three number inputs', async () => {
    api.putSetting.mockResolvedValue({ entry: riskSignal, changed: true });
    api.listSettings.mockResolvedValue({ entries: [riskSignal] });
    renderWithQuery(<SettingsView enabled />);
    expect(
      await screen.findByText('Refused deliveries: 2. Returns: 3. Window in days: 180.'),
    ).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Change Customer risk suggestion' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Within how many days'));
    await userEvent.type(within(dialog).getByLabelText('Within how many days'), '٩٠');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('customer_risk_signal', {
        value: { refusalsToSuggest: 2, returnsToSuggest: 3, windowDays: 90 },
        expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
      }),
    );
  });

  it('refuses an empty risk signal box before sending, and shows the api range on its input', async () => {
    api.listSettings.mockResolvedValue({ entries: [riskSignal] });
    renderWithQuery(<SettingsView enabled />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change Customer risk suggestion' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Returns'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Enter a whole number in each of the three boxes.'),
    ).toBeVisible();
    expect(api.putSetting).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText('Returns'), '2');
    await userEvent.clear(within(dialog).getByLabelText('Within how many days'));
    await userEvent.type(within(dialog).getByLabelText('Within how many days'), '5');
    api.putSetting.mockRejectedValueOnce(
      new ApiError(422, {
        code: 'SETTING_INVALID',
        issues: [{ path: 'windowDays', message: 'Too small' }],
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter whole days from 30 to 730.')).toBeVisible();
    expect(within(dialog).getByLabelText('Within how many days')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(dialog).getByLabelText('Within how many days')).toHaveFocus();
  });

  it('shows the safety buffer warning about variants that go sold out on Shopify', async () => {
    api.listSettings.mockResolvedValue({ entries: [buffer] });
    renderWithQuery(<SettingsView enabled />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change Shopify stock safety buffer' }),
    );
    expect(
      within(screen.getByRole('dialog')).getByText(/show as sold out on Shopify/),
    ).toBeVisible();
  });

  it('reads the Catalog section in Arabic', async () => {
    api.listSettings.mockResolvedValue({ entries: [sourceStore] });
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <SettingsView enabled />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const catalog = await screen.findByRole('region', { name: 'الكتالوج' });
    expect(within(catalog).getByText('يُغيَّر من صفحته الخاصة عند بنائها.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'الأتمتة' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'أنواع مالكي المواقع' })).toBeVisible();
  });
});
