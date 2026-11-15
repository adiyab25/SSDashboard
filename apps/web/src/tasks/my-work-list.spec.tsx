import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { MyWorkList } from './my-work-list';
import { closableTaskOf, taskListRowOf } from './task-list-row-fixture';

const api = vi.hoisted(() => ({ listMyTasks: vi.fn(), closeTask: vi.fn() }));
vi.mock('./tasks-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const format = vi.hoisted(() => ({ asked: [] as string[], status: 'ready' }));
vi.mock('@/i18n/use-format', () => ({
  useFormat: () => ({
    status: format.status,
    dateTime: (instant: string) => {
      format.asked.push(instant);
      return 'Thu 12 Nov, 12:00 (Cairo)';
    },
  }),
}));

afterEach(() => {
  api.listMyTasks.mockReset();
  api.closeTask.mockReset();
  format.asked = [];
  format.status = 'ready';
});

const page = (rows: ReturnType<typeof taskListRowOf>[], nextCursor: string | null = null) => ({
  rows,
  nextCursor,
});

describe('MyWorkList (spec 0016, AC-5, AC-6, AC-14)', () => {
  it('lists the task with its type, order label and link, due time, and queue', async () => {
    api.listMyTasks.mockResolvedValue(page([taskListRowOf()]));
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText('Shopify change not synced')).toBeVisible();
    const link = screen.getByRole('link', { name: /Order\s*ESS\/#1001/ });
    expect(link).toHaveAttribute('href', '/orders/00000000-0000-4000-8000-000000000001');
    expect(screen.getByText('Due Thu 12 Nov, 12:00 (Cairo)')).toBeVisible();
    // The time goes through the brand time zone formatter, from the api's UTC instant.
    expect(format.asked).toEqual(['2026-11-12T10:00:00.000000Z']);
    expect(screen.getByText('In the Operations queue')).toBeVisible();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(api.listMyTasks).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('shows a neutral text, never the raw time, until the install settings are ready', async () => {
    format.status = 'loading';
    api.listMyTasks.mockResolvedValue(page([taskListRowOf()]));
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText('Time unavailable')).toBeVisible();
    expect(screen.queryByText(/2026-11-12/)).toBeNull();
    expect(format.asked).toEqual([]);
  });

  it('marks an overdue row with a word, not only a color, and names the person holding it', async () => {
    api.listMyTasks.mockResolvedValue(
      page([taskListRowOf({ overdue: true, ownerUserId: 'u', ownerName: 'Mona' })]),
    );
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText('Overdue')).toBeVisible();
    expect(screen.getByText('Held by Mona')).toBeVisible();
  });

  it('shows the plain reason instead of a Close button for a task only the system closes', async () => {
    api.listMyTasks.mockResolvedValue(page([taskListRowOf()]));
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText(/Closes by itself when the system sees/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Close/ })).toBeNull();
  });

  it('offers Close on a task a person may close, and opens the dialog from the keyboard', async () => {
    api.listMyTasks.mockResolvedValue(page([closableTaskOf()]));
    renderWithQuery(<MyWorkList enabled />);

    const close = await screen.findByRole('button', { name: 'Close Shopify change not synced' });
    close.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Close this task' });
    expect(within(dialog).getByRole('radio', { name: 'Synced to Shopify' })).toBeVisible();
  });

  it('shows a link without a label for a record kind the api cannot label', async () => {
    api.listMyTasks.mockResolvedValue(
      page([
        taskListRowOf({
          link: {
            kind: 'connection',
            id: '00000000-0000-4000-8000-000000000002',
            path: '/connections',
            label: null,
          },
        }),
      ]),
    );
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByRole('link', { name: 'Connection' })).toHaveAttribute(
      'href',
      '/connections',
    );
  });

  it('shows the record kind as plain text when the api gives no path (a missing order)', async () => {
    api.listMyTasks.mockResolvedValue(
      page([
        taskListRowOf({
          link: {
            kind: 'order',
            id: '00000000-0000-4000-8000-000000000001',
            path: null,
            label: null,
          },
        }),
      ]),
    );
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText('Order')).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so when no task needs the person, and shows no row', async () => {
    api.listMyTasks.mockResolvedValue(page([]));
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText('Nothing needs you right now')).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows an inline error with Try again when the first page fails', async () => {
    api.listMyTasks.mockRejectedValueOnce(new Error('boom'));
    api.listMyTasks.mockResolvedValueOnce(page([taskListRowOf()]));
    renderWithQuery(<MyWorkList enabled />);

    expect(await screen.findByText('Your tasks could not be loaded.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Shopify change not synced')).toBeVisible();
  });

  it('loads the next page with the cursor of the first', async () => {
    api.listMyTasks.mockResolvedValueOnce(page([taskListRowOf()], 'cursor-1'));
    api.listMyTasks.mockResolvedValueOnce(
      page([taskListRowOf({ id: '60000000-0000-4000-8000-000000000002' })]),
    );
    renderWithQuery(<MyWorkList enabled />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findAllByText('Shopify change not synced')).toHaveLength(2);
    expect(api.listMyTasks).toHaveBeenLastCalledWith('cursor-1', expect.anything());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('asks the api for nothing while it is not enabled', () => {
    renderWithQuery(<MyWorkList enabled={false} />);
    expect(api.listMyTasks).not.toHaveBeenCalled();
  });
});
