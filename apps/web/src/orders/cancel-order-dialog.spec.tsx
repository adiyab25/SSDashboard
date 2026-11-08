import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { CancelOrderDialog } from './cancel-order-dialog';
import { orderDetailOf } from './order-detail-fixture';

const api = vi.hoisted(() => ({ cancelOrder: vi.fn(), listOrders: vi.fn() }));
vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const TARGET = '00000000-0000-4000-8000-000000000009';

const handlers = () => ({
  onClose: vi.fn(),
  onCancelled: vi.fn(),
  onInShopify: vi.fn(),
  onStale: vi.fn(),
  onOutOfDate: vi.fn(),
  onRestoreFocus: vi.fn(),
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe('CancelOrderDialog (AC-7, AC-20)', () => {
  it('needs a reason, then cancels with the updatedAt the page showed', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf();
    const on = handlers();
    api.cancelOrder.mockResolvedValue({ ...order, fulfillmentState: 'cancelled' });
    renderWithQuery(<CancelOrderDialog order={order} {...on} />);
    const dialog = await screen.findByRole('dialog', { name: 'Cancel order ⁦ESS/#1001⁩' });

    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByText('Choose why this order is cancelled.')).toBeVisible();
    expect(api.cancelOrder).not.toHaveBeenCalled();

    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'no_answer');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() => expect(on.onCancelled).toHaveBeenCalled());
    expect(api.cancelOrder).toHaveBeenCalledWith(order.id, {
      expectedUpdatedAt: order.updatedAt,
      reasonCode: 'no_answer',
    });
  });

  it('asks for the order a duplicate duplicates, found by the order search', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf();
    api.cancelOrder.mockResolvedValue(order);
    api.listOrders.mockResolvedValue({
      items: [
        {
          id: TARGET,
          storeCode: 'ESS',
          orderNumber: '#0999',
          placedAt: '2026-11-03T10:00:00.000Z',
          shipToName: 'Mona Adel',
          channelId: '10000000-0000-4000-8000-000000000001',
          channelName: { en: 'WhatsApp' },
          totalAmount: '500.00',
          codDueAmount: '500.00',
          fulfillmentState: 'confirmed',
          cashState: 'unpaid',
          outcome: 'open',
          type: 'sale',
          giftReasonCode: null,
          hold: false,
          short: false,
          reopened: false,
          phoneNeedsFix: false,
        },
      ],
      nextCursor: null,
    });
    renderWithQuery(<CancelOrderDialog order={order} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByLabelText(/The order it duplicates/)).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByText('Choose the order this one duplicates.')).toBeVisible();
    expect(api.cancelOrder).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('combobox', { name: /The order it duplicates/ }));
    await user.type(screen.getByPlaceholderText('Phone or order number'), '0999');
    await user.click(await screen.findByRole('option', { name: /ESS\/#0999/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() => expect(api.cancelOrder).toHaveBeenCalled());
    expect(api.cancelOrder.mock.calls[0]?.[1]).toEqual({
      expectedUpdatedAt: order.updatedAt,
      reasonCode: 'duplicate',
      duplicateOfOrderId: TARGET,
    });
  });

  it('shows an api refusal under the target field and keeps the dialog open', async () => {
    const user = userEvent.setup();
    api.cancelOrder.mockRejectedValue(new ApiError(422, { code: 'DUPLICATE_TARGET_REQUIRED' }));
    api.listOrders.mockResolvedValue({
      items: [
        {
          id: TARGET,
          storeCode: 'ESS',
          orderNumber: '#0999',
          placedAt: '2026-11-03T10:00:00.000Z',
          shipToName: null,
          channelId: '10000000-0000-4000-8000-000000000001',
          channelName: { en: 'WhatsApp' },
          totalAmount: '500.00',
          codDueAmount: '500.00',
          fulfillmentState: 'confirmed',
          cashState: 'unpaid',
          outcome: 'open',
          type: 'sale',
          giftReasonCode: null,
          hold: false,
          short: false,
          reopened: false,
          phoneNeedsFix: false,
        },
      ],
      nextCursor: null,
    });
    renderWithQuery(<CancelOrderDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'duplicate');
    await user.click(within(dialog).getByRole('combobox', { name: /The order it duplicates/ }));
    await user.type(screen.getByPlaceholderText('Phone or order number'), '0999');
    await user.click(await screen.findByRole('option', { name: /ESS\/#0999/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    const problem = await within(dialog).findByText(
      /Choose the order this one duplicates\. It must/,
    );
    expect(problem).toBeVisible();
    expect(
      within(dialog).getByRole('combobox', { name: /The order it duplicates/ }),
    ).toHaveAttribute('aria-invalid', 'true');
  });

  it('hands a stale order and a Shopify order back to the page', async () => {
    const user = userEvent.setup();
    const on = handlers();
    api.cancelOrder.mockRejectedValueOnce(new ApiError(409, { code: 'ORDER_STALE' }));
    api.cancelOrder.mockRejectedValueOnce(new ApiError(409, { code: 'CANCEL_IN_SHOPIFY' }));
    renderWithQuery(<CancelOrderDialog order={orderDetailOf()} {...on} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'fake');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(on.onStale).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(on.onInShopify).toHaveBeenCalledTimes(1));
  });

  it('says a cancel after pickup is refused and closes with Keep the order', async () => {
    const user = userEvent.setup();
    const on = handlers();
    api.cancelOrder.mockRejectedValue(new ApiError(409, { code: 'INVALID_TRANSITION' }));
    renderWithQuery(<CancelOrderDialog order={orderDetailOf()} {...on} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'fake');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no longer in a state');
    expect(on.onOutOfDate).toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Keep the order' }));
    expect(on.onClose).toHaveBeenCalled();
  });

  it('keeps the order it opened on: a refetch behind it does not give old values a fresh token', async () => {
    const user = userEvent.setup();
    const opened = orderDetailOf();
    api.cancelOrder.mockResolvedValue(opened);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { rerender } = render(<CancelOrderDialog order={opened} {...handlers()} />, { wrapper });
    const dialog = await screen.findByRole('dialog');
    rerender(
      <CancelOrderDialog
        order={{ ...opened, updatedAt: '2026-11-03T12:00:00.654321Z' }}
        {...handlers()}
      />,
    );
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'fake');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(api.cancelOrder).toHaveBeenCalled());
    expect(api.cancelOrder.mock.calls[0]?.[1]).toMatchObject({
      expectedUpdatedAt: opened.updatedAt,
    });
  });

  it('never offers the order itself as the order it duplicates', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf();
    api.listOrders.mockResolvedValue({
      items: [
        {
          id: order.id,
          storeCode: 'ESS',
          orderNumber: '#1001',
          placedAt: '2026-11-03T10:00:00.000Z',
          shipToName: null,
          channelId: order.channelId,
          channelName: { en: 'WhatsApp' },
          totalAmount: '550.00',
          codDueAmount: '550.00',
          fulfillmentState: 'confirmed',
          cashState: 'unpaid',
          outcome: 'open',
          type: 'sale',
          giftReasonCode: null,
          hold: false,
          short: false,
          reopened: false,
          phoneNeedsFix: false,
        },
      ],
      nextCursor: null,
    });
    renderWithQuery(<CancelOrderDialog order={order} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'duplicate');
    await user.click(within(dialog).getByRole('combobox', { name: /The order it duplicates/ }));
    await user.type(screen.getByPlaceholderText('Phone or order number'), '1001');
    expect(await screen.findByText('No orders found')).toBeVisible();
    expect(screen.queryByRole('option', { name: /ESS\/#1001/ })).toBeNull();
  });
});
