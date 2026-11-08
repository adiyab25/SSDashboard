import { createFormatter, createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import type { SettingEntryView } from '@ssdashboard/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSummary } from './license-fixtures';
import { SalesTaxSplit } from './sales-tax-split';
import { SettingsView } from './settings-view';

const reader = vi.hoisted(() => ({ language: 'en' }));
vi.mock('@/i18n/use-format', () => ({
  useFormat: () =>
    createFormatter({
      language: reader.language,
      intl: reader.language === 'ar' ? 'ar-EG' : 'en-US',
      hour12: true,
      currency: 'EGP',
      timezone: 'Africa/Cairo',
    }),
}));

const api = vi.hoisted(() => ({ listSettings: vi.fn(), putSetting: vi.fn() }));
vi.mock('./settings-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
const license = vi.hoisted(() => ({ getLicense: vi.fn() }));
vi.mock('./license-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...license,
}));

const entry = (overrides: Partial<SettingEntryView>): SettingEntryView => ({
  key: 'sales_tax_rate',
  group: 'brand',
  bundle: 'core',
  label: 'settings.entries.salesTaxRate.label',
  description: 'settings.entries.salesTaxRate.description',
  warning: 'settings.warnings.salesTaxRate',
  confirm: 'typed',
  reason: 'required',
  value: '14.00',
  default: '14.00',
  isDefault: true,
  invalid: false,
  updatedAt: null,
  updatedBy: null,
  canChange: true,
  licensed: true,
  ...overrides,
});
const vatEntry = (included: boolean) =>
  entry({
    key: 'prices_include_vat',
    label: 'settings.entries.pricesIncludeVat.label',
    description: 'settings.entries.pricesIncludeVat.description',
    warning: null,
    confirm: null,
    value: included,
    default: true,
  });

beforeEach(() => license.getLicense.mockResolvedValue(activeSummary));
afterEach(() => {
  reader.language = 'en';
  api.listSettings.mockReset();
  license.getLicense.mockReset();
});

describe('SalesTaxSplit (spec 0013, Configuration required)', () => {
  it('splits a price that includes VAT at the typed rate', () => {
    render(<SalesTaxSplit rate="14.00" includesVat />);
    const text = (screen.getByText(/Prices include VAT/).textContent ?? '').replace(/\s/g, ' ');
    expect(text).toMatch(/a price of EGP 1,140\.00 becomes EGP 1,000\.00 net and EGP 140\.00 VAT/);
  });

  it('adds VAT to a price that does not include it, at the typed rate', () => {
    render(<SalesTaxSplit rate="15" includesVat={false} />);
    const text = (screen.getByText(/do not include VAT/).textContent ?? '').replace(/\s/g, ' ');
    expect(text).toMatch(/a price of EGP 1,000\.00 becomes EGP 1,150\.00 with EGP 150\.00 VAT/);
  });

  it('asks for a valid rate instead of showing a split', () => {
    const { rerender } = render(<SalesTaxSplit rate="" includesVat />);
    expect(screen.getByText(/Enter a rate from 0 to 100/)).toBeVisible();
    rerender(<SalesTaxSplit rate="101" includesVat />);
    expect(screen.getByText(/Enter a rate from 0 to 100/)).toBeVisible();
    rerender(<SalesTaxSplit rate="12.345" includesVat />);
    expect(screen.getByText(/Enter a rate from 0 to 100/)).toBeVisible();
  });

  it('reads in Arabic with Western digits', () => {
    reader.language = 'ar';
    render(
      <I18nextProvider i18n={createI18n({ language: 'ar', catalogs: { ar } })}>
        <SalesTaxSplit rate="14.00" includesVat />
      </I18nextProvider>,
    );
    expect(screen.getByText('مثال محسوب بهذه النسبة')).toBeVisible();
    const text = screen.getByText(/الأسعار تشمل/).textContent ?? '';
    expect(text).toMatch(/1,140\.00/);
    expect(text).toMatch(/1,000\.00/);
    expect(text).toMatch(/140\.00/);
  });
});

describe('the sales tax rate change dialog', () => {
  async function open(included: boolean, language: 'en' | 'ar') {
    reader.language = language;
    api.listSettings.mockResolvedValue({ entries: [vatEntry(included), entry({})] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const i18n = createI18n({ language, catalogs: language === 'ar' ? { ar } : {} });
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <SettingsView enabled />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const name = language === 'ar' ? /نسبة ضريبة المبيعات/ : /Change Sales tax rate/;
    const buttons = await screen.findAllByRole('button', { name });
    await userEvent.click(buttons[buttons.length - 1] as HTMLElement);
    return screen.getByRole('dialog');
  }

  it('shows the warning and the split for the typed rate, following prices_include_vat', async () => {
    const dialog = await open(true, 'en');
    expect(within(dialog).getByText(/Shopify order lines never use it/)).toBeVisible();
    expect(
      within(dialog).getByText(/a price of EGP 1,140\.00 becomes EGP 1,000\.00 net/),
    ).toBeVisible();

    const rate = within(dialog).getByLabelText(/New value/);
    await userEvent.clear(rate);
    await userEvent.type(rate, '10');
    expect(
      within(dialog).getByText(
        /a price of EGP 1,100\.00 becomes EGP 1,000\.00 net and EGP 100\.00 VAT/,
      ),
    ).toBeVisible();
  });

  it('shows the not included wording when prices are entered net', async () => {
    const dialog = await open(false, 'en');
    expect(
      within(dialog).getByText(
        /a price of EGP 1,000\.00 becomes EGP 1,140\.00 with EGP 140\.00 VAT/,
      ),
    ).toBeVisible();
  });

  it('renders the split in Arabic', async () => {
    const dialog = await open(true, 'ar');
    expect(within(dialog).getByText('مثال محسوب بهذه النسبة')).toBeVisible();
    expect(within(dialog).getByText(/الأسعار تشمل ضريبة القيمة المضافة/)).toBeVisible();
    expect(within(dialog).getByText(/بنود طلبات شوبيفاي فلا تستخدمها أبدًا/)).toBeVisible();
  });
});
