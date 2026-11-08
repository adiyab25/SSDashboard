import type { CostRulesResponse } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CostRulesView } from './cost-rules-view';

const api = vi.hoisted(() => ({ listCostRules: vi.fn(), recordCostRule: vi.fn() }));
vi.mock('./cost-rules-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const codRow = {
  id: '00000000-0000-4000-8000-0000000000d1',
  kind: 'cod_fee_percent' as const,
  status: 'set' as const,
  value: '2.5000',
  effectiveFrom: '2026-10-01',
  recordedAt: '2026-10-01T08:00:00.000000Z',
  recordedBy: { id: '00000000-0000-4000-8000-000000000001', name: 'Nour Admin' },
};
const packagingRow = {
  id: '00000000-0000-4000-8000-0000000000d2',
  kind: 'packaging_per_order' as const,
  status: 'set' as const,
  value: '12.5000',
  effectiveFrom: '2026-01-01',
  recordedAt: '2026-01-01T08:00:00.000000Z',
  recordedBy: null,
};

const answer = (overrides: Partial<CostRulesResponse> = {}): CostRulesResponse => ({
  today: '2026-11-08',
  current: [
    { kind: 'cod_fee_percent', rule: { status: 'set', value: '2.5000' }, row: codRow },
    { kind: 'gateway_fee_percent', rule: { status: 'not_set' }, row: null },
    { kind: 'packaging_per_order', rule: { status: 'set', value: '12.5000' }, row: packagingRow },
    { kind: 'rto_unrestocked_percent', rule: { status: 'not_set' }, row: null },
  ],
  history: { items: [codRow, packagingRow], nextCursor: null },
  lockDate: '2026-09-30',
  lockDateInvalid: false,
  ...overrides,
});

afterEach(() => {
  api.listCostRules.mockReset();
  api.recordCostRule.mockReset();
});

async function openAdd(name: string) {
  api.listCostRules.mockResolvedValue(answer());
  renderWithQuery(<CostRulesView enabled canAdd />);
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.getByRole('dialog');
}

