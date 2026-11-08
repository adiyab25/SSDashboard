import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrderEditFormModule from './order-edit-form';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { orderDetailOf } from './order-detail-fixture';
import { OrderEditDialog } from './order-edit-dialog';

const api = vi.hoisted(() => ({ editOrder: vi.fn() }));
const builder = vi.hoisted(() => ({ operations: 0 }));
vi.mock('./order-edit-form', async (original) => {
  const real = await original<typeof OrderEditFormModule>();
  return {
    ...real,
    buildEditBody: (...args: Parameters<typeof real.buildEditBody>) => {
      const body = real.buildEditBody(...args);
      return builder.operations === 0
        ? body
        : {
            ...body,
            operations: Array.from({ length: builder.operations }, () => ({
              kind: 'shipping' as const,
              shippingChargedAmount: '1.00',
            })),
          };
    },
  };
});

vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const skus = vi.hoisted(() => ({ searchSkus: vi.fn() }));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...skus,
}));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: null,
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const LINE_ID = '40000000-0000-4000-8000-000000000001';
const VARIANT_L = '50000000-0000-4000-8000-000000000002';
const SUPPORT = { id: 'me', hats: ['support'], permissions: ['orders.view', 'orders.confirm'] };
const MANAGER = {
  id: 'me',
  hats: ['manager'],
  permissions: ['orders.view', 'orders.confirm', 'orders.gift'],
};

const handlers = () => ({
  onClose: vi.fn(),
  onEdited: vi.fn(),
  onInShopify: vi.fn(),
  onStale: vi.fn(),
  onOutOfDate: vi.fn(),
  onRestoreFocus: vi.fn(),
});

beforeEach(() => {
  me.current = SUPPORT;
  skus.searchSkus.mockResolvedValue({
    items: [
      {
        id: VARIANT_L,
        productId: '70000000-0000-4000-8000-000000000001',
        code: 'TEE-RED-L',
        name: { en: 'Red tee, L' },
        price: '260.00',
        archived: false,
      },
    ],
    nextCursor: null,
  });
});

afterEach(() => {
  builder.operations = 0;
  api.editOrder.mockReset();
  skus.searchSkus.mockReset();
  me.current = null;
});

