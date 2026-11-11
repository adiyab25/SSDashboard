import type { CustomerProfile, CustomerTimelinePage } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
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

const NO_SIGNAL = { signal: undefined } as const;
const EMPTY_PAGE: CustomerTimelinePage = { items: [], nextCursor: null };
const UNDO_NAME = /Undo the merge of Mona A\. on /;

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
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
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
    expect(screen.getByRole('button', { name: UNDO_NAME })).toBeVisible();
    // The refusal reason reads in words, not as the code.
    expect(screen.getByText(/Size did not fit/)).toBeVisible();
    expect(screen.queryByText('size')).toBeNull();
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

  it('names each refusal reason in words', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    const refused = (code: string, index: number) => ({
      ...page().items[0],
      id: `00000000-0000-4000-8000-00000000010${index}`,
      orderNumber: `SO-2026-${index}`,
      refusedReasonCode: code,
    });
    api.listCustomerTimeline.mockResolvedValue({
      nextCursor: null,
      items: ['changed_mind', 'price', 'not_ordered', 'damaged'].map(refused),
    });
    renderWithQuery(<CustomerDetailPage />);
    expect(await screen.findByText(/Changed their mind/)).toBeVisible();
    for (const words of ['Price', 'Did not order it', 'Damaged']) {
      expect(screen.getByText(new RegExp(words))).toBeVisible();
    }
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

  it('loads the next page with the cursor, appends it, and moves focus to its first entry', async () => {
    const second = {
      nextCursor: null,
      items: [
        {
          kind: 'phone_added' as const,
          id: '00000000-0000-4000-8000-000000000020',
          at: '2026-11-01T09:00:00.000Z',
          e164: '+201009999999',
          phoneKind: 'mobile' as const,
          isPrimary: false,
        },
      ],
    };
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    api.listCustomerTimeline
      .mockResolvedValueOnce({ ...page(), nextCursor: 'next-1' })
      .mockResolvedValueOnce(second);
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(api.listCustomerTimeline).toHaveBeenLastCalledWith(
        CUSTOMER_ID,
        'next-1',
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3),
    );
    const entries = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(entries[2]).toHaveTextContent('Phone number added');
    await waitFor(() => expect(entries[2]).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps Load more focusable while it fetches (aria-disabled, not disabled)', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    let finish: (value: CustomerTimelinePage) => void = () => undefined;
    api.listCustomerTimeline
      .mockResolvedValueOnce({ ...page(), nextCursor: 'next-1' })
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderWithQuery(<CustomerDetailPage />);
    const button = await screen.findByRole('button', { name: 'Load more' });
    await userEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(api.listCustomerTimeline).toHaveBeenCalledTimes(2);
    finish(EMPTY_PAGE);
  });

  it('shows the Load more error, keeps the first page, and the retry adds the next', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    api.listCustomerTimeline
      .mockResolvedValueOnce({ ...page(), nextCursor: 'next-1' })
      .mockRejectedValueOnce(new ApiError(500, { code: 'X' }))
      .mockResolvedValueOnce(EMPTY_PAGE);
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Could not load more entries.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'MAIN/SO-2026-1' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Could not load more entries.')).toBeNull());
    expect(api.listCustomerTimeline).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('link', { name: 'MAIN/SO-2026-1' })).toBeVisible();
  });

  it('announces the loading in a polite live region while the skeleton shows', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    let finish: (value: CustomerTimelinePage) => void = () => undefined;
    api.listCustomerTimeline.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderWithQuery(<CustomerDetailPage />);
    const live = await screen.findByText('Loading the timeline');
    expect(live).toHaveAttribute('aria-live', 'polite');
    finish(page());
    await screen.findByRole('link', { name: 'MAIN/SO-2026-1' });
    await waitFor(() => expect(screen.queryByText('Loading the timeline')).toBeNull());
  });

  it('shows a failed refresh while the entries stay', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    api.listCustomerTimeline
      .mockResolvedValueOnce(page({ undoable: true }))
      .mockRejectedValueOnce(new ApiError(500, { code: 'X' }));
    api.undoCustomerMerge.mockResolvedValue({});
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: UNDO_NAME }));
    expect(await screen.findByText('Could not load the timeline. Try again.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'MAIN/SO-2026-1' })).toBeVisible();
  });
});

