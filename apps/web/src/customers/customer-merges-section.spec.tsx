import type { CustomerAbsorbedMerge } from '@ssdashboard/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CustomerMergesSection } from './customer-merges-section';

const api = vi.hoisted(() => ({ undoCustomerMerge: vi.fn() }));
vi.mock('./customers-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const me = vi.hoisted(() => ({ permissions: ['customers.view', 'customers.merge'] }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['support'], permissions: me.permissions },
  }),
}));

const MERGE_ID = '00000000-0000-4000-8000-0000000000bb';
const merge = (undoable: boolean): CustomerAbsorbedMerge => ({
  mergeId: MERGE_ID,
  other: {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Mona New',
    primaryPhone: '+201112223334',
    phoneCount: 1,
    flagKind: null,
    flagSource: null,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  at: '2026-11-05T10:00:00.000Z',
  undoable,
});

afterEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(toast)]) mock.mockReset();
  me.permissions = ['customers.view', 'customers.merge'];
});

describe('CustomerMergesSection (AC-4, AC-8)', () => {
  it('renders nothing when there are no merges', () => {
    const { container } = renderWithQuery(<CustomerMergesSection merges={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides Undo without customers.merge', () => {
    me.permissions = ['customers.view'];
    renderWithQuery(<CustomerMergesSection merges={[merge(true)]} />);
    expect(screen.getByText('Mona New')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('hides Undo when the merge is no longer undoable', () => {
    renderWithQuery(<CustomerMergesSection merges={[merge(false)]} />);
    expect(screen.getByText('Mona New')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('undoes with the wrong_merge reason', async () => {
    api.undoCustomerMerge.mockResolvedValue({});
    const user = userEvent.setup();
    renderWithQuery(<CustomerMergesSection merges={[merge(true)]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the merge of Mona New' }));

    await waitFor(() =>
      expect(api.undoCustomerMerge).toHaveBeenCalledWith(MERGE_ID, { reasonCode: 'wrong_merge' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Merge undone.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failed Undo inline as well as in a toast', async () => {
    api.undoCustomerMerge.mockRejectedValue(new ApiError(409, { code: 'MERGE_NOT_LATEST' }));
    const user = userEvent.setup();
    renderWithQuery(<CustomerMergesSection merges={[merge(true)]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the merge of Mona New' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A later merge touched');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('A later merge touched'));
    expect(screen.getByRole('button', { name: 'Undo the merge of Mona New' })).toBeEnabled();
  });
});