/** The body the first edit call received. */
const sentBody = () => (api.editOrder.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;

describe('OrderEditDialog (AC-9, AC-10, AC-2, AC-20)', () => {
  it('sends only what changed: a new address and a replaced line, with the reason', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf();
    const on = handlers();
    api.editOrder.mockResolvedValue(order);
    renderWithQuery(<OrderEditDialog order={order} {...on} />);

    const dialog = await screen.findByRole('dialog', { name: /Edit order/ });
    expect(within(dialog).getByText('TEE-RED-M')).toBeVisible();
    const address = within(dialog).getByLabelText('Address');
    await user.clear(address);
    await user.type(address, '14 Nile Street');

    await user.selectOptions(within(dialog).getByLabelText('What to do with line 1'), 'replace');
    await user.click(within(dialog).getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-L/ }));
    await user.selectOptions(within(dialog).getByLabelText(/^Why\(optional\)/), 'size_change');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(on.onEdited).toHaveBeenCalled());
    expect(api.editOrder.mock.calls[0]?.[0]).toBe(order.id);
    expect(sentBody()).toEqual({
      expectedUpdatedAt: order.updatedAt,
      reasonCode: 'size_change',
      operations: [
        { kind: 'ship_to', address: '14 Nile Street' },
        {
          kind: 'replace_line',
          lineId: LINE_ID,
          variantId: VARIANT_L,
          quantity: 2,
          unitPrice: '260.00',
          discountAmount: '0.00',
        },
      ],
    });
  });

  it('removes a line only with a reason, adds a line, and changes the shipping charge', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf();
    api.editOrder.mockResolvedValue(order);
    renderWithQuery(<OrderEditDialog order={order} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');

    await user.selectOptions(within(dialog).getByLabelText('What to do with line 1'), 'remove');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('Choose why this line is removed.')).toBeVisible();
    expect(api.editOrder).not.toHaveBeenCalled();
    await user.selectOptions(within(dialog).getByLabelText(/Why remove this line/), 'out_of_stock');

    await user.click(within(dialog).getByRole('button', { name: 'Add line' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-L/ }));
    await user.type(within(dialog).getByLabelText('Quantity'), '1');
    const shipping = within(dialog).getByLabelText('Shipping charged');
    await user.clear(shipping);
    await user.type(shipping, '60');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.editOrder).toHaveBeenCalled());
    expect(sentBody().operations).toEqual([
      { kind: 'remove_line', lineId: LINE_ID, cancelReasonCode: 'out_of_stock' },
      {
        kind: 'add_line',
        variantId: VARIANT_L,
        quantity: 1,
        unitPrice: '260.00',
        discountAmount: '0.00',
      },
      { kind: 'shipping', shippingChargedAmount: '60' },
    ]);
    expect(sentBody()).not.toHaveProperty('reasonCode');
  });

  it('sends nothing and says so when nothing changed', async () => {
    const user = userEvent.setup();
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nothing was changed');
    expect(api.editOrder).not.toHaveBeenCalled();
  });

  it('keeps a gifted order free and hides its lines and shipping from a person without orders.gift', async () => {
    const user = userEvent.setup();
    const gifted = orderDetailOf({ type: 'gifted', giftReasonCode: 'influencer' });
    api.editOrder.mockResolvedValue(gifted);
    renderWithQuery(<OrderEditDialog order={gifted} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByLabelText('What to do with line 1')).toBeNull();
    expect(within(dialog).queryByLabelText('Shipping charged')).toBeNull();
    expect(within(dialog).getByText(/Only a manager can change the lines/)).toBeVisible();
    const address = within(dialog).getByLabelText('Address');
    await user.clear(address);
    await user.type(address, '1 Gift Road');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.editOrder).toHaveBeenCalled());
    expect(sentBody().operations).toEqual([{ kind: 'ship_to', address: '1 Gift Road' }]);
  });

  it('gives a gifted line an equal discount and no discount field for a manager', async () => {
    me.current = MANAGER;
    const user = userEvent.setup();
    const gifted = orderDetailOf({ type: 'gifted', giftReasonCode: 'influencer' });
    api.editOrder.mockResolvedValue(gifted);
    renderWithQuery(<OrderEditDialog order={gifted} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');

    await user.selectOptions(within(dialog).getByLabelText('What to do with line 1'), 'replace');
    expect(within(dialog).queryByLabelText('Discount')).toBeNull();
    expect(within(dialog).queryByLabelText('Shipping charged')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.editOrder).toHaveBeenCalled());
    expect(sentBody().operations).toEqual([
      {
        kind: 'replace_line',
        lineId: LINE_ID,
        variantId: '50000000-0000-4000-8000-000000000001',
        quantity: 2,
        unitPrice: '250.00',
        discountAmount: '500.00',
      },
    ]);
  });

  it('shows a bad main phone under the phone field', async () => {
    const user = userEvent.setup();
    api.editOrder.mockRejectedValue(new ApiError(422, { code: 'INVALID_PHONE' }));
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    const phone = within(dialog).getByLabelText(/^Phone/);
    await user.clear(phone);
    await user.type(phone, '123');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    const problem = await within(dialog).findByText(
      'The phone number is not a valid phone number.',
    );
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(phone).toHaveAccessibleDescription(problem.textContent ?? '');
  });

  it.each([
    ['ORDER_LOCKED', 'can no longer be changed'],
    ['ORDER_NEEDS_A_LINE', 'at least one open line'],
    ['EDIT_CHANGES_PAYMENT', 'cash to collect'],
    ['EDIT_OVERPAID', 'lower than what the customer already paid'],
    ['GIFT_MUST_STAY_FREE', 'cannot charge'],
  ])('shows %s in the dialog and keeps what was typed', async (code, text) => {
    const user = userEvent.setup();
    api.editOrder.mockRejectedValue(new ApiError(code === 'ORDER_LOCKED' ? 409 : 422, { code }));
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    const address = within(dialog).getByLabelText('Address');
    await user.clear(address);
    await user.type(address, 'Somewhere else');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
    expect(address).toHaveValue('Somewhere else');
  });

  it('hands a stale order and a Shopify order back to the page', async () => {
    const user = userEvent.setup();
    const on = handlers();
    api.editOrder.mockRejectedValueOnce(new ApiError(409, { code: 'ORDER_STALE' }));
    api.editOrder.mockRejectedValueOnce(new ApiError(409, { code: 'EDIT_IN_SHOPIFY' }));
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...on} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Second phone'), '01111111111');

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(on.onStale).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(on.onInShopify).toHaveBeenCalledTimes(1));
  });

  it('closes without saving and has a name, a description, and a labelled close button', async () => {
    const user = userEvent.setup();
    const on = handlers();
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...on} />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit order ⁦ESS/#1001⁩' });
    expect(dialog).toHaveAccessibleDescription(/Change where it ships/);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Close without saving' }));
    expect(on.onClose).toHaveBeenCalled();
  });

  it('keeps the order it opened on: a refetch behind it changes neither the form nor the token', async () => {
    const user = userEvent.setup();
    const opened = orderDetailOf();
    api.editOrder.mockResolvedValue(opened);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { rerender } = render(<OrderEditDialog order={opened} {...handlers()} />, { wrapper });
    const dialog = await screen.findByRole('dialog');

    // Someone else changed the order: a newer copy with another address and token arrives.
    rerender(
      <OrderEditDialog
        order={{
          ...opened,
          updatedAt: '2026-11-03T12:00:00.654321Z',
          shipTo: { ...opened.shipTo, address: 'Changed by someone else' },
        }}
        {...handlers()}
      />,
    );
    expect(within(dialog).getByLabelText('Address')).toHaveValue('12 Nile Street, Cairo');

    await user.type(within(dialog).getByLabelText('Second phone'), '01111111111');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.editOrder).toHaveBeenCalled());
    expect(sentBody().expectedUpdatedAt).toBe(opened.updatedAt);
  });

  it('sends nothing for a replace that names the same SKU, quantity, price, and discount', async () => {
    const user = userEvent.setup();
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('What to do with line 1'), 'replace');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nothing was changed');
    expect(api.editOrder).not.toHaveBeenCalled();
  });

  it('clears the price when the new SKU has none, and the discount with it', async () => {
    const user = userEvent.setup();
    skus.searchSkus.mockResolvedValue({
      items: [
        {
          id: VARIANT_L,
          productId: '70000000-0000-4000-8000-000000000001',
          code: 'TEE-RED-L',
          name: { en: 'Red tee, L' },
          price: null,
          archived: false,
        },
      ],
      nextCursor: null,
    });
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('What to do with line 1'), 'replace');
    await user.click(within(dialog).getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-L/ }));

    expect(within(dialog).getByLabelText('Unit price')).toHaveValue('');
    expect(within(dialog).getByLabelText('Discount')).toHaveValue('0.00');
  });

  it('does not send a ship to change for a value that only differs by spaces', async () => {
    const user = userEvent.setup();
    const order = orderDetailOf();
    renderWithQuery(
      <OrderEditDialog
        order={{ ...order, shipTo: { ...order.shipTo, address: '  12 Nile Street, Cairo ' } }}
        {...handlers()}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nothing was changed');
  });

  it.each(['ORDER_LOCKED', 'INVALID_TRANSITION', 'ORDER_NOT_FOUND'])(
    'asks the page to refetch on %s',
    async (code) => {
      const user = userEvent.setup();
      const on = handlers();
      api.editOrder.mockRejectedValue(new ApiError(409, { code }));
      renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...on} />);
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Second phone'), '01111111111');
      await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(on.onOutOfDate).toHaveBeenCalled());
    },
  );

  it('hands focus to onRestoreFocus when nothing that opened it can take focus back', async () => {
    const on = handlers();
    const { rerender } = renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...on} />);
    await screen.findByRole('dialog');
    rerender(<div />);
    await waitFor(() => expect(on.onRestoreFocus).toHaveBeenCalled());
  });

  it('keeps a price the person typed before picking a SKU, but follows an earlier pick', async () => {
    const user = userEvent.setup();
    skus.searchSkus.mockResolvedValue({
      items: [
        {
          id: VARIANT_L,
          productId: '70000000-0000-4000-8000-000000000001',
          code: 'TEE-RED-L',
          name: { en: 'Red tee, L' },
          price: '260.00',
          archived: false,
        },
        {
          id: '50000000-0000-4000-8000-000000000003',
          productId: '70000000-0000-4000-8000-000000000001',
          code: 'TEE-RED-XL',
          name: { en: 'Red tee, XL' },
          price: '270.00',
          archived: false,
        },
      ],
      nextCursor: null,
    });
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');

    // A new row: a typed price and discount survive the pick.
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }));
    const row = within(dialog).getByRole('listitem', { name: 'New line 1' });
    await user.type(within(row).getByLabelText('Unit price'), '99');
    const discount = within(row).getByLabelText('Discount');
    await user.clear(discount);
    await user.type(discount, '5');
    await user.click(within(row).getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-L/ }));
    expect(within(row).getByLabelText('Unit price')).toHaveValue('99');
    expect(within(row).getByLabelText('Discount')).toHaveValue('5');

    // A second new row: the first pick fills the price, and a second pick replaces it.
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }));
    const second = within(dialog).getByRole('listitem', { name: 'New line 2' });
    await user.click(within(second).getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-L/ }));
    expect(within(second).getByLabelText('Unit price')).toHaveValue('260.00');
    await user.click(within(second).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-XL/ }));
    expect(within(second).getByLabelText('Unit price')).toHaveValue('270.00');
  });

  it('keeps a price typed on a replaced line when another SKU is picked', async () => {
    const user = userEvent.setup();
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('What to do with line 1'), 'replace');
    const price = within(dialog).getByLabelText('Unit price');
    await user.clear(price);
    await user.type(price, '199');
    await user.click(within(dialog).getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: /TEE-RED-L/ }));
    expect(within(dialog).getByLabelText('Unit price')).toHaveValue('199');
  });

  it('refuses an edit of more than 50 changes before any request', async () => {
    // Building 51 real changes through the form takes seconds, so the body builder is told to
    // answer with 51 operations; the cap itself is held to the contract in order-edit-form.spec.ts.
    builder.operations = 51;
    const user = userEvent.setup();
    renderWithQuery(<OrderEditDialog order={orderDetailOf()} {...handlers()} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Second phone'), '01111111111');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('at most 50 changes');
    expect(api.editOrder).not.toHaveBeenCalled();
  });
});
