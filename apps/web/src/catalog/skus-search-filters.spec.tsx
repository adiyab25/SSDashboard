import type { SkuDetail, SkuSummary } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { SkuDetailPage } from './sku-detail-page';
import { SkusPage } from './skus-page';

const api = vi.hoisted(() => ({
  listSkus: vi.fn(),
  getSku: vi.fn(),
  getSkuStock: vi.fn(),
  listSkuMovements: vi.fn(),
  getSkuUsage: vi.fn(),
}));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('@/shell/client-config', () => ({ loadConfig: () => new Promise(() => undefined) }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: SKU_ID }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['warehouse'], permissions: ['stock.view'] },
  }),
}));

const SKU_ID = '00000000-0000-4000-8000-000000000001';
const SEASON = {
  id: '30000000-0000-4000-8000-000000000001',
  code: 'SS27',
  name: { en: 'Summer 27', ar: 'صيف ٢٧' },
};
const GROUP = {
  id: '20000000-0000-4000-8000-000000000002',
  code: 'TOPS',
  name: { en: 'Tops', ar: 'قمصان' },
};
const OPTIONS = [
  { name: { en: 'Size', ar: 'المقاس' }, value: { en: 'M', ar: 'وسط' } },
  { name: { en: 'Color', ar: 'اللون' }, value: { en: 'Black', ar: 'أسود' } },
];

const sku = (n: number, overrides: Partial<SkuSummary> = {}): SkuSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  productId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code: `TEE-${n}`,
  name: { en: 'Tee', ar: 'تيشيرت' },
  style: {
    id: '40000000-0000-4000-8000-000000000001',
    code: 'TEE',
    name: { en: 'Tee', ar: 'تيشيرت' },
  },
  season: SEASON,
  productGroup: GROUP,
  options: OPTIONS,
  price: '12.50',
  archived: false,
  ...overrides,
});

const detail = (overrides: Partial<SkuDetail> = {}): SkuDetail => ({
  ...sku(1),
  status: 'active',
  updatedAt: 'x',
  barcodes: [{ id: '50000000-0000-4000-8000-000000000001', code: '6221234567890' }],
  ...overrides,
});

