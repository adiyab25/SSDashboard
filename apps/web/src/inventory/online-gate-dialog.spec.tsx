import type { LocationDetail, OnlineGateView } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { OnlineGateDialog } from './online-gate-dialog';

const api = vi.hoisted(() => ({
  getOnlineGate: vi.fn(),
  confirmLocationStock: vi.fn(),
  makeLocationOnline: vi.fn(),
  runGateAction: vi.fn(),
}));
vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

// The fixture names no owner type value (spec 0002 AC-29 boundary): any text stands for one.
const OWNER = 'fixture_owner';

const location: LocationDetail = {
  id: '50000000-0000-4000-8000-000000000002',
  code: 'WH2',
  name: { en: 'Second warehouse' },
  kind: 'warehouse',
  ownerType: OWNER as LocationDetail['ownerType'],
  sellableOnline: false,
  archived: false,
  updatedAt: '2026-11-03T10:00:00.654321Z',
  codeLocked: false,
  online: false,
  stockVerifiedAt: null,
};

const MOVE = 'Make this the online location';
const COUNTED = 'Stock is confirmed counted at this location';

const counted = (passed: boolean) => ({
  key: 'stock_counted',
  label: 'inventory.onlineGate.checks.stockCounted',
  passed,
  count: passed ? 1 : 0,
});

