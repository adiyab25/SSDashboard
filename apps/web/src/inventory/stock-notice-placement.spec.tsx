import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { ReceiptsView } from './receipts-view';
import { StockView } from './stock-view';

// Spec 0009 AC-29, wave 1 review W9: the stock pages carry the standing stock out source notice
// (its own spec covers when it shows). Here only where it is mounted: on the stock and receipts
// pages once access is known, and not before, so a page that is still checking access asks for
// nothing.

vi.mock('@/shell/stock-out-source-notice', () => ({
  StockOutSourceNotice: () => <div data-testid="stock-out-source-notice" />,
}));

vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listStock: () => new Promise(() => undefined),
  listReceipts: () => new Promise(() => undefined),
  searchSkus: () => new Promise(() => undefined),
}));

vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'a', hats: ['warehouse'], permissions: ['stock.view', 'stock.receive'] },
  }),
}));

vi.mock('@/shell/current-location-provider', () => ({
  useCurrentLocation: () => 'all',
  useLocationSwitcher: () => ({ retry: vi.fn(), current: 'all', ready: true, locations: [] }),
  locationName: () => '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('the stock out source notice on the stock pages (spec 0009, AC-29)', () => {
  it.each([
    ['the stock page', StockView],
    ['the receipts page', ReceiptsView],
  ])('is mounted on %s once access is known', (_name, View) => {
    renderWithQuery(<View enabled />);
    expect(screen.getByTestId('stock-out-source-notice')).toBeInTheDocument();
  });

  it.each([
    ['the stock page', StockView],
    ['the receipts page', ReceiptsView],
  ])('is not mounted on %s before access is known', (_name, View) => {
    renderWithQuery(<View enabled={false} />);
    expect(screen.queryByTestId('stock-out-source-notice')).toBeNull();
  });
});