const inArabic = (ui: ReactNode) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe('SkusPage columns, search, and filters (spec 0012, AC-3, AC-4)', () => {
  it('shows style code, season, group, and option values, and "No season" when null', async () => {
    api.listSkus.mockResolvedValue({
      items: [sku(1), sku(2, { season: null })],
      nextCursor: null,
    });
    renderWithQuery(<SkusPage />);

    const table = await screen.findByRole('table', { name: 'SKUs' });
    for (const header of ['SKU', 'Name', 'Style', 'Season', 'Group', 'Selling price', 'Status']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeVisible();
    }
    const first = within(table).getByRole('row', { name: /TEE-1/ });
    expect(within(first).getByText('Summer 27')).toBeVisible();
    expect(within(first).getByText('Tops')).toBeVisible();
    expect(within(first).getByText('M, Black')).toBeVisible();
    expect(within(first).getByText('TEE', { selector: 'bdi' })).toHaveAttribute('dir', 'ltr');
    expect(
      within(within(table).getByRole('row', { name: /TEE-2/ })).getByText('No season'),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('sends the season and group filters, including none, and keeps the options it met', async () => {
    api.listSkus.mockResolvedValue({ items: [sku(1)], nextCursor: null });
    renderWithQuery(<SkusPage />);
    await screen.findByRole('table', { name: 'SKUs' });

    const season = screen.getByLabelText('Season');
    await waitFor(() =>
      expect(within(season).getByRole('option', { name: 'Summer 27' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(season, SEASON.id);
    await waitFor(() =>
      expect(api.listSkus).toHaveBeenLastCalledWith(
        { q: '', status: 'active', seasonId: SEASON.id },
        undefined,
        expect.anything(),
      ),
    );
    await userEvent.selectOptions(season, 'none');
    await userEvent.selectOptions(screen.getByLabelText('Group'), GROUP.id);
    await waitFor(() =>
      expect(api.listSkus).toHaveBeenLastCalledWith(
        { q: '', status: 'active', seasonId: 'none', productGroupId: GROUP.id },
        undefined,
        expect.anything(),
      ),
    );
    expect(within(season).getByRole('option', { name: 'No season' })).toBeInTheDocument();
    expect(within(season).getByRole('option', { name: 'Summer 27' })).toBeInTheDocument();
  });

  it('combines the search with a filter and says nothing matched', async () => {
    api.listSkus.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<SkusPage />);
    await screen.findByText(/No SKUs yet/);

    await userEvent.type(screen.getByLabelText('Name, SKU or barcode'), '6221234567890');
    await userEvent.selectOptions(screen.getByLabelText('Season'), 'none');
    await waitFor(() =>
      expect(api.listSkus).toHaveBeenLastCalledWith(
        { q: '6221234567890', status: 'active', seasonId: 'none' },
        undefined,
        expect.anything(),
      ),
    );
    expect(await screen.findByText('No SKU matches this search.')).toBeVisible();
  });

  it('reads in Arabic with the Arabic names and labels', async () => {
    api.listSkus.mockResolvedValue({
      items: [sku(1), sku(2, { season: null })],
      nextCursor: null,
    });
    renderWithQuery(inArabic(<SkusPage />));

    const table = await screen.findByRole('table', { name: 'الأصناف' });
    const first = within(table).getByRole('row', { name: /TEE-1/ });
    expect(within(first).getByText('صيف ٢٧')).toBeVisible();
    expect(within(first).getByText('قمصان')).toBeVisible();
    expect(within(first).getByText('وسط، أسود')).toBeVisible();
    expect(
      within(within(table).getByRole('row', { name: /TEE-2/ })).getByText('بدون موسم'),
    ).toBeVisible();
    expect(screen.getByLabelText('الاسم أو رمز الصنف أو الباركود')).toBeVisible();
    expect(screen.getByLabelText('الموسم')).toBeVisible();
    expect(screen.getByLabelText('المجموعة')).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'الموديل' })).toBeVisible();
  });

  it('shows the error state with a retry', async () => {
    api.listSkus.mockRejectedValue(new Error('down'));
    renderWithQuery(<SkusPage />);
    expect(await screen.findByText('The SKUs could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('SKU page style block (spec 0012, AC-4)', () => {
  function arrange(sku: SkuDetail) {
    api.getSku.mockResolvedValue(sku);
    api.getSkuStock.mockResolvedValue({ locations: [], totalOnHand: 0 });
    api.listSkuMovements.mockResolvedValue({ items: [], nextCursor: null });
  }

  it('shows style, season, group, options, and barcodes read only', async () => {
    arrange(detail());
    renderWithQuery(<SkuDetailPage />);

    const block = await screen.findByRole('region', { name: 'About this SKU' });
    expect(within(block).getByText('TEE', { selector: 'bdi' })).toBeVisible();
    expect(within(block).getByText('Summer 27')).toBeVisible();
    expect(within(block).getByText('Tops')).toBeVisible();
    expect(within(block).getByText('Size: M, Color: Black')).toBeVisible();
    expect(within(block).getByText('6221234567890')).toHaveAttribute('dir', 'ltr');
    expect(within(block).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('says No season, No options, and No barcodes when there are none', async () => {
    arrange(detail({ season: null, options: [], barcodes: [] }));
    renderWithQuery(<SkuDetailPage />);

    const block = await screen.findByRole('region', { name: 'About this SKU' });
    expect(within(block).getByText('No season')).toBeVisible();
    expect(within(block).getByText('No options')).toBeVisible();
    expect(within(block).getByText('No barcodes')).toBeVisible();
  });

  it('reads in Arabic', async () => {
    arrange(detail());
    renderWithQuery(inArabic(<SkuDetailPage />));

    const block = await screen.findByRole('region', { name: 'عن هذا الصنف' });
    expect(within(block).getByText('صيف ٢٧')).toBeVisible();
    expect(within(block).getByText('قمصان')).toBeVisible();
    expect(within(block).getByText('المقاس: وسط، اللون: أسود')).toBeVisible();
    expect(within(block).getByText('الباركود')).toBeVisible();
  });
});
