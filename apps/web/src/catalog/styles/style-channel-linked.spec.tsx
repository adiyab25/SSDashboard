import type { StyleDetail } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { StyleDetailPage } from './style-detail-page';

const api = vi.hoisted(() => ({
  getStyle: vi.fn(),
  updateStyle: vi.fn(),
  addVariant: vi.fn(),
  addBarcode: vi.fn(),
  removeBarcode: vi.fn(),
  listGroupingChoices: vi.fn(),
}));
vi.mock('@/catalog/catalog-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('@/api/refetch-after-write', () => ({ refetchAfterWrite: () => Promise.resolve() }));
vi.mock('@/shell/client-config', () => ({ loadConfig: () => new Promise(() => undefined) }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: STYLE_ID }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['warehouse'], permissions: ['stock.view', 'catalog.edit'] },
  }),
}));

const STYLE_ID = '40000000-0000-4000-8000-000000000001';
const VARIANT_ID = '00000000-0000-4000-8000-000000000001';
const GROUP = {
  id: '20000000-0000-4000-8000-000000000002',
  code: 'TOPS',
  name: { en: 'Tops', ar: 'قمصان' },
};
const APP_CODE = { id: '50000000-0000-4000-8000-000000000001', code: 'APP-1', fromChannel: false };
const SHOP_CODE = { id: '50000000-0000-4000-8000-000000000002', code: 'SHOP-1', fromChannel: true };

const style = (overrides: Partial<StyleDetail> = {}): StyleDetail => ({
  id: STYLE_ID,
  code: 'TEE',
  name: { en: 'Tee', ar: 'تيشيرت' },
  description: null,
  season: null,
  productGroup: GROUP,
  tags: ['summer'],
  productType: 'Shirts',
  brand: 'Pilot',
  archived: false,
  updatedAt: '2026-11-03T10:00:00.123456Z',
  channelLinked: false,
  channelNameLanguage: null,
  options: [
    {
      id: '60000000-0000-4000-8000-000000000001',
      name: { en: 'Size' },
      role: 'size',
      position: 0,
      values: [{ en: 'M' }, { en: 'L' }],
    },
  ],
  variants: [
    {
      id: VARIANT_ID,
      code: 'TEE-M',
      options: [{ name: { en: 'Size' }, value: { en: 'M' } }],
      price: '250.00',
      archived: false,
      channelLinked: false,
      barcodes: [APP_CODE],
    },
  ],
  ...overrides,
});

const linked = (overrides: Partial<StyleDetail> = {}) =>
  style({
    channelLinked: true,
    channelNameLanguage: 'en',
    variants: [
      {
        id: VARIANT_ID,
        code: 'TEE-M',
        options: [{ name: { en: 'Size' }, value: { en: 'M' } }],
        price: '250.00',
        archived: false,
        channelLinked: true,
        barcodes: [APP_CODE, SHOP_CODE],
      },
    ],
    ...overrides,
  });

const inArabic = (ui: ReactElement) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