describe('CostRulesView (spec 0009, AC-23, AC-25)', () => {
  it('shows the rule in force for each kind, never 0 for one not set, and the history', async () => {
    api.listCostRules.mockResolvedValue(answer());
    renderWithQuery(<CostRulesView enabled canAdd />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const current = await screen.findByRole('table', { name: 'Cost rules in force today' });
    const cod = within(current).getByRole('row', { name: /Cash on delivery fee/ });
    expect(cod).toHaveTextContent('2.5%');
    expect(cod).toHaveTextContent('Nour Admin');
    const gateway = within(current).getByRole('row', { name: /Payment gateway fee/ });
    expect(gateway).toHaveTextContent('Not set');
    expect(gateway).toHaveTextContent('No rule recorded yet');
    expect(within(current).getByRole('row', { name: /Packaging per order/ })).toHaveTextContent(
      'Set when the app was installed',
    );
    const history = screen.getByRole('table', { name: 'Every recorded cost rule, newest first' });
    expect(within(history).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText(/Days up to .* are locked/)).toBeVisible();
  });

  it('shows the prompt that nothing is locked yet, and the alert for an unreadable lock date', async () => {
    api.listCostRules.mockResolvedValueOnce(answer({ lockDate: null }));
    const first = renderWithQuery(<CostRulesView enabled canAdd />);
    expect(
      await screen.findByText('Nothing is locked yet, so a rule can start on any day.'),
    ).toBeVisible();
    first.unmount();

    api.listCostRules.mockResolvedValueOnce(answer({ lockDate: null, lockDateInvalid: true }));
    renderWithQuery(<CostRulesView enabled canAdd />);
    expect(await screen.findByText(/holds a value that is not valid/)).toBeVisible();
  });

  it('gives a cost.view only reader no New rule action, and says who can add', async () => {
    api.listCostRules.mockResolvedValue(answer());
    renderWithQuery(<CostRulesView enabled canAdd={false} />);
    await screen.findByRole('table', { name: 'Cost rules in force today' });
    expect(screen.queryByRole('button', { name: /New rule/ })).toBeNull();
    expect(screen.getByText(/Only a person who manages settings/)).toBeVisible();
  });

  it('shows an empty history in words, more pages on demand, an error with retry, and no access on 403', async () => {
    api.listCostRules.mockResolvedValueOnce(answer({ history: { items: [], nextCursor: null } }));
    const first = renderWithQuery(<CostRulesView enabled canAdd />);
    expect(await screen.findByText('No rule has been recorded yet.')).toBeVisible();
    first.unmount();

    api.listCostRules
      .mockResolvedValueOnce(answer({ history: { items: [codRow], nextCursor: 'next' } }))
      .mockResolvedValueOnce(answer({ history: { items: [packagingRow], nextCursor: null } }));
    const second = renderWithQuery(<CostRulesView enabled canAdd />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(api.listCostRules).toHaveBeenLastCalledWith('next', expect.anything()),
    );
    second.unmount();

    api.listCostRules.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    const third = renderWithQuery(<CostRulesView enabled canAdd />);
    expect(await screen.findByText(/could not be loaded/)).toBeVisible();
    api.listCostRules.mockResolvedValue(answer());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Cost rules in force today' })).toBeVisible();
    third.unmount();

    api.listCostRules.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' }));
    renderWithQuery(<CostRulesView enabled canAdd />);
    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
  });

  it('asks for nothing before access is known', () => {
    renderWithQuery(<CostRulesView enabled={false} canAdd={false} />);
    expect(api.listCostRules).not.toHaveBeenCalled();
  });
});

describe('recording a rule (AC-23, D14)', () => {
  it('checks the value and reason first, then sends the rule with Arabic digits read', async () => {
    api.recordCostRule.mockResolvedValue(codRow);
    const dialog = await openAdd('New rule for Cash on delivery fee');
    await userEvent.type(within(dialog).getByLabelText(/^Percent/), '120');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    expect(await within(dialog).findByText('A percent cannot be more than 100.')).toBeVisible();
    expect(within(dialog).getByLabelText(/^Percent/)).toHaveFocus();
    expect(api.recordCostRule).not.toHaveBeenCalled();

    await userEvent.clear(within(dialog).getByLabelText(/^Percent/));
    await userEvent.type(within(dialog).getByLabelText(/^Percent/), '٢٫٧٥');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    expect(await within(dialog).findByText('Say why you are making this change.')).toBeVisible();

    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'New Bosta contract');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    await waitFor(() =>
      expect(api.recordCostRule).toHaveBeenCalledWith({
        kind: 'cod_fee_percent',
        status: 'set',
        value: '2.75',
        effectiveFrom: '2026-11-08',
        reason: 'New Bosta contract',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends a not set rule without a value', async () => {
    api.recordCostRule.mockResolvedValue(codRow);
    const dialog = await openAdd('New rule for Packaging per order');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Not set/ }));
    expect(within(dialog).queryByLabelText(/^Amount per order/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Unknown for now');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    await waitFor(() =>
      expect(api.recordCostRule).toHaveBeenCalledWith({
        kind: 'packaging_per_order',
        status: 'not_set',
        effectiveFrom: '2026-11-08',
        reason: 'Unknown for now',
      }),
    );
  });

  it('names the locked months and records in the locked period on purpose on the next save', async () => {
    api.recordCostRule
      .mockRejectedValueOnce(
        new ApiError(409, { code: 'COST_RULE_IN_LOCKED_PERIOD', months: ['2026-08', '2026-09'] }),
      )
      .mockResolvedValueOnce(codRow);
    const dialog = await openAdd('New rule for Cash on delivery fee');
    await userEvent.type(within(dialog).getByLabelText(/^Percent/), '3');
    await userEvent.clear(within(dialog).getByLabelText(/^Applies from/));
    await userEvent.type(within(dialog).getByLabelText(/^Applies from/), '2026-08-15');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Fee was wrong in August');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('This start day is in a locked period');
    expect(alert).toHaveTextContent('2026-08');
    expect(alert).toHaveTextContent('2026-09');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Record in the locked period' }),
    );
    await waitFor(() =>
      expect(api.recordCostRule).toHaveBeenLastCalledWith({
        kind: 'cod_fee_percent',
        status: 'set',
        value: '3',
        effectiveFrom: '2026-08-15',
        reason: 'Fee was wrong in August',
        inLockedPeriod: true,
      }),
    );
  });

  it('words an unreadable lock date and a refused value from their codes', async () => {
    api.recordCostRule.mockRejectedValueOnce(new ApiError(409, { code: 'LOCK_DATE_UNREADABLE' }));
    const dialog = await openAdd('New rule for Cash on delivery fee');
    await userEvent.type(within(dialog).getByLabelText(/^Percent/), '3');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not valid/);

    api.recordCostRule.mockRejectedValueOnce(
      new ApiError(422, { code: 'SETTING_INVALID', issues: [{ path: 'value', message: 'x' }] }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    expect(await within(dialog).findByText(/This rule is not allowed/)).toBeVisible();
    expect(within(dialog).getByLabelText(/^Percent/)).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('review follow ups (AC-23)', () => {
  it('shows a percent stored with a third or fourth decimal unrounded', async () => {
    api.listCostRules.mockResolvedValue(
      answer({
        current: [
          {
            kind: 'cod_fee_percent',
            rule: { status: 'set', value: '2.7525' },
            row: { ...codRow, value: '2.7525' },
          },
        ],
        history: { items: [], nextCursor: null },
      }),
    );
    renderWithQuery(<CostRulesView enabled canAdd />);
    const current = await screen.findByRole('table', { name: 'Cost rules in force today' });
    expect(within(current).getByRole('row', { name: /Cash on delivery fee/ })).toHaveTextContent(
      '2.7525%',
    );
  });

  it('drops the locked period override when the start day changes', async () => {
    api.recordCostRule.mockRejectedValue(
      new ApiError(409, { code: 'COST_RULE_IN_LOCKED_PERIOD', months: ['2026-08'] }),
    );
    const dialog = await openAdd('New rule for Cash on delivery fee');
    await userEvent.type(within(dialog).getByLabelText(/^Percent/), '3');
    await userEvent.clear(within(dialog).getByLabelText(/^Applies from/));
    await userEvent.type(within(dialog).getByLabelText(/^Applies from/), '2026-08-15');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Fix');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    expect(
      await within(dialog).findByRole('button', { name: 'Record in the locked period' }),
    ).toBeVisible();

    await userEvent.clear(within(dialog).getByLabelText(/^Applies from/));
    await userEvent.type(within(dialog).getByLabelText(/^Applies from/), '2026-11-08');
    expect(
      within(dialog).queryByRole('button', { name: 'Record in the locked period' }),
    ).toBeNull();
    expect(within(dialog).queryByText('This start day is in a locked period')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Record rule' })).toBeVisible();
  });

  it('puts a refusal of a not set rule above the form, not on the hidden value field', async () => {
    api.recordCostRule.mockRejectedValue(
      new ApiError(422, { code: 'SETTING_INVALID', issues: [{ path: 'status', message: 'x' }] }),
    );
    const dialog = await openAdd('New rule for Packaging per order');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Not set/ }));
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Unknown');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/This rule is not allowed/);
  });
});

describe('in Arabic', () => {
  it('reads the page and the kinds', async () => {
    api.listCostRules.mockResolvedValue(answer());
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <CostRulesView enabled canAdd />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'قواعد التكلفة' })).toBeVisible();
    expect((await screen.findAllByText('رسوم الدفع عند الاستلام')).length).toBe(2);
    expect(screen.getAllByText('غير محددة').length).toBeGreaterThan(0);
  });
});
