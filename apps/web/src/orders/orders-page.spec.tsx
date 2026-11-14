import type { OrderListItem } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { EMPTY_FILTERS, queryOf } from './order-filters';
import { OrdersPage } from './orders-page';

const api = vi.hoisted(() => ({ listOrders: vi.fn(), getOrderFilterOptions: vi.fn() }));
vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address.search),
}));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: { id: 'me', hats: ['support'], permissions: ['orders.view', 'orders.confirm'] },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const order = (n: number, overrides: Partial<OrderListItem> = {}): OrderListItem => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  storeCode: 'ESS',
  orderNumber: `#${1000 + n}`,
  placedAt: '2026-11-03T10:00:00.000Z',
  shipToName: `Mona ${n}`,
  channelId: '10000000-0000-4000-8000-000000000001',
  channelName: { en: 'WhatsApp' },
  totalAmount: '500.00',
  codDueAmount: '500.00',
  fulfillmentState: 'new',
  cashState: 'unpaid',
  outcome: 'open',
  type: 'sale',
  giftReasonCode: null,
  hold: false,
  short: false,
  reopened: false,
  phoneNeedsFix: false,
  ...overrides,
});

const FILTER_OPTIONS = {
  stores: [
    { id: '20000000-0000-4000-8000-000000000001', code: 'ESS', name: { en: 'Essentials' } },
    { id: '20000000-0000-4000-8000-000000000002', code: 'SHP', name: { en: 'Shopify store' } },
  ],
  channels: [
    {
      id: '10000000-0000-4000-8000-000000000002',
      code: 'shop',
      name: { en: 'Online shop' },
      kind: 'shopify',
    },
  ],
};

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  address.search = '';
  me.current = { id: 'me', hats: ['support'], permissions: ['orders.view', 'orders.confirm'] };
});

describe('queryOf (AC-4)', () => {
  it('sends only the filters that are set, lists as repeated values, and never invents a search', () => {
    expect(queryOf(EMPTY_FILTERS, undefined)).toEqual({ limit: 50 });
    expect(
      queryOf(
        { ...EMPTY_FILTERS, fulfillment: ['new', 'packed'], hold: true, dayFrom: '2026-11-01' },
        'abc',
      ),
    ).toEqual({
      fulfillment: ['new', 'packed'],
      hold: true,
      dayFrom: '2026-11-01',
      cursor: 'abc',
      limit: 50,
    });
  });
});

