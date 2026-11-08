import type { CustomerProfile } from '@ssdashboard/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CustomerDetailPage } from './customer-detail-page';

const api = vi.hoisted(() => ({ searchCustomers: vi.fn(), getCustomer: vi.fn() }));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';
vi.mock('next/navigation', () => ({ useParams: () => ({ id: CUSTOMER_ID }) }));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: { id: 'me', hats: ['support'], permissions: ['customers.view'] },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const profile = (overrides: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: CUSTOMER_ID,
  resolvedFrom: null,
  name: 'Mona Adel',
  phones: [
    {
      e164: '+201001234567',
      kind: 'mobile',
      isPrimary: true,
      firstSeenAt: '2026-11-01T10:00:00.000Z',
      lastSeenAt: '2026-11-03T10:00:00.000Z',
    },
    {
      e164: '+201112223334',
      kind: 'mobile',
      isPrimary: false,
      firstSeenAt: '2026-11-02T10:00:00.000Z',
      lastSeenAt: '2026-11-02T10:00:00.000Z',
    },
  ],
  channelIds: [
    {
      id: '10000000-0000-4000-8000-000000000001',
      kind: 'shopify_customer',
      externalId: 'gid-1001',
      storeCode: 'MAIN',
      storeName: { en: 'Main store' },
      channelCode: null,
      channelName: null,
      createdAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      kind: 'shopify_customer',
      externalId: 'gid-2002',
      storeCode: null,
      storeName: null,
      channelCode: null,
      channelName: null,
      createdAt: '2026-11-02T10:00:00.000Z',
    },
  ],
  merges: [],
  flag: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...overrides,
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = { id: 'me', hats: ['support'], permissions: ['customers.view'] };
});

describe('CustomerDetailPage (AC-4, AC-18)', () => {
  it('shows the name as the one h1, every phone, and every channel id with its store', async () => {
    api.getCustomer.mockResolvedValue(profile());
    renderWithQuery(<CustomerDetailPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Mona Adel' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const phones = screen.getByRole('table', { name: 'Phone numbers of this customer' });
    expect(within(phones).getByText('+201001234567')).toBeVisible();
    expect(within(phones).getByText('+201112223334')).toBeVisible();
    expect(within(phones).getByText('Primary')).toBeVisible();
    const ids = screen.getByRole('table', { name: 'Channel ids of this customer' });
    expect(within(ids).getByText('Main store')).toBeVisible();
    expect(within(ids).getByText('Not known yet')).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says the record was merged when the api resolved another id', async () => {
    api.getCustomer.mockResolvedValue(
      profile({ resolvedFrom: '00000000-0000-4000-8000-0000000000aa' }),
    );
    renderWithQuery(<CustomerDetailPage />);

    expect(await screen.findByRole('status')).toHaveTextContent('was merged into the customer');
  });

  it('isolates the name in a bdi so direction controls cannot spoof neighbours', async () => {
    const spoof = 'Mona ‮evil';
    api.getCustomer.mockResolvedValue(profile({ name: spoof }));
    renderWithQuery(<CustomerDetailPage />);

    const heading = await screen.findByRole('heading', { level: 1, name: spoof });
    const isolated = heading.querySelector('bdi');
    expect(isolated).toHaveAttribute('dir', 'auto');
    expect(isolated?.textContent).toBe(spoof);
  });

  it('shows the flag and its note', async () => {
    api.getCustomer.mockResolvedValue(
      profile({
        flag: {
          kind: 'fake',
          source: 'manual',
          note: 'Gave a false address',
          setAt: '2026-11-03T10:00:00.000Z',
          setByName: 'Sam Carter',
        },
      }),
    );
    renderWithQuery(<CustomerDetailPage />);

    expect(await screen.findByText('Gave a false address')).toBeVisible();
    expect(screen.getByText('Sam Carter')).toBeVisible();
    expect(screen.getAllByText('Fake orders').length).toBeGreaterThan(0);
  });

  it('says the customer does not exist on a 404', async () => {
    api.getCustomer.mockRejectedValue(new ApiError(404, { code: 'CUSTOMER_NOT_FOUND' }));
    renderWithQuery(<CustomerDetailPage />);

    expect(await screen.findByText('This customer does not exist.')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the no access state and asks the api for nothing without customers.view', () => {
    me.current = { id: 'me', hats: ['warehouse'], permissions: ['stock.view'] };
    renderWithQuery(<CustomerDetailPage />);

    expect(screen.getByText('You do not have access to this page')).toBeVisible();
    expect(api.getCustomer).not.toHaveBeenCalled();
  });
});
