import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { ReceiptsPage } from './receipts-page';

const api = vi.hoisted(() => ({
  listReceipts: vi.fn(),
  getOnlineStatus: vi.fn(),
}));
vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
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
  locationName: (location: { code: string }) => location.code,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('ReceiptsPage buttons (spec 0025, one main action)', () => {
  it('draws the empty state action as a secondary button so the header one is the only main action', async () => {
    api.getOnlineStatus.mockResolvedValue({ online: false });
    api.listReceipts.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<ReceiptsPage />);

    const table = await screen.findByRole('table');
    const inTable = await within(table).findByRole('link', { name: /^Receive stock/ });
    expect(inTable).toHaveAttribute('data-variant', 'secondary');
    const header = screen
      .getAllByRole('link', { name: /^Receive stock/ })
      .filter((link) => !table.contains(link));
    expect(header).toHaveLength(1);
    expect(header[0]).toHaveAttribute('data-variant', 'default');
  });
});