async function open(detail: StyleDetail, wrap: (ui: ReactElement) => ReactElement = (ui) => ui) {
  api.getStyle.mockResolvedValue(detail);
  api.listGroupingChoices.mockImplementation((kind: string) =>
    Promise.resolve(kind === 'season' ? [] : [GROUP]),
  );
  renderWithQuery(wrap(<StyleDetailPage />));
  await screen.findByRole('heading', { level: 1, name: 'TEE' });
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe('Style page of a channel linked style (spec 0012, AC-15, AC-18)', () => {
  it('shows no From Shopify label while the style is not linked', async () => {
    await open(style());
    expect(screen.queryByText('From Shopify')).toBeNull();
  });

  it('labels the channel owned facts, price, and barcode', async () => {
    await open(linked());
    const facts = screen.getByRole('region', { name: 'About this style' });
    // name, product type, brand, tags
    expect(within(facts).getAllByText('From Shopify')).toHaveLength(4);
    expect(within(facts).getByText('Name in English (from Shopify)')).toBeVisible();
    const options = screen.getByRole('region', { name: 'Options' });
    expect(within(options).getByText('From Shopify')).toBeVisible();
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    // price and the channel barcode
    expect(within(table).getAllByText('From Shopify')).toHaveLength(2);
  });

  it('shows no name row when the channel language is not known yet', async () => {
    await open(linked({ channelNameLanguage: null }));
    expect(screen.queryByText('Name in English (from Shopify)')).toBeNull();
  });

  it('keeps the labels in Arabic', async () => {
    await open(linked({ channelNameLanguage: 'ar' }), inArabic);
    expect(screen.getAllByText('من شوبيفاي').length).toBeGreaterThan(3);
    expect(screen.getByText('الاسم بالعربية (من شوبيفاي)')).toBeVisible();
  });

  it('makes the channel name and tags read only in Edit, and keeps the other name editable', async () => {
    await open(linked());
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    expect(within(dialog).getByLabelText(/Name in English/)).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Tags/)).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Name in Arabic/)).not.toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Description in English/)).not.toHaveAttribute('readonly');
  });

  it('sends neither the channel name nor the tags when only the Arabic name changed', async () => {
    api.updateStyle.mockResolvedValue(linked());
    await open(linked());
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    const arabic = within(dialog).getByLabelText(/Name in Arabic/);
    await userEvent.clear(arabic);
    await userEvent.type(arabic, 'قميص');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(api.updateStyle).toHaveBeenCalledWith(STYLE_ID, {
      updatedAt: '2026-11-03T10:00:00.123456Z',
      name: { en: 'Tee', ar: 'قميص' },
    });
  });

  it('names the field when the api answers FIELD_OWNED_BY_CHANNEL', async () => {
    api.updateStyle.mockRejectedValue(
      new ApiError(409, { code: 'FIELD_OWNED_BY_CHANNEL', field: 'name.en' }),
    );
    await open(linked({ channelNameLanguage: null }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    await userEvent.type(within(dialog).getByLabelText(/Name in English/), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The English name comes from Shopify and can only be changed there.',
    );
  });

  it('shows the Arabic wording for a tags refusal', async () => {
    api.updateStyle.mockRejectedValue(
      new ApiError(409, { code: 'FIELD_OWNED_BY_CHANNEL', field: 'tags' }),
    );
    await open(linked({ channelNameLanguage: null, tags: [] }), inArabic);
    const edit = screen.getAllByRole('button').find((b) => b.textContent === 'تعديل النمط');
    await userEvent.click(edit ?? screen.getAllByRole('button')[0]!);
    const dialog = await screen.findByRole('dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    await userEvent.type(inputs[0]!, 'x');
    await userEvent.click(
      within(dialog)
        .getAllByRole('button')
        .find((b) => (b as HTMLButtonElement).type === 'submit')!,
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'الوسوم قادمة من شوبيفاي ولا يمكن تغييرها إلا هناك.',
    );
  });

  it('gives the channel barcode no Remove button and keeps Remove on the app one', async () => {
    await open(linked());
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    await userEvent.click(within(table).getByRole('button', { name: 'Barcodes of TEE-M' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Remove barcode APP-1' })).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Remove barcode SHOP-1' })).toBeNull();
    expect(within(dialog).getByText('From Shopify')).toBeVisible();
  });

  it('offers only the existing option values when adding a SKU to a linked style', async () => {
    await open(linked());
    await userEvent.click(screen.getByRole('button', { name: 'Add SKU' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Option 1 name/)).toHaveAttribute('readonly');
    const value = within(dialog).getByLabelText(/Option 1 value/);
    expect(value.tagName).toBe('SELECT');
    expect(
      within(value)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['', 'M', 'L']);
    expect(within(dialog).queryByRole('button', { name: 'Add option' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Remove option/ })).toBeNull();
  });
});
