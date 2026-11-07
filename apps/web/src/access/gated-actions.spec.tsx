import type { SkuDetail, StockReceiptDetail } from '@ssdashboard/contracts';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkuView } from '@/catalog/sku-view';
import { SkusPage } from '@/catalog/skus-page';
import { ReceiptView } from '@/inventory/receipt-view';
import { ReceiptsPage } from '@/inventory/receipts-page';
import { renderWithQuery } from '@/inventory/render-with-query';
import { StockPage } from '@/inventory/stock-page';

const api = vi.hoisted(() => ({
  listSkus: vi.fn(),
  listStock: vi.fn(),
  listReceipts: vi.fn(),
  getSkuStock: vi.fn(),
  listSkuMovements: vi.fn(),
}));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/shell/current-location-provider', () => ({
  useCurrentLocation: () => 'all',
  useLocationSwitcher: () => ({ retry: vi.fn(), current: 'all', ready: true, locations: [] }),
  locationName: (location: { code: string }) => location.code,
}));

const me = vi.hoisted(() => ({
  hats: ['support'] as string[],
  permissions: [] as string[],
}));
vi.mock('@/auth/use-me', () => ({
  useMe: () => ({ id: 'me', hats: me.hats, permissions: me.permissions }),
}));

/** What the matrix gives each hat for the two permissions the gated actions need (spec 0008). */
const SUPPORT_ONLY = { hats: ['support'], permissions: ['stock.view'] };
const WAREHOUSE = {
  hats: ['warehouse'],
  permissions: ['stock.view', 'stock.receive', 'catalog.edit'],
};

const skuDetail: SkuDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  productId: '00000000-0000-4000-8000-000000000001',
  code: 'WIDGET-1',
  name: { en: 'Widget' },
  price: '9.00',
  archived: false,
  status: 'active',
  updatedAt: '2026-11-03T10:00:00.123456Z',
};

const receipt = {
  id: 'r1',
  number: 'SR-000001',
  status: 'posted',
  location: { id: 'l1', code: 'MAIN', name: { en: 'Main' } },
  effectiveAt: '2026-11-02T10:00:00.000Z',
  postedBy: { id: 'u1', name: 'Sam Carter' },
  lines: [],
} as unknown as StockReceiptDetail;

function wear(person: { hats: string[]; permissions: string[] }) {
  me.hats = person.hats;
  me.permissions = person.permissions;
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  wear(SUPPORT_ONLY);
});

describe.each([
  ['a support only person', SUPPORT_ONLY, false],
  ['a warehouse person', WAREHOUSE, true],
])('gated actions for %s (spec 0008, AC-11)', (_name, person, allowed) => {
  const shown = (control: HTMLElement | null) =>
    allowed ? expect(control).toBeVisible() : expect(control).toBeNull();

  // The empty list also offers a receive link, so count every one.
  const receiveLinks = (name: string | RegExp) =>
    expect(screen.queryAllByRole('link', { name })).toHaveLength(allowed ? 2 : 0);

  it('New SKU and Edit on the SKUs page need catalog.edit', async () => {
    wear(person);
    api.listSkus.mockResolvedValue({
      items: [{ ...skuDetail, status: undefined }],
      nextCursor: null,
    });
    renderWithQuery(<SkusPage />);
    await screen.findByRole('link', { name: 'WIDGET-1' });
    shown(screen.queryByRole('button', { name: 'New SKU' }));
    shown(screen.queryByRole('button', { name: /^Edit/ }));
  });

  it('Edit on the SKU page needs catalog.edit', async () => {
    wear(person);
    api.getSkuStock.mockResolvedValue({ locations: [], totalOnHand: 0 });
    api.listSkuMovements.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<SkuView sku={skuDetail} />);
    await screen.findByRole('heading', { level: 1 });
    shown(screen.queryByRole('button', { name: /^Edit/ }));
  });

  it('New SKU and Receive stock on the stock page need catalog.edit and stock.receive', async () => {
    wear(person);
    api.listStock.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<StockPage />);
    await screen.findByRole('table', { name: 'Stock on hand' });
    await waitFor(() => expect(api.listStock).toHaveBeenCalled());
    shown(screen.queryByRole('button', { name: 'New SKU' }));
    receiveLinks('Receive stock');
  });

  it('Receive stock on the receipts page needs stock.receive', async () => {
    wear(person);
    api.listReceipts.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<ReceiptsPage />);
    await screen.findByRole('table');
    await waitFor(() => expect(api.listReceipts).toHaveBeenCalled());
    receiveLinks(/^Receive stock/);
  });

  it('Receive more on a receipt needs stock.receive', () => {
    wear(person);
    renderWithQuery(<ReceiptView receipt={receipt} />);
    shown(screen.queryByRole('link', { name: /Receive more/ }));
  });
});
