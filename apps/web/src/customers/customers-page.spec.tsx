import type { CustomerBrief } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { classifyCustomerSearch } from './customer-search-input';
import { CustomersPage } from './customers-page';

const api = vi.hoisted(() => ({ searchCustomers: vi.fn(), getCustomer: vi.fn() }));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: { id: 'me', hats: ['support'], permissions: ['customers.view'] },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const brief = (n: number, overrides: Partial<CustomerBrief> = {}): CustomerBrief => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Customer ${n}`,
  primaryPhone: `+201001234${String(n).padStart(3, '0')}`,
  phoneCount: 1,
  flagKind: null,
  flagSource: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  ...overrides,
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = { id: 'me', hats: ['support'], permissions: ['customers.view'] };
});

describe('classifyCustomerSearch (AC-3)', () => {
  it.each(['01001234567', '+20 100 123 4567', '0010 0123 4567', '٠١٠٠١٢٣٤٥٦٧', '(010) 0123-4567'])(
    'reads %s as a phone',
    (typed) => {
      expect(classifyCustomerSearch(typed).kind).toBe('phone');
    },
  );

  it('reads letters as a name and checks the length the api enforces', () => {
    expect(classifyCustomerSearch('Mona')).toEqual({ kind: 'name', text: 'Mona' });
    expect(classifyCustomerSearch('منى')).toEqual({ kind: 'name', text: 'منى' });
    expect(classifyCustomerSearch('Mo').kind).toBe('name-too-short');
    expect(classifyCustomerSearch('x'.repeat(101)).kind).toBe('name-too-long');
    expect(classifyCustomerSearch('   ').kind).toBe('empty');
  });
});

describe('CustomersPage (AC-3, AC-5, AC-18)', () => {
  it('asks nothing until Search, has one h1, and posts a phone in the body', async () => {
    api.searchCustomers.mockResolvedValue({
      items: [brief(1, { flagKind: 'refuser', flagSource: 'manual' }), brief(2, { name: null })],
      nextCursor: null,
    });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Search to see customers')).toBeVisible();
    expect(api.searchCustomers).not.toHaveBeenCalled();

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), '٠١٠٠١٢٣٤٥٦٧');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const table = await screen.findByRole('table', { name: 'Customers found' });
    expect(api.searchCustomers).toHaveBeenCalledWith(
      { phone: '٠١٠٠١٢٣٤٥٦٧' },
      undefined,
      expect.anything(),
    );
    expect(within(table).getByRole('link', { name: 'Customer 1' })).toHaveAttribute(
      'href',
      `/customers/${brief(1).id}`,
    );
    expect(within(table).getByRole('link', { name: 'No name yet' })).toBeVisible();
    expect(within(table).getByText('Refuses orders')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('2 customers found');
  });

  it('searches a name fragment, and refuses a short one without asking the api', async () => {
    api.searchCustomers.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);
    const box = screen.getByRole('searchbox', { name: 'Phone number or name' });

    await user.type(box, 'Mo');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type at least 3 characters');
    expect(api.searchCustomers).not.toHaveBeenCalled();

    await user.type(box, 'na');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No customer found')).toBeVisible();
    expect(api.searchCustomers).toHaveBeenCalledWith(
      { nameContains: 'Mona' },
      undefined,
      expect.anything(),
    );
  });

  it('says so when the api answers INVALID_PHONE', async () => {
    api.searchCustomers.mockRejectedValue(new ApiError(400, { code: 'INVALID_PHONE' }));
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), '123');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid phone number');
  });

  it('says to wait on a 429 and offers no retry', async () => {
    api.searchCustomers.mockRejectedValue(new ApiError(429, { code: 'SEARCH_RATE_LIMITED' }, 40));
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), '01001234567');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many searches. Wait a minute and try again.',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Could not search customers. Try again.')).toBeNull();
  });

  it('asks the api again when the same search is repeated', async () => {
    api.searchCustomers.mockResolvedValue({ items: [brief(1)], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), '01001234567');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('table', { name: 'Customers found' });
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(api.searchCustomers).toHaveBeenCalledTimes(2));
  });

  it('says more is available while a next page exists, and the status element stays mounted', async () => {
    api.searchCustomers.mockResolvedValue({ items: [brief(1)], nextCursor: 'c1' });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), 'Customer');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(status).toHaveTextContent('Showing 1 customer, more available'));
    expect(screen.getByRole('status')).toBe(status);
  });

  it('keeps the rows and retries only the next page when Load more fails', async () => {
    api.searchCustomers
      .mockResolvedValueOnce({ items: [brief(1)], nextCursor: 'c1' })
      .mockRejectedValueOnce(new ApiError(400, { code: 'INVALID_CURSOR' }))
      .mockResolvedValueOnce({ items: [brief(2)], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), 'Customer');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Could not load more customers.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Customer 1' })).toBeVisible();
    expect(screen.queryByText('Could not search customers. Try again.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Customer 2' })).toBeVisible();
    expect(api.searchCustomers).toHaveBeenCalledTimes(3);
    expect(api.searchCustomers).toHaveBeenLastCalledWith(
      { nameContains: 'Customer' },
      'c1',
      expect.anything(),
    );
  });

  it('isolates a name with direction controls in a bdi', async () => {
    const spoof = 'Mona ‮evil';
    api.searchCustomers.mockResolvedValue({ items: [brief(1, { name: spoof })], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), 'Mona');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const link = await screen.findByRole('link', { name: spoof });
    const isolated = link.querySelector('bdi');
    expect(isolated).toHaveAttribute('dir', 'auto');
    expect(isolated?.textContent).toBe(spoof);
  });

  it('loads the next page with the cursor', async () => {
    api.searchCustomers
      .mockResolvedValueOnce({ items: [brief(1)], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [brief(2)], nextCursor: null });
    const user = userEvent.setup();
    renderWithQuery(<CustomersPage />);

    await user.type(screen.getByRole('searchbox', { name: 'Phone number or name' }), 'Customer');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByRole('link', { name: 'Customer 2' })).toBeVisible());
    expect(api.searchCustomers).toHaveBeenLastCalledWith(
      { nameContains: 'Customer' },
      'c1',
      expect.anything(),
    );
  });

  it('shows the no access state and asks the api for nothing without customers.view', () => {
    me.current = { id: 'me', hats: ['warehouse'], permissions: ['stock.view'] };
    renderWithQuery(<CustomersPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('You do not have access to this page')).toBeVisible();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(api.searchCustomers).not.toHaveBeenCalled();
  });
});
