import type { CustomerProfile, CustomerTimelinePage } from '@ssdashboard/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CustomerDetailPage } from './customer-detail-page';

const api = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  listCustomerTimeline: vi.fn(),
  setCustomerFlag: vi.fn(),
  undoCustomerMerge: vi.fn(),
}));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const MERGE_ID = '00000000-0000-4000-8000-000000000003';
const ORDER_ID = '00000000-0000-4000-8000-000000000004';
vi.mock('next/navigation', () => ({ useParams: () => ({ id: CUSTOMER_ID }) }));

const me = vi.hoisted(() => ({
  current: {
    id: 'me',
    hats: ['support'],
    permissions: ['customers.view', 'customers.flag', 'customers.merge', 'orders.view'],
  },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const profile = (overrides: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: CUSTOMER_ID,
  resolvedFrom: null,
  name: 'Mona Adel',
  phones: [],
  channelIds: [],
  merges: [],
  flag: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  signal: { refusals: 2, returns: 0, windowDays: 180, suggestedKind: 'refuser' },
  orderCount: 2,
  ...overrides,
});

const page = (merge: object = {}): CustomerTimelinePage => ({
  nextCursor: null,
  items: [
    {
      kind: 'order',
      id: ORDER_ID,
      at: '2026-11-05T10:00:00.000Z',
      storeCode: 'MAIN',
      orderNumber: 'SO-2026-1',
      fulfillmentState: 'refused',
      cashState: 'nothing_to_collect',
      outcome: 'failed_delivery',
      totalAmount: '620.00',
      paymentMethod: 'cod',
      refusedReasonCode: 'size',
    },
    {
      kind: 'merge',
      id: MERGE_ID,
      at: '2026-11-04T10:00:00.000Z',
      other: {
        id: OTHER_ID,
        name: 'Mona A.',
        primaryPhone: '+201001234567',
        phoneCount: 1,
        flagKind: null,
        flagSource: null,
        createdAt: '2026-11-01T10:00:00.000Z',
      },
      otherRole: 'merged',
      actorName: 'Sara',
      reasonCode: 'same_person',
      ...merge,
    },
  ],
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = {
    id: 'me',
    hats: ['support'],
    permissions: ['customers.view', 'customers.flag', 'customers.merge', 'orders.view'],
  };
});

describe('the timeline on the profile (AC-14, AC-15)', () => {
  it('shows an order as a link to its page and a merge with Undo only when undoable', async () => {
    api.getCustomer.mockResolvedValue(profile({ signal: undefined }));
    api.listCustomerTimeline.mockResolvedValue(page({ undoable: true }));
    renderWithQuery(<CustomerDetailPage />);
    const order = await screen.findByRole('link', { name: 'MAIN/SO-2026-1' });
    expect(order).toHaveAttribute('href', `/orders/${ORDER_ID}`);
    expect(screen.getByRole('button', { name: 'Undo the merge of Mona A.' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open in audit' })).toBeNull();
  });

  it('shows no Undo and no audit link when the api sent neither', async () => {
    api.getCustomer.mockResolvedValue(profile({ signal: undefined }));
    api.listCustomerTimeline.mockResolvedValue(page());
    renderWithQuery(<CustomerDetailPage />);
    await screen.findByRole('link', { name: 'MAIN/SO-2026-1' });
    expect(screen.queryByRole('button', { name: /Undo the merge/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open in audit' })).toBeNull();
  });

  it('links to the audit screen when the api sent an audit link', async () => {
    api.getCustomer.mockResolvedValue(profile({ signal: undefined }));
    api.listCustomerTimeline.mockResolvedValue(
      page({ audit: { recordType: 'customer', recordId: OTHER_ID } }),
    );
    renderWithQuery(<CustomerDetailPage />);
    const link = await screen.findByRole('link', { name: 'Open in audit' });
    expect(link).toHaveAttribute('href', `/audit?recordType=customer&recordId=${OTHER_ID}`);
  });

  it('shows the empty state and an error with a retry', async () => {
    api.getCustomer.mockResolvedValue(profile({ signal: undefined }));
    api.listCustomerTimeline.mockResolvedValueOnce({ items: [], nextCursor: null });
    const first = renderWithQuery(<CustomerDetailPage />);
    expect(await screen.findByText('Nothing on the timeline yet')).toBeVisible();
    first.unmount();

    api.listCustomerTimeline.mockRejectedValueOnce(new ApiError(500, { code: 'X' }));
    renderWithQuery(<CustomerDetailPage />);
    expect(await screen.findByText('Could not load the timeline. Try again.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('loads the next page with the cursor', async () => {
    api.getCustomer.mockResolvedValue(profile({ signal: undefined }));
    api.listCustomerTimeline
      .mockResolvedValueOnce({ ...page(), nextCursor: 'next-1' })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(api.listCustomerTimeline).toHaveBeenLastCalledWith(
        CUSTOMER_ID,
        'next-1',
        expect.anything(),
      ),
    );
  });
});

describe('the suggested flag (AC-13)', () => {
  it('states the counts and applies the suggestion in one tap', async () => {
    api.getCustomer.mockResolvedValue(profile());
    api.listCustomerTimeline.mockResolvedValue({ items: [], nextCursor: null });
    api.setCustomerFlag.mockResolvedValue({});
    renderWithQuery(<CustomerDetailPage />);
    expect(
      await screen.findByText('2 orders refused at the door in the last 180 days'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Apply the flag "Refuses orders"' }));
    expect(api.setCustomerFlag).toHaveBeenCalledWith(CUSTOMER_ID, {
      kind: 'refuser',
      reasonCode: 'suggestion_applied',
      expectedUpdatedAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('says so when the suggestion no longer holds', async () => {
    api.getCustomer.mockResolvedValue(profile());
    api.listCustomerTimeline.mockResolvedValue({ items: [], nextCursor: null });
    api.setCustomerFlag.mockRejectedValue(new ApiError(422, { code: 'REASON_INVALID' }));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply the flag "Refuses orders"' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('That suggestion no longer applies');
  });

  it('leaves the button out without customers.flag, and the whole box without a signal or with a flag', async () => {
    me.current = {
      id: 'me',
      hats: ['support'],
      permissions: ['customers.view', 'orders.view'],
    };
    api.getCustomer.mockResolvedValue(profile());
    api.listCustomerTimeline.mockResolvedValue({ items: [], nextCursor: null });
    const first = renderWithQuery(<CustomerDetailPage />);
    expect(await screen.findByText('Suggested flag')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Apply the flag/ })).toBeNull();
    first.unmount();

    api.getCustomer.mockResolvedValue(profile({ signal: undefined }));
    const second = renderWithQuery(<CustomerDetailPage />);
    await screen.findByRole('heading', { level: 1, name: 'Mona Adel' });
    expect(screen.queryByText('Suggested flag')).toBeNull();
    second.unmount();

    api.getCustomer.mockResolvedValue(
      profile({
        flag: {
          kind: 'refuser',
          source: 'manual',
          note: null,
          setAt: '2026-11-03T10:00:00.000Z',
          setByName: null,
        },
      }),
    );
    renderWithQuery(<CustomerDetailPage />);
    await screen.findByRole('heading', { level: 1, name: 'Mona Adel' });
    expect(screen.queryByText('Suggested flag')).toBeNull();
  });
});
