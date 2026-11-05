import type { StockRow } from '@ssdashboard/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from './render-with-query';
import { StockPage } from './stock-page';

const api = vi.hoisted(() => ({ listStock: vi.fn(), searchSkus: vi.fn() }));
vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted((): { current: { id: string; role: string } | null } => ({
  current: { id: 'a', role: 'admin' },
}));
vi.mock('@/auth/use-me', () => ({ useMe: () => me.current }));

const WH = '50000000-0000-4000-8000-000000000001';
const shell = vi.hoisted(() => ({ current: 'all', ready: true }));
vi.mock('@/shell/current-location-provider', () => ({
  useCurrentLocation: () => shell.current,
  useLocationSwitcher: () => ({
    retry: vi.fn(),
    current: shell.current,
    ready: shell.ready,
    locations: [{ id: '50000000-0000-4000-8000-000000000001', code: 'WH', name: { en: 'Main' } }],
  }),
  locationName: (location: { code: string; name: { en?: string } }) =>
    location.name.en ?? location.code,
}));

const skuId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, overrides: Partial<StockRow> = {}): StockRow => ({
  sku: { id: skuId(n), code: `SKU-${n}`, name: { en: `Item ${n}` } },
  location: { id: WH, code: 'WH', name: { en: 'Main' } },
  onHand: 5,
  negative: false,
  lastMovedAt: '2026-11-03T10:00:00Z',
  ...overrides,
});
const page = (items: StockRow[], nextCursor: string | null = null) => ({ items, nextCursor });
const called = (location: string, skuIdValue: string | null, includeZero: boolean) => [
  location,
  { skuId: skuIdValue, includeZero },
  undefined,
  expect.anything() as unknown,
];

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = { id: 'a', role: 'admin' };
  shell.current = 'all';
  shell.ready = true;
});

describe('StockPage (AC-9, AC-16)', () => {
  it('lists rows, flags a negative row, has one h1, and shows cost and value to admins', async () => {
    api.listStock.mockResolvedValue(
      page([
        row(1, { avgUnitCost: '5.0000', totalValue: '25.00' }),
        row(2, { onHand: -3, negative: true, avgUnitCost: '5.0000', totalValue: '-15.00' }),
      ]),
    );
    renderWithQuery(<StockPage />);

    const table = await screen.findByRole('table', { name: 'Stock on hand' });
    expect(await within(table).findByText('SKU-1')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(table).getByText('Below zero')).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Average cost' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Stock value' })).toBeVisible();
    expect(api.listStock).toHaveBeenCalledWith(...called('all', null, false));
  });

  it('hides cost and value columns from staff', async () => {
    me.current = { id: 's', role: 'staff' };
    api.listStock.mockResolvedValue(page([row(1)]));
    renderWithQuery(<StockPage />);

    const table = await screen.findByRole('table', { name: 'Stock on hand' });
    expect(await within(table).findByText('SKU-1')).toBeVisible();
    expect(within(table).queryByRole('columnheader', { name: 'Average cost' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Stock value' })).toBeNull();
  });

  it('adds zero rows back with the Show rows at zero toggle', async () => {
    api.listStock.mockImplementation((_l: string, filters: { includeZero: boolean }) =>
      Promise.resolve(page(filters.includeZero ? [row(1), row(2, { onHand: 0 })] : [row(1)])),
    );
    renderWithQuery(<StockPage />);

    await screen.findByText('SKU-1');
    expect(screen.queryByText('SKU-2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show rows at zero' }));
    expect(await screen.findByText('SKU-2')).toBeVisible();
    expect(api.listStock).toHaveBeenLastCalledWith(...called('all', null, true));
  });

  it('filters by one SKU from the picker, by keyboard, and clears it', async () => {
    api.listStock.mockResolvedValue(page([row(1)]));
    api.searchSkus.mockResolvedValue({
      items: [
        {
          id: skuId(7),
          productId: 'p',
          code: 'SKU-7',
          name: { en: 'Item 7' },
          price: '1.00',
          archived: false,
        },
      ],
      nextCursor: null,
    });
    renderWithQuery(<StockPage />);
    await screen.findByText('SKU-1');

    screen.getByRole('combobox', { name: 'Filter by SKU' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByText('Item 7');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(api.listStock).toHaveBeenLastCalledWith(...called('all', skuId(7), false)),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Clear SKU filter' }));
    await waitFor(() =>
      expect(api.listStock).toHaveBeenLastCalledWith(...called('all', null, false)),
    );
    // The clear button is gone; focus returns to the picker rather than falling to the body.
    expect(screen.getByRole('combobox', { name: 'Filter by SKU' })).toHaveFocus();
  });

  it('does not ask for stock until the shell location is resolved', async () => {
    shell.ready = false;
    api.listStock.mockResolvedValue(page([row(1)]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const ui = () => (
      <QueryClientProvider client={client}>
        <StockPage />
      </QueryClientProvider>
    );
    const view = render(ui());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.listStock).not.toHaveBeenCalled();

    shell.ready = true;
    shell.current = WH;
    view.rerender(ui());
    await screen.findByText('SKU-1');
    expect(api.listStock).toHaveBeenCalledTimes(1);
    expect(api.listStock).toHaveBeenCalledWith(...called(WH, null, false));
  });

  it('follows the shell location', async () => {
    shell.current = WH;
    api.listStock.mockResolvedValue(page([row(1)]));
    renderWithQuery(<StockPage />);

    await screen.findByText('SKU-1');
    expect(api.listStock).toHaveBeenCalledWith(...called(WH, null, false));
    expect(screen.getByText(/Showing Main\./)).toBeVisible();
  });

  it('pages with Load more', async () => {
    api.listStock.mockImplementation((_l: string, _f: unknown, cursor?: string) =>
      Promise.resolve(cursor ? page([row(2)]) : page([row(1)], 'next')),
    );
    renderWithQuery(<StockPage />);

    await screen.findByText('SKU-1');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('SKU-2')).toBeVisible();
    expect(screen.getByText('SKU-1')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows the empty state with a receive link, and a filtered one without it', async () => {
    api.listStock.mockResolvedValue(page([]));
    renderWithQuery(<StockPage />);

    const table = await screen.findByRole('table', { name: 'Stock on hand' });
    expect(await within(table).findByText('No stock here yet')).toBeVisible();
    expect(within(table).getByRole('link', { name: 'Receive stock' })).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show rows at zero' }));
    expect(await within(table).findByText('No stock matches')).toBeVisible();
    expect(within(table).queryByRole('link', { name: 'Receive stock' })).toBeNull();
    // Show rows at zero is already on, so the hint must not tell the person to turn it on.
    expect(within(table).queryByText(/turn on Show rows at zero/)).toBeNull();
  });

  it('shows an error with a retry', async () => {
    api.listStock.mockRejectedValueOnce(new Error('boom'));
    api.listStock.mockResolvedValue(page([row(1)]));
    renderWithQuery(<StockPage />);

    expect(await screen.findByText('The stock list could not be loaded.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('SKU-1')).toBeVisible();
  });
});
