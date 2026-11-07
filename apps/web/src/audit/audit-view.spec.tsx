import type { AuditEntryView } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/inventory/render-with-query';
import { AuditView } from './audit-view';

const api = vi.hoisted(() => ({ listAuditEntries: vi.fn() }));
vi.mock('./audit-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (n: number, overrides: Partial<AuditEntryView> = {}): AuditEntryView => ({
  id: uuid(n),
  recordedAt: '2026-11-03T10:00:00.123456Z',
  operatingDay: '2026-11-03',
  correlationId: uuid(900 + n),
  actor: { kind: 'person', userId: uuid(500), ref: null, hat: 'manager', jobId: null },
  actorName: 'Nour Admin',
  action: 'stock_receipt.voided',
  record: { type: 'stock_receipt', id: uuid(700 + n), label: `SR-2026-00000${n}` },
  before: null,
  after: null,
  personalFields: [],
  reason: `Entered twice ${n}`,
  undone: false,
  canUndo: false,
  ...overrides,
});

afterEach(() => api.listAuditEntries.mockReset());

describe('AuditView (AC-12, AC-18)', () => {
  it('lists the actor, action label, record, and reason under one h1', async () => {
    api.listAuditEntries.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    renderWithQuery(<AuditView enabled />);

    const table = await screen.findByRole('table', { name: 'Audit entries' });
    expect(await within(table).findByText('Nour Admin')).toBeVisible();
    expect(within(table).getByText('Stock receipt voided')).toBeVisible();
    expect(within(table).getByText('SR-2026-000001')).toBeVisible();
    expect(within(table).getByText('Entered twice 1')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('names a system actor by its kind and reference, and an unknown action by its code', async () => {
    api.listAuditEntries.mockResolvedValue({
      items: [
        entry(1, {
          actorName: null,
          actor: {
            kind: 'system_job',
            userId: null,
            ref: 'nightly-close',
            hat: null,
            jobId: uuid(9),
          },
          action: 'future_thing.done',
          reason: null,
        }),
      ],
      nextCursor: null,
    });
    renderWithQuery(<AuditView enabled />);

    expect(await screen.findByText('System job')).toBeVisible();
    expect(screen.getByText('nightly-close')).toBeVisible();
    expect(screen.getByText('future_thing.done')).toBeVisible();
    expect(screen.getByText('No reason given')).toBeVisible();
  });

  it('loads the next page with the cursor', async () => {
    api.listAuditEntries.mockImplementation((_filter: unknown, cursor: string | undefined) =>
      Promise.resolve(
        cursor ? { items: [entry(2)], nextCursor: null } : { items: [entry(1)], nextCursor: 'c1' },
      ),
    );
    renderWithQuery(<AuditView enabled />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Entered twice 2')).toBeVisible();
    expect(screen.getByText('Entered twice 1')).toBeVisible();
    expect(api.listAuditEntries).toHaveBeenLastCalledWith({}, 'c1', expect.anything() as unknown);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('says No entries match on an empty list', async () => {
    api.listAuditEntries.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<AuditView enabled />);
    expect(await screen.findByText('No entries match')).toBeVisible();
  });

  it('shows an error with Try again that loads again', async () => {
    api.listAuditEntries.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    api.listAuditEntries.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    renderWithQuery(<AuditView enabled />);

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nour Admin')).toBeVisible();
  });

  it('shows the no audit access message on a 403, with no table', async () => {
    api.listAuditEntries.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' }));
    renderWithQuery(<AuditView enabled />);

    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(api.listAuditEntries).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on Load more while loading, then moves it to the end of list line', async () => {
    let release: (value: unknown) => void = () => undefined;
    api.listAuditEntries.mockImplementation((_filter: unknown, cursor: string | undefined) =>
      cursor
        ? new Promise((resolve) => {
            release = () => resolve({ items: [entry(2)], nextCursor: null });
          })
        : Promise.resolve({ items: [entry(1)], nextCursor: 'c1' }),
    );
    renderWithQuery(<AuditView enabled />);

    const more = await screen.findByRole('button', { name: 'Load more' });
    more.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(more).toHaveAttribute('aria-disabled', 'true'));
    expect(more).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(api.listAuditEntries).toHaveBeenCalledTimes(2);

    release(null);
    const end = await screen.findByText('End of the audit trail');
    await waitFor(() => expect(end).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
