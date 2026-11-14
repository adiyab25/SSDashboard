import type { SkuDetail } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { SkuDetailPage } from './sku-detail-page';

const api = vi.hoisted(() => ({
  getSku: vi.fn(),
  getSkuStock: vi.fn(),
  listSkuMovements: vi.fn(),
  getSkuUsage: vi.fn(),
  updateSku: vi.fn(),
}));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('@/api/refetch-after-write', () => ({ refetchAfterWrite: () => Promise.resolve() }));
vi.mock('@/shell/client-config', () => ({ loadConfig: () => new Promise(() => undefined) }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: SKU_ID }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['warehouse'], permissions: ['stock.view', 'catalog.edit'] },
  }),
}));

const SKU_ID = '00000000-0000-4000-8000-000000000001';
const GROUP = { id: '20000000-0000-4000-8000-000000000001', code: 'MAIN', name: { en: 'Main' } };

const sku = (overrides: Partial<SkuDetail> = {}): SkuDetail => ({
  id: SKU_ID,
  productId: '40000000-0000-4000-8000-000000000001',
  code: 'TEE-M',
  name: { en: 'Tee', ar: 'تيشيرت' },
  style: { id: '40000000-0000-4000-8000-000000000001', code: 'TEE', name: { en: 'Tee' } },
  season: null,
  productGroup: GROUP,
  options: [{ name: { en: 'Size' }, value: { en: 'M' } }],
  barcodes: [
    { id: '50000000-0000-4000-8000-000000000001', code: 'APP-1', fromChannel: false },
    { id: '50000000-0000-4000-8000-000000000002', code: 'SHOP-1', fromChannel: true },
  ],
  price: '250.00',
  archived: false,
  status: 'active',
  updatedAt: 'x',
  channelLinked: true,
  channelNameLanguage: 'en',
  ...overrides,
});

const inArabic = (ui: ReactElement) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

async function open(detail: SkuDetail, wrap: (ui: ReactElement) => ReactElement = (ui) => ui) {
  api.getSku.mockResolvedValue(detail);
  api.getSkuStock.mockResolvedValue({ locations: [], totalOnHand: 0 });
  api.listSkuMovements.mockResolvedValue({ items: [], nextCursor: null });
  api.getSkuUsage.mockResolvedValue({ codeLocked: false, canArchive: true });
  renderWithQuery(wrap(<SkuDetailPage />));
  await screen.findByRole('heading', { level: 1, name: 'TEE-M' });
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe('SKU page of a channel linked variant (spec 0012, AC-15)', () => {
  it('shows no From Shopify label while not linked', async () => {
    await open(
      sku({
        channelLinked: false,
        channelNameLanguage: null,
        barcodes: [
          { id: '50000000-0000-4000-8000-000000000001', code: 'APP-1', fromChannel: false },
        ],
      }),
    );
    expect(screen.queryByText('From Shopify')).toBeNull();
  });

  it('labels the price, style name, options, and only the channel barcode', async () => {
    await open(sku());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // price, style name, options, and one barcode
    expect(screen.getAllByText('From Shopify')).toHaveLength(4);
    const shop = screen.getByText('SHOP-1').closest('li')!;
    expect(within(shop).getByText('From Shopify')).toBeVisible();
    const app = screen.getByText('APP-1').closest('li')!;
    expect(within(app).queryByText('From Shopify')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('labels the same fields in Arabic', async () => {
    await open(sku(), inArabic);
    expect(screen.getAllByText('من شوبيفاي')).toHaveLength(4);
  });

  it('makes the price and the channel name read only in Edit, and keeps the other name editable', async () => {
    await open(sku());
    await userEvent.click(screen.getByRole('button', { name: 'Edit SKU' }));
    const dialog = await screen.findByRole('dialog');
    const price = await within(dialog).findByLabelText(/Selling price/);
    expect(price).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Name in English/)).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Name in Arabic/)).not.toHaveAttribute('readonly');
  });

  it('leaves the price editable when the variant is not linked', async () => {
    await open(sku({ channelLinked: false, channelNameLanguage: null }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit SKU' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByLabelText(/Selling price/)).not.toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/Name in English/)).not.toHaveAttribute('readonly');
  });

  it('names the price when the api answers FIELD_OWNED_BY_CHANNEL', async () => {
    api.updateSku.mockRejectedValue(
      new ApiError(409, { code: 'FIELD_OWNED_BY_CHANNEL', field: 'price' }),
    );
    await open(sku({ channelLinked: false, channelNameLanguage: null }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit SKU' }));
    const dialog = await screen.findByRole('dialog');
    const price = await within(dialog).findByLabelText(/Selling price/);
    await userEvent.clear(price);
    await userEvent.type(price, '300');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The price comes from Shopify and can only be changed there.',
    );
  });

  it('shows the Arabic wording for a name refusal', async () => {
    api.updateSku.mockRejectedValue(
      new ApiError(409, { code: 'FIELD_OWNED_BY_CHANNEL', field: 'name.ar' }),
    );
    await open(sku({ channelLinked: false, channelNameLanguage: null }), inArabic);
    const edit = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.includes('تعديل'));
    await userEvent.click(edit!);
    const dialog = await screen.findByRole('dialog');
    const submit = await vi.waitFor(() => {
      const found = within(dialog)
        .getAllByRole('button')
        .find((button) => (button as HTMLButtonElement).type === 'submit');
      if (!found) throw new Error('form not loaded');
      return found;
    });
    await userEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'الاسم العربي قادم من شوبيفاي ولا يمكن تغييره إلا هناك.',
    );
  });
});
