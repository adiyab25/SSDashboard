import type { OrderDetail } from '@ssdashboard/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { orderDetailOf } from './order-detail-fixture';
import { OrderActions } from './order-actions';
import { orderKeys } from './orders-api';

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

describe('Pack after the stock out is requested (spec 0013, owner ruling)', () => {
  const stockOut = (source: 'shopify_fulfillment' | null, requestedAt: string | null) => ({
    generation: 1,
    source,
    requestedAt,
    postedAt: null,
    reversals: [],
  });

  it('offers Pack before a stock out and hides it once one is requested', () => {
    me.current = { id: 'me', hats: ['x'], permissions: ['orders.confirm', 'fulfillment.work'] };
    const { unmount } = renderWithQuery(
      <OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />,
    );
    expect(buttons()).toContain('Pack');
    unmount();
    renderWithQuery(
      <OrderActions
        order={orderDetailOf({
          fulfillmentState: 'confirmed',
          stockOut: stockOut('shopify_fulfillment', '2026-11-18T12:05:00.000Z'),
        })}
      />,
    );
    expect(buttons()).not.toContain('Pack');
  });

  it('still offers Confirm on a new order whose stock out is requested', () => {
    renderWithQuery(
      <OrderActions
        order={orderDetailOf({
          fulfillmentState: 'new',
          stockOut: stockOut('shopify_fulfillment', '2026-11-18T12:05:00.000Z'),
        })}
      />,
    );
    expect(buttons()).toContain('Confirm');
  });

  it('says so when the api answers 409 STOCK_ALREADY_LEFT to a stale Pack', async () => {
    me.current = PACKER;
    api.moveOrder.mockRejectedValue(new ApiError(409, { code: 'STOCK_ALREADY_LEFT' }));
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The stock of this order has already been sent out, so it cannot be packed.',
    );
  });
});

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

  it('says a pack is refused while a line is short of stock (AC-7, Q-16.5)', async () => {
    me.current = PACKER;
    const user = userEvent.setup();
    api.moveOrder.mockRejectedValue(new ApiError(409, { code: 'LINE_SHORT' }));
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />);

    await user.click(screen.getByRole('button', { name: 'Pack' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A line is short of stock, so the order cannot be packed yet.',
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pack' })).toBeEnabled();
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

  it('says the Shopify cancel note in place of Cancel order, keeping Edit', async () => {
    const user = userEvent.setup();
    api.cancelOrder.mockRejectedValue(new ApiError(409, { code: 'CANCEL_IN_SHOPIFY' }));
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'confirmed' })} />);

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'fake');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/Cancel it in Shopify/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit order' })).toBeVisible();
  });

  it('keeps the edit token of the order the dialog opened on when a newer copy arrives', async () => {
    const user = userEvent.setup();
    const opened = orderDetailOf({ fulfillmentState: 'confirmed' });
    api.editOrder.mockResolvedValue(opened);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { rerender } = render(<OrderActions order={opened} />, { wrapper });

    await user.click(screen.getByRole('button', { name: 'Edit order' }));
    const dialog = await screen.findByRole('dialog');
    rerender(<OrderActions order={{ ...opened, updatedAt: '2026-11-03T12:00:00.654321Z' }} />);
    await user.type(within(dialog).getByLabelText('Second phone'), '01111111111');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.editOrder).toHaveBeenCalled());
    expect(api.editOrder.mock.calls[0]?.[1]).toMatchObject({ expectedUpdatedAt: opened.updatedAt });
  });

  it('disables Edit and Cancel while a move is on its way', async () => {
    const user = userEvent.setup();
    api.moveOrder.mockReturnValue(new Promise(() => undefined));
    renderWithQuery(<OrderActions order={orderDetailOf({ fulfillmentState: 'new' })} />);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: 'Edit order' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeDisabled();
  });

  it('clears an earlier failure after a later success', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf({ fulfillmentState: 'new' });
    api.moveOrder.mockRejectedValueOnce(new ApiError(503, { code: 'BUSY' }));
    api.moveOrder.mockResolvedValueOnce({ ...order, fulfillmentState: 'confirmed' });
    renderWithQuery(<OrderActions order={order} />);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('system is busy');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it.each(['ORDER_LOCKED', 'INVALID_TRANSITION', 'ORDER_NOT_FOUND'])(
    'refetches the order on %s',
    async (code) => {
      const user = userEvent.setup();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const spy = vi.spyOn(client, 'invalidateQueries');
      api.moveOrder.mockRejectedValue(new ApiError(409, { code }));
      render(
        <QueryClientProvider client={client}>
          <OrderActions order={orderDetailOf({ fulfillmentState: 'new' })} />
        </QueryClientProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Confirm' }));
      await screen.findByRole('alert');
      expect(spy).toHaveBeenCalledWith({ queryKey: orderKeys.all });
    },
  );
});

/** The order page's own shape: the order from the query cache, an h1 to fall back on, and the actions. */
function Page({ initial, client }: { initial: OrderDetail; client: QueryClient }) {
  const query = useQuery({
    queryKey: orderKeys.detail(initial.id),
    queryFn: () => client.getQueryData<OrderDetail>(orderKeys.detail(initial.id)) ?? initial,
    initialData: initial,
    staleTime: Infinity,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Order page
      </h1>
      <OrderActions order={query.data} headingRef={heading} />
    </>
  );
}

describe('OrderActions focus (WCAG 2.4.3)', () => {
  function renderPage(order: OrderDetail) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Page initial={order} client={client} />
      </QueryClientProvider>,
    );
  }

  it('moves focus to an action that is left when Confirm goes away', async () => {
    me.current = { ...SUPPORT, permissions: [...SUPPORT.permissions, 'fulfillment.work'] };
    const user = userEvent.setup();
    const order = orderDetailOf({ fulfillmentState: 'new' });
    api.moveOrder.mockResolvedValue({ ...order, fulfillmentState: 'confirmed' });
    renderPage(order);

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('button', { name: 'Pack' });
    await waitFor(() => expect(document.body).not.toHaveFocus());
    const region = screen.getByRole('region', { name: 'Order actions' });
    expect(region).toContainElement(document.activeElement as HTMLElement);
  });

  it('moves focus to the page heading when a cancel leaves no action', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf({ fulfillmentState: 'confirmed' });
    api.cancelOrder.mockResolvedValue({
      ...order,
      fulfillmentState: 'cancelled',
      outcome: 'cancelled_before_shipping',
    });
    renderPage(order);

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Why/), 'fake');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Order page' })).toHaveFocus(),
    );
  });

  it('keeps focus on an action when the Shopify note replaces the button that opened the dialog', async () => {
    const user = userEvent.setup();
    api.editOrder.mockRejectedValue(new ApiError(409, { code: 'EDIT_IN_SHOPIFY' }));
    renderPage(orderDetailOf({ fulfillmentState: 'confirmed' }));

    await user.click(screen.getByRole('button', { name: 'Edit order' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Second phone'), '01111111111');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit order' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel order' })).toHaveFocus());
  });
});