describe('Undo from a timeline entry (AC-15)', () => {
  it('undoes the merge, refreshes the timeline, and moves focus to the Timeline heading', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    api.undoCustomerMerge.mockResolvedValue({});
    api.listCustomerTimeline.mockResolvedValueOnce(page({ undoable: true })).mockResolvedValue({
      nextCursor: null,
      items: [
        {
          ...page().items[1],
          kind: 'unmerge',
          id: '00000000-0000-4000-8000-000000000030',
          at: '2026-11-06T10:00:00.000Z',
          otherRole: 'merged',
        },
        ...page().items,
      ],
    });
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: UNDO_NAME }));
    expect(api.undoCustomerMerge).toHaveBeenCalledWith(MERGE_ID, { reasonCode: 'wrong_merge' });
    expect(toast.success).toHaveBeenCalledWith('Merge undone.');
    // The write refreshed the timeline query: the new entry shows and the Undo button is gone.
    expect(await screen.findByText('Merge undone')).toBeVisible();
    expect(api.listCustomerTimeline).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: UNDO_NAME })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Timeline' })).toHaveFocus(),
    );
  });

  it('keeps the Undo button and says why beside it when the undo fails', async () => {
    api.getCustomer.mockResolvedValue(profile(NO_SIGNAL));
    api.listCustomerTimeline.mockResolvedValue(page({ undoable: true }));
    api.undoCustomerMerge.mockRejectedValue(new ApiError(500, { code: 'X' }));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: UNDO_NAME }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/\S/);
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: UNDO_NAME })).toBeVisible();
  });

  it('gives the timeline Undo a different name than the one in the merges section', async () => {
    api.getCustomer.mockResolvedValue(
      profile({
        ...NO_SIGNAL,
        merges: [
          {
            mergeId: MERGE_ID,
            other: {
              id: OTHER_ID,
              name: 'Mona A.',
              primaryPhone: '+201001234567',
              phoneCount: 1,
              flagKind: null,
              flagSource: null,
              createdAt: '2026-11-01T10:00:00.000Z',
            },
            at: '2026-11-04T10:00:00.000Z',
            undoable: true,
          },
        ],
      }),
    );
    api.listCustomerTimeline.mockResolvedValue(page({ undoable: true }));
    renderWithQuery(<CustomerDetailPage />);
    await screen.findByRole('button', { name: UNDO_NAME });
    const names = screen
      .getAllByRole('button', { name: /^Undo the merge of/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
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

  it('keeps the outcome visible after the reloaded profile has no suggestion left', async () => {
    api.getCustomer
      .mockResolvedValueOnce(profile())
      .mockResolvedValue(profile({ signal: undefined }));
    api.listCustomerTimeline.mockResolvedValue(EMPTY_PAGE);
    api.setCustomerFlag.mockRejectedValue(new ApiError(422, { code: 'REASON_INVALID' }));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply the flag "Refuses orders"' }),
    );
    await waitFor(() => expect(screen.queryByText('Suggested flag')).toBeNull());
    expect(api.getCustomer).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('That suggestion no longer applies');
    expect(toast.error).toHaveBeenCalled();
  });

  it('says the record moved on a 409 and reloads', async () => {
    api.getCustomer.mockResolvedValue(profile());
    api.listCustomerTimeline.mockResolvedValue(EMPTY_PAGE);
    api.setCustomerFlag.mockRejectedValue(new ApiError(409, { code: 'STALE_RECORD' }));
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply the flag "Refuses orders"' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('This customer changed');
    await waitFor(() => expect(api.getCustomer).toHaveBeenCalledTimes(2));
  });

  it('moves focus to the flag card heading after a successful apply', async () => {
    api.getCustomer.mockResolvedValueOnce(profile()).mockResolvedValue(
      profile({
        flag: {
          kind: 'refuser',
          source: 'manual',
          note: null,
          setAt: '2026-11-11T10:00:00.000Z',
          setByName: null,
        },
        signal: undefined,
      }),
    );
    api.listCustomerTimeline.mockResolvedValue(EMPTY_PAGE);
    api.setCustomerFlag.mockResolvedValue({});
    renderWithQuery(<CustomerDetailPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply the flag "Refuses orders"' }),
    );
    const heading = await screen.findByRole('heading', { level: 2, name: 'Flag' });
    await waitFor(() => expect(heading).toHaveFocus());
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
