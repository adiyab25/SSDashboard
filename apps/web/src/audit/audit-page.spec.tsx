import type { AuditEntryView } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/inventory/render-with-query';
import { AuditPage } from './audit-page';

const api = vi.hoisted(() => ({
  listAuditEntries: vi.fn(),
  listPeople: vi.fn(() =>
    Promise.resolve([{ id: '00000000-0000-4000-8000-000000000500', name: 'Priya Picker' }]),
  ),
  getAuditEntry: vi.fn(),
  listRecordHistory: vi.fn(),
}));
const nav = vi.hoisted(() => ({ search: '', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
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

afterEach(() => {
  for (const mock of [api.listAuditEntries, api.getAuditEntry, api.listRecordHistory, nav.push]) {
    mock.mockReset();
  }
  nav.search = '';
});

describe('AuditPage (AC-12, AC-18)', () => {
  it('lists the actor, action label, record, and reason under one h1', async () => {
    api.listAuditEntries.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    renderWithQuery(<AuditPage />);

    const table = await screen.findByRole('table', { name: 'Audit entries' });
    expect(await within(table).findByText('Nour Admin')).toBeVisible();
    expect(within(table).getByText('Stock receipt voided')).toBeVisible();
    expect(within(table).getByText('SR-2026-000001')).toBeVisible();
    expect(within(table).getByText('Entered twice 1')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('labels a record type from the contracts registry and shows an unknown one as its code', async () => {
    api.listAuditEntries.mockResolvedValue({
      items: [
        entry(1, { record: { type: 'outbound_command', id: uuid(1), label: 'CMD-1' } }),
        entry(2, { record: { type: 'future_record', id: uuid(2), label: 'FR-2' } }),
      ],
      nextCursor: null,
    });
    renderWithQuery(<AuditPage />);

    const table = await screen.findByRole('table', { name: 'Audit entries' });
    expect(await within(table).findByText(/Carrier request/)).toBeVisible();
    expect(within(table).getByText('future_record')).toBeVisible();
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
    renderWithQuery(<AuditPage />);

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
    renderWithQuery(<AuditPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Entered twice 2')).toBeVisible();
    expect(screen.getByText('Entered twice 1')).toBeVisible();
    expect(api.listAuditEntries).toHaveBeenLastCalledWith({}, 'c1', expect.anything() as unknown);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('says No entries match on an empty list', async () => {
    api.listAuditEntries.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<AuditPage />);
    expect(await screen.findByText('No entries match')).toBeVisible();
  });

  it('shows an error with Try again that loads again', async () => {
    api.listAuditEntries.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    api.listAuditEntries.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    renderWithQuery(<AuditPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nour Admin')).toBeVisible();
  });

  it('shows the no audit access message on a 403, with no table', async () => {
    api.listAuditEntries.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' }));
    renderWithQuery(<AuditPage />);

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
    renderWithQuery(<AuditPage />);

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

  it('reads the filter from the URL and sends it with the list call', async () => {
    nav.search = `recordType=stock_receipt&dayFrom=2026-11-01&dayTo=2026-11-07&correlationId=${uuid(9)}`;
    api.listAuditEntries.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    renderWithQuery(<AuditPage />);

    await screen.findByText('Nour Admin');
    expect(api.listAuditEntries).toHaveBeenCalledWith(
      {
        recordType: 'stock_receipt',
        dayFrom: '2026-11-01',
        dayTo: '2026-11-07',
        correlationId: uuid(9),
      },
      undefined,
      expect.anything() as unknown,
    );
    expect(screen.getByLabelText('Record type')).toHaveValue('stock_receipt');
    expect(screen.getByLabelText('From day')).toHaveValue('2026-11-01');
  });

  it('puts applied filters in the URL, and refuses a record ID without a type', async () => {
    api.listAuditEntries.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<AuditPage />);

    await screen.findByText('No entries match');
    await userEvent.type(screen.getByLabelText('Record ID'), uuid(3));
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    const type = screen.getByLabelText('Record type');
    expect(type).toHaveAttribute('aria-invalid', 'true');
    expect(type).toHaveAccessibleDescription('Choose a record type to filter by record ID.');
    expect(type).toHaveFocus();
    expect(nav.push).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Record type'), 'stock_receipt');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(nav.push).toHaveBeenCalledWith(`/audit?recordType=stock_receipt&recordId=${uuid(3)}`);
  });

  it('shows a diff in the detail, hides personal values, and links to the same action', async () => {
    api.listAuditEntries.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    api.getAuditEntry.mockResolvedValue({
      ...entry(1),
      changes: [
        { field: 'status', before: 'posted', after: 'voided', personal: false },
        { field: 'phone', before: '[REDACTED]', after: '[REDACTED]', personal: true },
      ],
    });
    api.listRecordHistory.mockResolvedValue({ items: [entry(1)], nextCursor: null });
    renderWithQuery(<AuditPage />);

    await userEvent.click(
      await screen.findByRole('button', { name: /Details of Stock receipt voided/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Stock receipt voided' });
    const diff = await within(dialog).findByRole('table', { name: 'Changed fields' });
    expect(within(diff).getByRole('rowheader', { name: 'status' })).toBeVisible();
    expect(within(diff).getByText('voided')).toBeVisible();
    expect(within(diff).getAllByText('Hidden, personal data')).toHaveLength(2);
    expect(within(diff).queryByText('[REDACTED]')).toBeNull();
    expect(
      within(dialog).getByRole('link', { name: 'Show entries of the same action' }),
    ).toHaveAttribute('href', `/audit?correlationId=${uuid(901)}`);

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Show the history of this record' }),
    );
    expect(
      await within(dialog).findByRole('heading', { name: 'History of this record' }),
    ).toBeVisible();
    expect(api.listRecordHistory).toHaveBeenCalledWith(
      'stock_receipt',
      uuid(701),
      undefined,
      expect.anything() as unknown,
    );
  });
});