describe('OrdersPage (AC-3, AC-4, AC-20)', () => {
  it('lists orders with the store beside every number, chips, flags, and one h1', async () => {
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders.mockResolvedValue({
      items: [
        order(1, { hold: true, short: true, phoneNeedsFix: true }),
        order(2, {
          fulfillmentState: 'refused',
          outcome: 'failed_delivery',
          cashState: 'nothing_to_collect',
          type: 'gifted',
          giftReasonCode: 'influencer',
        }),
      ],
      nextCursor: null,
    });
    renderWithQuery(<OrdersPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const table = await screen.findByRole('table', { name: 'Orders' });
    const link = within(table).getByRole('link', { name: 'ESS/#1001' });
    expect(link).toHaveAttribute('href', `/orders/${order(1).id}`);
    expect(within(table).getByText('Edit not synced, hold')).toBeVisible();
    expect(within(table).getByText('Short of stock')).toBeVisible();
    expect(within(table).getByText('Phone needs fixing')).toBeVisible();
    expect(within(table).getByText('Gift: Influencer')).toBeVisible();
    expect(within(table).getByText('Refused')).toBeVisible();
    expect(within(table).getByText('Delivery failed')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('2 orders shown');
    expect(screen.getByRole('link', { name: 'New order' })).toHaveAttribute('href', '/orders/new');
  });

  it('draws Search as a secondary button so New order is the only main action', async () => {
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders.mockResolvedValue({ items: [order(1)], nextCursor: null });
    renderWithQuery(<OrdersPage />);

    await screen.findByRole('table', { name: 'Orders' });
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
  });

  it('says more is available and loads the next page by cursor', async () => {
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders
      .mockResolvedValueOnce({ items: [order(1)], nextCursor: 'next-1' })
      .mockResolvedValueOnce({ items: [order(2)], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<OrdersPage />);

    await screen.findByRole('table', { name: 'Orders' });
    expect(screen.getByRole('status')).toHaveTextContent('1 order shown, more available');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 orders shown'));
    expect(screen.getByRole('status')).not.toHaveTextContent('more available');
    expect(api.listOrders).toHaveBeenLastCalledWith(expect.anything(), 'next-1', expect.anything());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps the rows and retries only the next page when Load more fails', async () => {
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders
      .mockResolvedValueOnce({ items: [order(1)], nextCursor: 'next-1' })
      .mockRejectedValueOnce(new ApiError(500, { code: 'generic' }))
      .mockResolvedValueOnce({ items: [order(2)], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<OrdersPage />);

    await screen.findByRole('table', { name: 'Orders' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The next orders could not be loaded.',
    );
    expect(screen.getByRole('link', { name: 'ESS/#1001' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'ESS/#1002' })).toBeVisible();
    expect(api.listOrders).toHaveBeenLastCalledWith(expect.anything(), 'next-1', expect.anything());
  });

  it('puts the typed search in the filters sent to the api, never in the address', async () => {
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<OrdersPage />);
    await screen.findByText('No orders yet');

    await user.type(screen.getByRole('searchbox', { name: 'Search orders' }), '٠١٠٠١٢٣٤٥٦٧');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('No orders match')).toBeVisible();
    expect(api.listOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: '٠١٠٠١٢٣٤٥٦٧' }),
      undefined,
      expect.anything(),
    );
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('٠١٠٠');
  });

  it('applies the customer filter from the customer page link and ignores a bad id', async () => {
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders.mockResolvedValue({ items: [order(1)], nextCursor: null });
    address.search = 'customerId=30000000-0000-4000-8000-000000000001';
    renderWithQuery(<OrdersPage />);

    await screen.findByRole('table', { name: 'Orders' });
    expect(api.listOrders).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: '30000000-0000-4000-8000-000000000001' }),
      undefined,
      expect.anything(),
    );
    expect(screen.getByText('Showing the orders of one customer.')).toBeVisible();
  });

  it('offers every store and channel, Shopify ones included, to a person who only has orders.view', async () => {
    me.current = { id: 'me', hats: ['warehouse'], permissions: ['orders.view'] };
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    api.listOrders.mockResolvedValue({ items: [order(1)], nextCursor: null });
    renderWithQuery(<OrdersPage />);

    const store = await screen.findByLabelText('Store');
    expect(await within(store).findByRole('option', { name: 'SHP · Shopify store' })).toBeVisible();
    expect(screen.getByLabelText('Channel')).toBeVisible();
    expect(
      within(screen.getByLabelText('Channel')).getByRole('option', { name: 'Online shop' }),
    ).toBeVisible();
    // No New order button without orders.confirm.
    expect(screen.queryByRole('link', { name: 'New order' })).toBeNull();
  });

  it('says to wait on a 429 and has one h1 in the no access state', async () => {
    api.listOrders.mockRejectedValue(new ApiError(429, { code: 'RATE_LIMITED' }, 30));
    api.getOrderFilterOptions.mockResolvedValue(FILTER_OPTIONS);
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many searches');
  });

  it('shows the no access state and asks for nothing without orders.view', () => {
    me.current = { id: 'me', hats: ['media_buyer'], permissions: ['campaigns.view'] };
    renderWithQuery(<OrdersPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('You do not have access to this page')).toBeVisible();
    expect(api.listOrders).not.toHaveBeenCalled();
    expect(api.getOrderFilterOptions).not.toHaveBeenCalled();
  });
});
