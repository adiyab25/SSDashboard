import type { OrderDetail } from '@ssdashboard/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { orderDetailOf } from './order-detail-fixture';
import { OrderActions } from './order-actions';

const api = vi.hoisted(() => ({
  moveOrder: vi.fn(),
  editOrder: vi.fn(),
  cancelOrder: vi.fn(),
  listOrders: vi.fn(),
}));
vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: null,
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const SUPPORT = {
  id: 'me',
  hats: ['support'],
  permissions: ['orders.view', 'orders.confirm'],
};
const PACKER = { id: 'me', hats: ['packer'], permissions: ['orders.view', 'fulfillment.work'] };

beforeEach(() => {
  me.current = SUPPORT;
  api.listOrders.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  toast.success.mockReset();
  me.current = null;
});

const buttons = () => screen.queryAllByRole('button').map((button) => button.textContent);

describe('OrderActions (AC-7, AC-8, AC-20)', () => {
  it('offers Confirm, Edit, and Cancel on a new order to a holder of orders.confirm', () => {
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'new' })} />);
    expect(buttons()).toEqual(['Confirm', 'Edit order', 'Cancel order']);
  });

  it('offers Edit and Cancel but not Pack to orders.confirm alone on a confirmed order', () => {
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />);
    expect(buttons()).toEqual(['Edit order', 'Cancel order']);
  });

  it('offers only Pack to a packer on a confirmed order, and Back to confirmed once packed', () => {
    me.current = PACKER;
    const { unmount } = renderWithQuery(
      <OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />,
    );
    expect(buttons()).toEqual(['Pack']);
    unmount();
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'packed' })} />);
    expect(buttons()).toEqual(['Back to confirmed']);
  });

  it('offers nothing once the courier has the order or it is cancelled', () => {
    const { container, unmount } = renderWithQuery(
      <OrderActions order={orderDetailOf({ fulfillmentState: 'shipped' })} />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();
    const cancelled = renderWithQuery(
      <OrderActions
        order={orderDetailOf({
          fulfillmentState: 'cancelled',
          outcome: 'cancelled_before_shipping',
        })}
      />,
    );
    expect(cancelled.container).toBeEmptyDOMElement();
  });

  it('offers no edit or back to confirmed once a courier delivery exists', () => {
    me.current = { ...SUPPORT, permissions: [...SUPPORT.permissions, 'fulfillment.work'] };
    renderWithQuery(
      <OrderActions
        order={orderDetailOf({
          fulfillmentState: 'packed',
          carrierDeliveryCreatedAt: '2026-11-03T12:00:00.000Z',
        })}
      />,
    );
    expect(buttons()).toEqual(['Cancel order']);
  });

  it('confirms with the updatedAt the page showed and toasts the number with its store', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf({ fulfillmentState: 'new' });
    api.moveOrder.mockResolvedValue({ ...order, fulfillmentState: 'confirmed' });
    renderWithQuery(<OrderActions order={order} />);

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(api.moveOrder).toHaveBeenCalledWith(order.id, 'confirm', {
      expectedUpdatedAt: order.updatedAt,
    });
    expect(String(toast.success.mock.calls[0]?.[0])).toContain('ESS/#1001');
    expect(String(toast.success.mock.calls[0]?.[0])).toContain('confirmed');
  });

  it('tells the person the order changed on a stale answer and asks the api again for the page', async () => {
    const user = userEvent.setup();
    api.moveOrder.mockRejectedValue(new ApiError(409, { code: 'ORDER_STALE' }));
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'new' })} />);

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This order changed while you were');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says a pack is refused while a change has not reached the sales channel', async () => {
    me.current = PACKER;
    const user = userEvent.setup();
    api.moveOrder.mockRejectedValue(new ApiError(409, { code: 'WRITE_BACK_OPEN' }));
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />);

    await user.click(screen.getByRole('button', { name: 'Pack' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('has not reached the sales channel');
  });

  it('swaps the Edit button for a calm note when the api says the order is edited in Shopify', async () => {
    const user = userEvent.setup();
    const order: OrderDetail = orderDetailOf({ fulfillmentState: 'confirmed' });
    api.editOrder.mockRejectedValue(new ApiError(409, { code: 'EDIT_IN_SHOPIFY' }));
    renderWithQuery(<OrderActions order={order} />);

    await user.click(screen.getByRole('button', { name: 'Edit order' }));
    await screen.findByRole('dialog');
    const address = screen.getByLabelText('Address');
    await user.clear(address);
    await user.type(address, '14 Nile Street');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Edit order' })).toBeNull();
    expect(screen.getByText(/Edit it in Shopify/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeVisible();
  });
});
