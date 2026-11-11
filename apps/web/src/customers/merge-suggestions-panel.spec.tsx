import type { CustomerBrief, MergeSuggestionItem } from '@ssdashboard/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { customerKeys, listMergeSuggestions } from './customers-api';
import { MergeSuggestionsPanel } from './merge-suggestions-panel';

const api = vi.hoisted(() => ({ listMergeSuggestions: vi.fn(), dismissMergeSuggestion: vi.fn() }));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const brief = (n: number): CustomerBrief => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Customer ${n}`,
  primaryPhone: `+201001234${String(n).padStart(3, '0')}`,
  phoneCount: 1,
  flagKind: null,
  flagSource: null,
  createdAt: '2026-11-03T10:00:00.000Z',
});

const suggestion = (n: number): MergeSuggestionItem => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  reason: 'channel_id_conflict',
  createdAt: '2026-11-04T10:00:00.000Z',
  customers: [brief(n * 2), brief(n * 2 + 1)],
});

/** Owns the query the way the customers screen does. */
function Harness({ canMerge }: { canMerge: boolean }) {
  const query = useInfiniteQuery({
    queryKey: customerKeys.suggestions,
    queryFn: ({ pageParam, signal }) => listMergeSuggestions(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return <MergeSuggestionsPanel query={query} canMerge={canMerge} />;
}

const two = [suggestion(1), suggestion(2)];

afterEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(toast)]) mock.mockReset();
});

describe('MergeSuggestionsPanel (AC-9)', () => {
  it('drops the Actions column without customers.merge', async () => {
    api.listMergeSuggestions.mockResolvedValue({ items: two, nextCursor: null, openCount: 2 });
    renderWithQuery(<Harness canMerge={false} />);

    await screen.findByRole('table', { name: 'Merge suggestions' });
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Merge/ })).toBeNull();
  });

  it('dismisses one row and moves focus to the summary', async () => {
    api.listMergeSuggestions.mockResolvedValue({ items: two, nextCursor: null, openCount: 2 });
    api.dismissMergeSuggestion.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithQuery(<Harness canMerge />);

    await user.click((await screen.findAllByRole('button', { name: /^Dismiss/ }))[0]!);

    await waitFor(() => expect(api.dismissMergeSuggestion).toHaveBeenCalledWith(two[0]!.id, {}));
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Suggestions to review');
    expect(toast.success).toHaveBeenCalledWith('Suggestion dismissed.');
  });

  it('shows a failed dismiss beside its row too, and keeps the other rows usable', async () => {
    api.listMergeSuggestions.mockResolvedValue({ items: two, nextCursor: null, openCount: 2 });
    api.dismissMergeSuggestion.mockRejectedValue(new ApiError(409, { code: 'SUGGESTION_CLOSED' }));
    const user = userEvent.setup();
    renderWithQuery(<Harness canMerge />);

    const buttons = await screen.findAllByRole('button', { name: /^Dismiss/ });
    await user.click(buttons[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent('already handled');
    expect(toast.error).toHaveBeenCalledWith('This suggestion was already handled.');
    expect(screen.getAllByRole('button', { name: /^Dismiss/ })[1]).toBeEnabled();
  });

  it('keeps every row in flight disabled until its own call settles', async () => {
    api.listMergeSuggestions.mockResolvedValue({ items: two, nextCursor: null, openCount: 2 });
    const settle: Array<() => void> = [];
    api.dismissMergeSuggestion.mockImplementation(
      () => new Promise<void>((resolve) => settle.push(resolve)),
    );
    const user = userEvent.setup();
    renderWithQuery(<Harness canMerge />);

    const dismissButtons = () => screen.getAllByRole('button', { name: /^Dismiss/ });
    await screen.findAllByRole('button', { name: /^Dismiss/ });
    await user.click(dismissButtons()[0]!);
    await user.click(dismissButtons()[1]!);
    expect(dismissButtons()[0]).toBeDisabled();
    expect(dismissButtons()[1]).toBeDisabled();

    settle[1]?.();
    await waitFor(() => expect(dismissButtons()[1]).toBeEnabled());
    expect(dismissButtons()[0]).toBeDisabled();
    settle[0]?.();
  });
});