const gate = (overrides: Partial<OnlineGateView> = {}): OnlineGateView => ({
  canGoOnline: true,
  checks: [counted(true)],
  variantsWithStock: 12,
  totalOnHand: 340,
  variantsPushedZero: 3,
  reservationsAtOldLocation: 0,
  currentOnlineLocation: null,
  ...overrides,
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

const open = async () => {
  const onClose = vi.fn();
  renderWithQuery(<OnlineGateDialog location={location} onClose={onClose} />);
  return { onClose, dialog: await screen.findByRole('dialog') };
};

describe('OnlineGateDialog (spec 0011 AC-19)', () => {
  it('lists each check with its state and count, and the counts to confirm', async () => {
    api.getOnlineGate.mockResolvedValue(
      gate({
        reservationsAtOldLocation: 4,
        currentOnlineLocation: {
          id: '50000000-0000-4000-8000-000000000001',
          code: 'MAIN',
          name: { en: 'Main warehouse' },
        },
      }),
    );
    const { dialog } = await open();

    expect(await within(dialog).findByText(COUNTED)).toBeVisible();
    expect(within(dialog).getByText('Passed')).toBeVisible();
    expect(within(dialog).getByText('Looked at: 1')).toBeVisible();
    expect(within(dialog).getByText('Variants with stock here').nextSibling).toHaveTextContent(
      '12',
    );
    expect(within(dialog).getByText('Total on hand').nextSibling).toHaveTextContent('340');
    expect(
      within(dialog).getByText('Variants Shopify will show as 0').nextSibling,
    ).toHaveTextContent('3');
    expect(
      within(dialog).getByText('Active reservations that stay at MAIN').nextSibling,
    ).toHaveTextContent('4');
    expect(within(dialog).getByText(/Main warehouse/)).toBeVisible();
  });

  it('confirms the stock counted, then reads the gate again', async () => {
    api.getOnlineGate
      .mockResolvedValueOnce(gate({ checks: [counted(false)] }))
      .mockResolvedValue(gate());
    api.confirmLocationStock.mockResolvedValue({
      ...location,
      stockVerifiedAt: '2026-11-08T10:00:00Z',
    });
    const { dialog } = await open();

    expect(await within(dialog).findByText('Not passed')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: MOVE })).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: "Confirm this location's stock is counted" }),
    );

    await waitFor(() => expect(api.confirmLocationStock).toHaveBeenCalledWith(location.id));
    expect(await within(dialog).findByText('Passed')).toBeVisible();
    expect(api.getOnlineGate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByRole('button', { name: MOVE })).toBeEnabled();
  });

  it('runs the action of a failed check as a button, then reads the gate again', async () => {
    const failed = {
      key: 'orders_held',
      label: 'inventory.onlineGate.stop',
      passed: false,
      count: 5,
      action: {
        method: 'POST' as const,
        path: '/api/orders/hold-open-orders',
        label: 'inventory.onlineGate.actionFailed',
      },
    };
    api.getOnlineGate
      .mockResolvedValueOnce(gate({ checks: [counted(true), failed] }))
      .mockResolvedValue(gate({ checks: [counted(true), { ...failed, passed: true, count: 0 }] }));
    api.runGateAction.mockResolvedValue(undefined);
    const { dialog } = await open();

    // The fixture borrows existing message keys: the label is the one the api names.
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'That fix did not work. Try again.' }),
    );

    await waitFor(() => expect(api.runGateAction).toHaveBeenCalled());
    expect(api.runGateAction.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/api/orders/hold-open-orders',
    });
    await waitFor(() => expect(api.getOnlineGate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryByText('Not passed')).toBeNull());
  });

  it('needs a written reason, then sends the variant count it showed', async () => {
    api.getOnlineGate.mockResolvedValue(gate());
    api.makeLocationOnline.mockResolvedValue({ ...location, online: true });
    const { dialog, onClose } = await open();

    expect(await within(dialog).findByText(/Describe the stock, not a person/)).toBeVisible();
    const submit = within(dialog).getByRole('button', { name: MOVE });
    await userEvent.click(submit);
    expect(await within(dialog).findByText('Give a reason, up to 500 characters.')).toBeVisible();
    expect(api.makeLocationOnline).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Counted on Friday');
    await userEvent.click(submit);
    await waitFor(() =>
      expect(api.makeLocationOnline).toHaveBeenCalledWith(location.id, {
        confirmedVariantCount: 12,
        reason: 'Counted on Friday',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('reads the gate again and says so when the numbers went stale', async () => {
    api.getOnlineGate
      .mockResolvedValueOnce(gate())
      .mockResolvedValue(gate({ variantsWithStock: 15 }));
    api.makeLocationOnline.mockRejectedValue(new ApiError(409, { code: 'ONLINE_GATE_STALE' }));
    const { dialog, onClose } = await open();

    await userEvent.type(await within(dialog).findByLabelText(/Reason/), 'Counted');
    await userEvent.click(within(dialog).getByRole('button', { name: MOVE }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /stock changed while this was open/,
    );
    await waitFor(() =>
      expect(within(dialog).getByText('Variants with stock here').nextSibling).toHaveTextContent(
        '15',
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reads the gate again and says so when the location is already online', async () => {
    api.getOnlineGate.mockResolvedValue(gate());
    api.makeLocationOnline.mockRejectedValue(new ApiError(409, { code: 'ALREADY_ONLINE' }));
    const { dialog } = await open();

    await userEvent.type(await within(dialog).findByLabelText(/Reason/), 'Counted');
    await userEvent.click(within(dialog).getByRole('button', { name: MOVE }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This location already feeds online stock.',
    );
    await waitFor(() => expect(api.getOnlineGate.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/x',
    '/api/orders?x=1',
    '/orders/hold',
    '/api/../x',
  ])('draws no action for the path %s: only a plain api route runs', async (path) => {
    api.getOnlineGate.mockResolvedValue(
      gate({
        checks: [
          counted(true),
          {
            key: 'orders_held',
            label: 'inventory.onlineGate.checks.stockCounted',
            passed: false,
            count: 2,
            action: { method: 'POST', path, label: 'inventory.onlineGate.stop' },
          },
        ],
      }),
    );
    const { dialog } = await open();

    expect(await within(dialog).findByText('Not passed')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Stop online stock' })).toBeNull();
    expect(within(dialog).queryByRole('link')).toBeNull();
  });

  it('offers Confirm stock counted while that check fails, and does not call it "cannot feed online stock"', async () => {
    // The api reports canGoOnline false while any check fails, so a failed check is not ineligibility.
    api.getOnlineGate.mockResolvedValue(gate({ canGoOnline: false, checks: [counted(false)] }));
    const { dialog } = await open();

    expect(
      await within(dialog).findByRole('button', {
        name: "Confirm this location's stock is counted",
      }),
    ).toBeVisible();
    expect(within(dialog).queryByText(/cannot feed online stock/)).toBeNull();
    expect(within(dialog).getByText('Pass every check above to continue.')).toBeVisible();
  });

  it('says a location that cannot go online cannot, and blocks the move', async () => {
    api.getOnlineGate.mockResolvedValue(gate({ canGoOnline: false }));
    const { dialog } = await open();

    expect(await within(dialog).findByText(/cannot feed online stock/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: MOVE })).toBeDisabled();
  });

  it('offers Try again when the gate cannot be loaded', async () => {
    api.getOnlineGate.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    api.getOnlineGate.mockResolvedValue(gate());
    const { dialog } = await open();

    expect(await within(dialog).findByText('The online gate could not be loaded.')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: /try again|retry/i }));
    expect(await within(dialog).findByText('Passed')).toBeVisible();
  });
});
