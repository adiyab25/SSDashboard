import type * as Contracts from '@ssdashboard/contracts';
import type { AuditEntryView } from '@ssdashboard/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { AuditUndoError } from './audit-api';
import { AuditEntryDialog } from './audit-entry-dialog';
import { AuditEntriesTable } from './audit-entries-table';

const api = vi.hoisted(() => ({ getAuditEntry: vi.fn(), undoAuditEntry: vi.fn() }));
vi.mock('./audit-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

// No action is undoable in the real registry yet, so the specs plant two: one with free text
// reasons and one whose record type keeps reason codes.
vi.mock('@ssdashboard/contracts', async (original) => {
  const real = await original<typeof Contracts>();
  const fake = {
    'thing.done': {
      label: 'audit.actions.skuArchived',
      undoable: true,
      reason: 'optional',
    },
    'coded.done': {
      label: 'audit.actions.locationEdited',
      undoable: true,
      reason: 'optional',
      undoReasonCodes: ['customer_asked', 'entered_twice'],
    },
  } as const;
  const undone = { label: 'audit.actions.actionUndone' } as const;
  return {
    ...real,
    auditActionOf: (code: string) =>
      code === 'thing.done' || code === 'coded.done'
        ? fake[code]
        : code === 'thing.done_undone' || code === 'coded.done_undone'
          ? undone
          : real.auditActionOf(code),
    auditUndoneParentOf: (code: string) =>
      code === 'thing.done_undone'
        ? { code: 'thing.done', action: fake['thing.done'] }
        : real.auditUndoneParentOf(code),
  };
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (overrides: Partial<AuditEntryView> = {}): AuditEntryView => ({
  id: uuid(1),
  recordedAt: '2026-11-03T10:00:00.123456Z',
  operatingDay: '2026-11-03',
  correlationId: uuid(901),
  actor: { kind: 'person', userId: uuid(500), ref: null, hat: 'manager', jobId: null },
  actorName: 'Nour Admin',
  action: 'thing.done',
  record: { type: 'sku', id: uuid(701), label: 'SKU-1' },
  before: null,
  after: null,
  personalFields: [],
  reason: null,
  undone: false,
  canUndo: true,
  ...overrides,
});

function detail(base: AuditEntryView) {
  api.getAuditEntry.mockResolvedValue({ ...base, changes: [] });
}

/** The detail dialog open over a button that stands for the row's Details button. */
function open(base: AuditEntryView, onClose = vi.fn()) {
  detail(base);
  return renderWithQuery(<AuditEntryDialog entry={base} onClose={onClose} />);
}

afterEach(() => {
  api.getAuditEntry.mockReset();
  api.undoAuditEntry.mockReset();
});

describe('the undo dialog (AC-14, AC-18)', () => {
  it('offers Undo only when the entry can be undone', async () => {
    open(entry({ canUndo: false }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(api.getAuditEntry).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Undo this action' })).toBeNull();
  });

  it('asks for a typed reason in the same dialog, and refuses a blank one', async () => {
    open(entry());
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this action' }));
    const confirm = await screen.findByRole('dialog', { name: /Undo SKU archived\?/ });
    const reason = within(confirm).getByLabelText(/Reason/);
    expect(reason).toHaveAttribute('maxlength', '500');
    await userEvent.type(reason, '   ');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    expect(await within(confirm).findByText('Give a reason to undo this action.')).toBeVisible();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(api.undoAuditEntry).not.toHaveBeenCalled();
  });

  it('offers a select of the action reason codes instead of free text', async () => {
    open(entry({ action: 'coded.done' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this action' }));
    const confirm = await screen.findByRole('dialog', { name: /Undo/ });
    const select = within(confirm).getByRole('combobox', { name: /Reason/ });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a reason', 'customer_asked', 'entered_twice']);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    expect(await within(confirm).findByText('Choose one of the listed reasons.')).toBeVisible();

    api.undoAuditEntry.mockResolvedValue(entry({ action: 'coded.done_undone' }));
    await userEvent.selectOptions(select, 'entered_twice');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoAuditEntry).toHaveBeenCalledWith(uuid(1), 'entered_twice'));
  });

  it('sends the trimmed reason, marks the entry undone, and moves focus to the notice', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    api.getAuditEntry.mockResolvedValue({ ...entry(), changes: [] });
    api.undoAuditEntry.mockResolvedValue(entry({ action: 'thing.done_undone', canUndo: false }));
    render(
      <QueryClientProvider client={client}>
        <AuditEntryDialog entry={entry()} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this action' }));
    const confirm = await screen.findByRole('dialog', { name: /Undo/ });
    await userEvent.type(within(confirm).getByLabelText(/Reason/), '  Entered twice  ');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(api.undoAuditEntry).toHaveBeenCalledWith(uuid(1), 'Entered twice'));
    const notice = await screen.findByText('This action was undone.');
    await waitFor(() => expect(notice).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Undo this action' })).toBeNull();
    expect(screen.getByText('Undone')).toBeVisible();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['audit'] }));
  });

  it('gives focus back to the Undo button on Cancel and on Escape', async () => {
    open(entry());
    const trigger = await screen.findByRole('button', { name: 'Undo this action' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await screen.findByRole('dialog', { name: /Undo/ });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  const MESSAGES: [string, number, string][] = [
    ['ENTRY_NOT_FOUND', 404, 'This entry no longer exists.'],
    ['NOT_UNDOABLE', 409, 'This action cannot be undone.'],
    ['ALREADY_UNDONE', 409, 'This action was already undone.'],
    ['FORBIDDEN', 403, 'Only a manager can undo an action.'],
    ['INVALID_INPUT', 400, 'The undo request was not valid. Check the reason and try again.'],
    ['REASON_REQUIRED', 422, 'Give a reason to undo this action.'],
    ['REASON_TOO_LONG', 422, 'The reason is more than 500 characters.'],
    ['REASON_INVALID', 422, 'Choose one of the listed reasons.'],
    ['SOMETHING_ELSE', 500, 'The undo failed. Try again.'],
  ];
  it.each(MESSAGES)('shows %s from its code', async (code, status, message) => {
    open(entry());
    api.undoAuditEntry.mockRejectedValue(new AuditUndoError(status, code, null));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this action' }));
    const confirm = await screen.findByRole('dialog', { name: /Undo/ });
    await userEvent.type(within(confirm).getByLabelText(/Reason/), 'Because');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    expect(await within(confirm).findByText(message)).toBeVisible();
  });

  it('shows UNDO_NOT_POSSIBLE with the owner code', async () => {
    open(entry());
    api.undoAuditEntry.mockRejectedValue(
      new AuditUndoError(409, 'UNDO_NOT_POSSIBLE', 'MERGE_NOT_LATEST'),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this action' }));
    const confirm = await screen.findByRole('dialog', { name: /Undo/ });
    await userEvent.type(within(confirm).getByLabelText(/Reason/), 'Because');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'A later change got in the way, so this cannot be undone. Nothing was changed.',
    );
    expect(within(confirm).getByRole('alert')).toHaveTextContent('Reference: MERGE_NOT_LATEST');
  });

  it('shows a network failure as the generic message', async () => {
    open(entry());
    api.undoAuditEntry.mockRejectedValue(new ApiError(0, { code: 'generic' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this action' }));
    const confirm = await screen.findByRole('dialog', { name: /Undo/ });
    await userEvent.type(within(confirm).getByLabelText(/Reason/), 'Because');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    expect(await within(confirm).findByText('The undo failed. Try again.')).toBeVisible();
  });
});

describe('undone entries and diff kinds (AC-12, M3R12)', () => {
  it('marks an undone row and names the undone action beside the shared label', () => {
    renderWithQuery(
      <AuditEntriesTable
        loading={false}
        rows={[
          entry({ id: uuid(2), action: 'thing.done_undone', canUndo: false }),
          entry({ id: uuid(3), undone: true, canUndo: false }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Earlier action undone')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('SKU archived')).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText('Undone')).toBeVisible();
  });

  it('says none for an absent side, empty for a stored null, and keeps personal hidden', async () => {
    const base = entry({ canUndo: false });
    api.getAuditEntry.mockResolvedValue({
      ...base,
      changes: [
        { field: 'created', kind: 'added', before: null, after: 'yes', personal: false },
        { field: 'gone', kind: 'removed', before: 'old', after: null, personal: false },
        { field: 'note', kind: 'changed', before: null, after: 'new', personal: false },
        { field: 'phone', kind: 'added', before: null, after: '[REDACTED]', personal: true },
      ],
    });
    renderWithQuery(<AuditEntryDialog entry={base} onClose={vi.fn()} />);
    const diff = await screen.findByRole('table', { name: 'Changed fields' });
    const row = (name: string) => within(diff).getByRole('row', { name: new RegExp(name) });
    expect(within(row('created')).getAllByRole('cell')[0]).toHaveTextContent('None');
    expect(within(row('gone')).getAllByRole('cell')[1]).toHaveTextContent('None');
    expect(within(row('note')).getAllByRole('cell')[0]).toHaveTextContent('Empty');
    expect(within(row('phone')).getAllByRole('cell')[1]).toHaveTextContent('Hidden, personal data');
  });
});
