import type { OrderDetail } from '@ssdashboard/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { orderDetailOf } from './order-detail-fixture';
import { OrderStockOutBlock } from './order-stock-out-block';

const api = vi.hoisted(() => ({
  restockAwaiting: vi.fn(),
  closeAwaitingRestock: vi.fn(),
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

const MANAGER = {
  id: 'me',
  hats: ['manager'],
  permissions: ['orders.view', 'stock.receive', 'stock.correct'],
};
const WAREHOUSE = { id: 'me', hats: ['warehouse'], permissions: ['orders.view', 'stock.receive'] };
const SUPPORT = { id: 'me', hats: ['support'], permissions: ['orders.view'] };

const LINE_ID = '40000000-0000-4000-8000-000000000001';

/** An order whose Shopify fulfillment took 2 pieces out and expects both back. */
const awaitingOrder = (overrides: Partial<OrderDetail> = {}): OrderDetail => {
  const base = orderDetailOf();
  const [line] = base.lines;
  if (!line) throw new Error('The fixture has no line');
  return orderDetailOf({
    stockOut: {
      generation: 2,
      source: 'shopify_fulfillment',
      requestedAt: '2026-11-18T12:05:00.000Z',
      postedAt: '2026-11-18T12:06:00.000Z',
      reversals: [
        {
          generation: 1,
          reasonCode: 'channel_fulfillment_cancelled',
          reversedAt: '2026-11-17T09:00:00.000Z',
        },
      ],
    },
    lines: [
      {
        ...line,
        stockOutQuantity: 2,
        awaitingRestockQuantity: 2,
        awaitingRestockSince: '2026-11-19T08:00:00.000Z',
      },
    ],
    ...overrides,
  });
};

beforeEach(() => {
  me.current = MANAGER;
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  toast.success.mockReset();
  me.current = null;
});

describe('OrderStockOutBlock (AC-5, AC-27 g)', () => {
  it('shows the source and time, the posting, a reversal, and the awaiting quantity of a line', () => {
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);

    const block = screen.getByRole('region', { name: 'Stock out' });
    expect(within(block).getByText(/^Left stock: Shopify fulfillment, /)).toBeVisible();
    expect(within(block).getByText(/^Booked in stock: /)).toBeVisible();
    expect(
      within(within(block).getByRole('list', { name: 'Reversals' })).getByText(
        /Shopify cancelled the fulfillment/,
      ),
    ).toBeVisible();
    const awaiting = within(block).getByRole('list', { name: 'Lines awaiting restock' });
    expect(within(awaiting).getByText('Red tee, M')).toBeVisible();
    expect(within(awaiting).getByText(/^Expected back: 2, since /)).toBeVisible();
  });

  it('says that an order has not left stock and has nothing awaiting', () => {
    renderWithQuery(<OrderStockOutBlock order={orderDetailOf()} />);
    expect(screen.getByText('This order has not left stock.')).toBeVisible();
    expect(screen.getByText('No pieces are expected back.')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws nothing for an answer with no stock out view and nothing awaiting', () => {
    const { container } = renderWithQuery(
      <OrderStockOutBlock order={orderDetailOf({ stockOut: undefined })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('hides both actions from a person with neither stock permission', () => {
    me.current = SUPPORT;
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Received on the shelf (AC-27 e)', () => {
  it('puts every awaiting piece back with one tap, one idempotency key, and a toast', async () => {
    const order = awaitingOrder();
    api.restockAwaiting.mockResolvedValue(orderDetailOf());
    renderWithQuery(<OrderStockOutBlock order={order} />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Received on the shelf: Red tee, M' }),
    );

    await waitFor(() => expect(api.restockAwaiting).toHaveBeenCalledTimes(1));
    expect(api.restockAwaiting).toHaveBeenCalledWith(
      order.id,
      LINE_ID,
      { quantity: 2 },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Put back on the shelf: 2 of Red tee, M'),
    );
  });

  it('uses a new idempotency key for each tap', async () => {
    api.restockAwaiting.mockRejectedValue(new ApiError(503, { code: 'BUSY' }));
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);
    const button = screen.getByRole('button', { name: 'Received on the shelf: Red tee, M' });

    await userEvent.click(button);
    await waitFor(() => expect(api.restockAwaiting).toHaveBeenCalledTimes(1));
    await userEvent.click(button);
    await waitFor(() => expect(api.restockAwaiting).toHaveBeenCalledTimes(2));

    const keys = api.restockAwaiting.mock.calls.map((call) => call[3] as string);
    expect(new Set(keys).size).toBe(2);
  });

  it('carries the same key on a retry of one tap, and a new key for the next tap', async () => {
    api.restockAwaiting
      .mockRejectedValueOnce(new ApiError(503, { code: 'BUSY' }))
      .mockRejectedValue(new ApiError(503, { code: 'BUSY' }));
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: 1, retryDelay: 0 }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <OrderStockOutBlock order={awaitingOrder()} />
      </QueryClientProvider>,
    );
    const button = screen.getByRole('button', { name: 'Received on the shelf: Red tee, M' });

    await userEvent.click(button);
    await waitFor(() => expect(api.restockAwaiting).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(api.restockAwaiting).toHaveBeenCalledTimes(4));

    const [first, retry, second, secondRetry] = api.restockAwaiting.mock.calls.map(
      (call) => call[3] as string,
    );
    expect(retry).toBe(first);
    expect(second).not.toBe(first);
    expect(secondRetry).toBe(second);
  });

  it.each([
    ['NOTHING_AWAITING', 409, 'Fewer pieces of this line are expected back than that.'],
    [
      'PERIOD_LOCKED',
      422,
      'The stock period is locked, so pieces cannot be put back on the shelf now.',
    ],
    ['FORBIDDEN', 403, 'You do not have permission to do this.'],
    [
      'IDEMPOTENCY_CONFLICT',
      409,
      'This action was already sent with other details. Reload the page and try again.',
    ],
  ])('says what went wrong on %s', async (code, status, sentence) => {
    api.restockAwaiting.mockRejectedValue(new ApiError(status, { code }));
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Received on the shelf: Red tee, M' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says the system is busy on a 503 and keeps the button for another tap', async () => {
    api.restockAwaiting.mockRejectedValue(new ApiError(503, { code: 'BUSY' }));
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Received on the shelf: Red tee, M' }),
    );

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Received on the shelf: Red tee, M' })).toBeEnabled();
  });

  it('offers no Received on the shelf without stock.receive', () => {
    me.current = { id: 'me', hats: ['accountant'], permissions: ['orders.view', 'stock.correct'] };
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);
    expect(screen.queryByRole('button', { name: /Received on the shelf/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close pieces of Red tee, M' })).toBeVisible();
  });
});

describe('Closing pieces that never come back (AC-27 f)', () => {
  it('closes with a reason for a stock.correct holder, sending the order token and the quantity', async () => {
    const order = awaitingOrder();
    api.closeAwaitingRestock.mockResolvedValue(orderDetailOf());
    renderWithQuery(<OrderStockOutBlock order={order} />);

    await userEvent.click(screen.getByRole('button', { name: 'Close pieces of Red tee, M' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Close pieces that never came back',
    });
    expect(within(dialog).getByLabelText('Pieces')).toHaveValue('2');
    const quantity = within(dialog).getByLabelText('Pieces');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '1');
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'lost_by_carrier');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close pieces' }));

    await waitFor(() =>
      expect(api.closeAwaitingRestock).toHaveBeenCalledWith(order.id, LINE_ID, {
        expectedUpdatedAt: order.updatedAt,
        quantity: 1,
        reasonCode: 'lost_by_carrier',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Closed 1 of Red tee, M.'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says request, not close, to a warehouse hat and tells a manager is asked', async () => {
    me.current = WAREHOUSE;
    const order = awaitingOrder();
    api.closeAwaitingRestock.mockResolvedValue(order);
    renderWithQuery(<OrderStockOutBlock order={order} />);

    expect(screen.queryByRole('button', { name: 'Close pieces of Red tee, M' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Ask a manager to close pieces of Red tee, M' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Ask a manager to close pieces' });
    expect(within(dialog).getByText(/line stays as it is/)).toBeVisible();
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'damaged_not_resold');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(api.closeAwaitingRestock).toHaveBeenCalledWith(order.id, LINE_ID, {
        expectedUpdatedAt: order.updatedAt,
        quantity: 2,
        reasonCode: 'damaged_not_resold',
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Request sent to a manager for 2 of Red tee, M.'),
    );
  });

  it('asks for a reason and a quantity within what awaits before sending anything', async () => {
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close pieces of Red tee, M' }));
    const dialog = await screen.findByRole('dialog');

    const quantity = within(dialog).getByLabelText('Pieces');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close pieces' }));

    expect(await within(dialog).findByText('Choose a reason.')).toBeVisible();
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'other');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close pieces' }));
    expect(await within(dialog).findByText('Enter a whole number from 1 to 2.')).toBeVisible();
    expect(api.closeAwaitingRestock).not.toHaveBeenCalled();
  });

  it('accepts a quantity typed in Arabic digits', async () => {
    const order = awaitingOrder();
    api.closeAwaitingRestock.mockResolvedValue(orderDetailOf());
    renderWithQuery(<OrderStockOutBlock order={order} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close pieces of Red tee, M' }));
    const dialog = await screen.findByRole('dialog');

    const quantity = within(dialog).getByLabelText('Pieces');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '١');
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'customer_kept');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close pieces' }));

    await waitFor(() =>
      expect(api.closeAwaitingRestock).toHaveBeenCalledWith(
        order.id,
        LINE_ID,
        expect.objectContaining({ quantity: 1, reasonCode: 'customer_kept' }),
      ),
    );
  });

  it.each([
    ['NOTHING_AWAITING', 409, 'Fewer pieces of this line are expected back than that.'],
    [
      'STALE_RECORD',
      409,
      'This order changed while you were working. The page now shows the latest version; check it and try again.',
    ],
    [
      'CLOSE_ALREADY_REQUESTED',
      409,
      'A request to close pieces of this line is already waiting for a manager.',
    ],
  ])('keeps the dialog open and says what went wrong on %s', async (code, status, sentence) => {
    api.closeAwaitingRestock.mockRejectedValue(new ApiError(status, { code }));
    renderWithQuery(<OrderStockOutBlock order={awaitingOrder()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close pieces of Red tee, M' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'other');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close pieces' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
