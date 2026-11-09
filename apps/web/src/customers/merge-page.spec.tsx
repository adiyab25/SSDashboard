import type { CustomerProfile } from '@ssdashboard/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { MergePage } from './merge-page';
import { mergeErrorKey } from './merge-error-key';

const OLDER = '00000000-0000-4000-8000-000000000001';
const NEWER = '00000000-0000-4000-8000-000000000002';
const SUGGESTION = '00000000-0000-4000-8000-0000000000aa';
const MERGE_ID = '00000000-0000-4000-8000-0000000000bb';

const api = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  searchCustomers: vi.fn(),
  mergeCustomers: vi.fn(),
  undoCustomerMerge: vi.fn(),
}));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const nav = vi.hoisted(() => ({ search: '', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: { id: 'me', hats: ['support'], permissions: ['customers.view', 'customers.merge'] },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const profile = (id: string, name: string, createdAt: string): CustomerProfile => ({
  id,
  resolvedFrom: null,
  name,
  phones: [
    {
      e164: id === OLDER ? '+201001234567' : '+201112223334',
      kind: 'mobile',
      isPrimary: true,
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
    },
  ],
  channelIds: [],
  merges: [],
  flag: null,
  createdAt,
  updatedAt: createdAt,
});

const answers = () =>
  api.getCustomer.mockImplementation((id: string) =>
    Promise.resolve(
      id === OLDER
        ? profile(OLDER, 'Mona Old', '2026-10-01T10:00:00.000Z')
        : profile(NEWER, 'Mona New', '2026-11-01T10:00:00.000Z'),
    ),
  );

afterEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(toast), nav.push]) mock.mockReset();
  nav.search = '';
  me.current = { id: 'me', hats: ['support'], permissions: ['customers.view', 'customers.merge'] };
});

describe('MergePage (AC-7, AC-18)', () => {
  it('prefills both customers, keeps the older one, and merges with the suggestion', async () => {
    nav.search = `a=${NEWER}&b=${OLDER}&s=${SUGGESTION}`;
    answers();
    api.mergeCustomers.mockResolvedValue({ mergeId: MERGE_ID, survivor: {} });
    const user = userEvent.setup();
    renderWithQuery(<MergePage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The older record (second slot here) is the one to keep, with its badge.
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    const [first, second] = screen.getAllByRole('radio');
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
    expect(screen.getByText('Older record')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(api.mergeCustomers).toHaveBeenCalledWith({
        survivorId: OLDER,
        mergedId: NEWER,
        reasonCode: 'suggestion',
        suggestionId: SUGGESTION,
      }),
    );
    const [message, options] = toast.success.mock.calls[0] as [
      string,
      { action: { label: string } },
    ];
    expect(message).toBe('Customers merged.');
    expect(options.action.label).toBe('Undo');
    expect(nav.push).toHaveBeenCalledWith(`/customers/${OLDER}`);
  });

  it('Swap makes the other record the survivor', async () => {
    nav.search = `a=${OLDER}&b=${NEWER}`;
    answers();
    api.mergeCustomers.mockResolvedValue({ mergeId: MERGE_ID, survivor: {} });
    const user = userEvent.setup();
    renderWithQuery(<MergePage />);

    await screen.findAllByRole('radio');
    await user.click(await screen.findByRole('button', { name: 'Swap' }));
    await user.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() =>
      expect(api.mergeCustomers).toHaveBeenCalledWith({ survivorId: NEWER, mergedId: OLDER }),
    );
  });

  it('the Undo on the toast undoes with the wrong_merge reason', async () => {
    nav.search = `a=${OLDER}&b=${NEWER}`;
    answers();
    api.mergeCustomers.mockResolvedValue({ mergeId: MERGE_ID, survivor: {} });
    api.undoCustomerMerge.mockResolvedValue({ restoredId: NEWER, survivorId: OLDER });
    const user = userEvent.setup();
    renderWithQuery(<MergePage />);

    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const options = toast.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    options.action.onClick();

    await waitFor(() =>
      expect(api.undoCustomerMerge).toHaveBeenCalledWith(MERGE_ID, { reasonCode: 'wrong_merge' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Merge undone.'));
  });

  it('shows a refused merge as a translated message, never the api text', async () => {
    nav.search = `a=${OLDER}&b=${NEWER}`;
    answers();
    api.mergeCustomers.mockRejectedValue(new ApiError(409, { code: 'CUSTOMER_CHANGED' }));
    const user = userEvent.setup();
    renderWithQuery(<MergePage />);

    await user.click(await screen.findByRole('button', { name: 'Merge' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed while you were looking');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('finds a customer by phone for an empty slot', async () => {
    nav.search = `a=${OLDER}`;
    answers();
    api.searchCustomers.mockResolvedValue({
      items: [
        {
          id: NEWER,
          name: 'Mona New',
          primaryPhone: '+201112223334',
          phoneCount: 1,
          flagKind: null,
          flagSource: null,
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    renderWithQuery(<MergePage />);

    await user.type(await screen.findByRole('searchbox'), '01112223334');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await user.click(await screen.findByRole('button', { name: /Mona New/ }));

    expect(await screen.findAllByRole('radio')).toHaveLength(2);
    expect(api.searchCustomers).toHaveBeenCalledWith(
      { phone: '01112223334' },
      undefined,
      expect.anything(),
    );
  });

  it('says the two are already one customer when both ids resolve to the same record', async () => {
    nav.search = `a=${OLDER}&b=${NEWER}`;
    api.getCustomer.mockResolvedValue(profile(OLDER, 'Mona Old', '2026-10-01T10:00:00.000Z'));
    renderWithQuery(<MergePage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('already the same customer');
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
  });

  it('shows no access without customers.merge and loads nothing', () => {
    me.current = { id: 'me', hats: ['warehouse'], permissions: ['stock.view'] };
    nav.search = `a=${OLDER}&b=${NEWER}`;
    renderWithQuery(<MergePage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Merge customers' })).toBeVisible();
    expect(api.getCustomer).not.toHaveBeenCalled();
    expect(api.searchCustomers).not.toHaveBeenCalled();
  });
});

describe('mergeErrorKey', () => {
  it('maps each stable code to its message and anything else to the generic one', () => {
    expect(mergeErrorKey(new ApiError(409, { code: 'MERGE_NOT_LATEST' }))).toBe(
      'customers.merge.errors.MERGE_NOT_LATEST',
    );
    expect(mergeErrorKey(new ApiError(500, { code: 'WHATEVER' }))).toBe(
      'customers.merge.errors.generic',
    );
    expect(mergeErrorKey(new Error('boom'))).toBe('customers.merge.errors.generic');
  });
});
