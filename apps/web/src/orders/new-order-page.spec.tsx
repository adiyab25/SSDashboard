import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { NewOrderPage } from './new-order-page';

const api = vi.hoisted(() => ({
  getOrderOptions: vi.fn(),
  createOrder: vi.fn(),
  createGiftedOrder: vi.fn(),
  listOrders: vi.fn(),
}));
vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const skus = vi.hoisted(() => ({ searchSkus: vi.fn() }));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...skus,
}));

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: null,
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const STORE = '20000000-0000-4000-8000-000000000001';
const CHANNEL = '10000000-0000-4000-8000-000000000001';
const VARIANT = '50000000-0000-4000-8000-000000000001';
const ORIGINAL = '00000000-0000-4000-8000-000000000009';

const SUPPORT = { id: 'me', hats: ['support'], permissions: ['orders.view', 'orders.confirm'] };
const MANAGER = {
  id: 'me',
  hats: ['manager'],
  permissions: ['orders.view', 'orders.confirm', 'orders.gift'],
};

beforeEach(() => {
  me.current = SUPPORT;
  api.getOrderOptions.mockResolvedValue({
    stores: [{ id: STORE, code: 'MAIN', name: { en: 'Main store' } }],
    channels: [{ id: CHANNEL, code: 'wa', name: { en: 'WhatsApp' }, kind: 'whatsapp' }],
    giftReasonCodes: ['influencer', 'replacement_goodwill', 'other'],
    salesTaxRate: '14.00',
    pricesIncludeVat: true,
  });
  skus.searchSkus.mockResolvedValue({
    items: [
      {
        id: VARIANT,
        productId: '70000000-0000-4000-8000-000000000001',
        code: 'TEE-RED-M',
        name: { en: 'Red tee' },
        price: '250.00',
        archived: false,
      },
    ],
    nextCursor: null,
  });
  api.listOrders.mockResolvedValue({
    items: [
      {
        id: ORIGINAL,
        storeCode: 'ESS',
        orderNumber: '#0999',
        placedAt: '2026-11-03T10:00:00.000Z',
        shipToName: 'Mona Adel',
        channelId: CHANNEL,
        channelName: { en: 'WhatsApp' },
        totalAmount: '500.00',
        codDueAmount: '0.00',
        fulfillmentState: 'refused',
        cashState: 'nothing_to_collect',
        outcome: 'failed_delivery',
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
  api.createOrder.mockResolvedValue({ id: ORIGINAL, storeCode: 'MAIN', orderNumber: 'SO-1' });
  api.createGiftedOrder.mockResolvedValue({ id: ORIGINAL, storeCode: 'MAIN', orderNumber: 'SO-2' });
});

afterEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(skus), router.push]) mock.mockReset();
  me.current = null;
});

/** The body the nth call of a mocked create route received. */
function bodyOf(mock: { mock: { calls: unknown[][] } }, call: number): Record<string, unknown> {
  return (mock.mock.calls[call]?.[0] ?? {}) as Record<string, unknown>;
}

/** Fills the ship to block and picks the one SKU on line 1. */
async function fillOrder(user: ReturnType<typeof userEvent.setup>, quantity = '2') {
  await user.type(await screen.findByLabelText(/^Name/), 'Mona Adel');
  await user.type(screen.getByLabelText(/^Phone\(/), '01001234567');
  await user.type(screen.getByLabelText(/^Address/), '12 Nile Street');
  await user.click(screen.getByRole('combobox', { name: 'SKU' }));
  await user.click(await screen.findByRole('option', { name: /TEE-RED-M/ }));
  await user.type(screen.getByLabelText('Quantity'), quantity);
}

describe('NewOrderPage (AC-1, AC-20)', () => {
  it('has one h1, offers no gifted kind without orders.gift, and sends nothing when empty', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);

    await screen.findByRole('button', { name: 'Create order' });
    expect(screen.getByRole('heading', { level: 1, name: 'New order' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('radio', { name: 'Gifted' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findAllByText('This field is required.')).not.toHaveLength(0);
    expect(screen.getByText('Choose a SKU.')).toBeVisible();
    expect(api.createOrder).not.toHaveBeenCalled();
  });

  it('creates a cash on delivery order from the contract body and opens it', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    // One store and one channel are chosen already; the list price starts the unit price.
    expect(screen.getByLabelText(/^Unit price/)).toHaveValue('250.00');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(1));
    expect(bodyOf(api.createOrder, 0)).toEqual({
      clientRef: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      storeId: STORE,
      channelId: CHANNEL,
      shipTo: {
        name: 'Mona Adel',
        phone: '01001234567',
        phoneAlt: null,
        address: '12 Nile Street',
        courierNote: null,
      },
      lines: [{ variantId: VARIANT, quantity: 2, unitPrice: '250.00', discountAmount: '0.00' }],
      shippingChargedAmount: '0.00',
      paymentMethod: 'cod',
      prepaidAmount: '0.00',
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/orders/${ORIGINAL}`));
  });

  it('keeps the same clientRef when the person retries after BUSY', async () => {
    api.createOrder
      .mockRejectedValueOnce(new ApiError(503, { code: 'BUSY' }, 2))
      .mockResolvedValueOnce({ id: ORIGINAL, storeCode: 'MAIN', orderNumber: 'SO-1' });
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The system is busy');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(2));
    expect(bodyOf(api.createOrder, 1).clientRef).toBe(bodyOf(api.createOrder, 0).clientRef);
  });

  it('sends a full prepayment for a prepaid method, from the total it shows', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user, '1');
    await user.selectOptions(screen.getByLabelText('Payment'), 'instapay');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(1));
    const body = bodyOf(api.createOrder, 0);
    expect(body.paymentMethod).toBe('instapay');
    expect(body.prepaidAmount).toBe('250.00');
  });

  it.each([
    ['LINE_FULLY_DISCOUNTED', 422, 'cannot be discounted to nothing'],
    ['RELATED_ORDER_OTHER_CUSTOMER', 422, 'belongs to a different customer'],
    ['ALREADY_REOPENED', 409, 'already been reopened'],
    ['CHANNEL_NOT_ALLOWED', 422, 'on this channel'],
  ])('gives %s its own message', async (code, status, text) => {
    api.createOrder.mockRejectedValue(new ApiError(status, { code }));
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('puts INVALID_PHONE_ALT on the second phone field', async () => {
    api.createOrder.mockRejectedValue(new ApiError(422, { code: 'INVALID_PHONE_ALT' }));
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    await user.type(screen.getByLabelText(/^Second phone/), '123');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    const field = screen.getByLabelText(/^Second phone/);
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('The second phone number is not a valid phone number.')).toBeVisible();
  });

  it('draws the h1 with a skeleton while access loads', () => {
    me.current = null;
    renderWithQuery(<NewOrderPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'New order' })).toBeVisible();
    expect(api.getOrderOptions).not.toHaveBeenCalled();
  });

  it('shows the no access state without orders.confirm and asks for nothing', () => {
    me.current = { id: 'me', hats: ['warehouse'], permissions: ['orders.view'] };
    renderWithQuery(<NewOrderPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('You do not have access to this page')).toBeVisible();
    expect(api.getOrderOptions).not.toHaveBeenCalled();
  });
});

describe('NewOrderPage gifted mode and linked orders (AC-2, AC-23)', () => {
  it('asks for a retail price above 0 on a gifted line, on the field, and sends nothing', async () => {
    me.current = MANAGER;
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    await user.click(screen.getByRole('radio', { name: 'Gifted' }));
    await user.selectOptions(screen.getByLabelText(/^Gift reason/), 'influencer');
    await user.clear(screen.getByLabelText(/^Unit price/));
    await user.type(screen.getByLabelText(/^Unit price/), '0');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    expect(
      await screen.findByText('A gift keeps its retail price. Enter a price above 0.'),
    ).toBeVisible();
    expect(screen.getByLabelText(/^Unit price/)).toHaveAttribute('aria-invalid', 'true');
    expect(api.createGiftedOrder).not.toHaveBeenCalled();
    expect(screen.queryByText(/try again/i)).toBeNull();
  });

  it('says a search is rate limited in the related order picker', async () => {
    api.listOrders.mockRejectedValue(new ApiError(429, { code: 'RATE_LIMITED' }, 30));
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await screen.findByRole('button', { name: 'Create order' });
    await user.selectOptions(screen.getByLabelText('Link this order to'), 'reopened_from');
    await user.click(screen.getByRole('combobox', { name: /^Order/ }));
    await user.type(screen.getByPlaceholderText('Phone or order number'), '0999');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Too many searches'));
  });

  it('hides discount, payment, and shipping, and needs the original for a goodwill gift', async () => {
    me.current = MANAGER;
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    await user.click(screen.getByRole('radio', { name: 'Gifted' }));

    expect(screen.queryByLabelText('Discount')).toBeNull();
    expect(screen.queryByLabelText('Payment')).toBeNull();
    expect(screen.queryByLabelText('Shipping charged')).toBeNull();

    await user.selectOptions(screen.getByLabelText(/^Gift reason/), 'replacement_goodwill');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Choose the linked order.')).toBeVisible();
    expect(api.createGiftedOrder).not.toHaveBeenCalled();

    await user.click(screen.getByRole('combobox', { name: /^Order/ }));
    await user.type(screen.getByPlaceholderText('Phone or order number'), '0999');
    await user.click(await screen.findByRole('option', { name: /ESS\/#0999/ }));
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(api.createGiftedOrder).toHaveBeenCalledTimes(1));
    expect(api.listOrders).toHaveBeenCalledWith(
      expect.objectContaining({ q: '0999' }),
      undefined,
      expect.anything(),
      20,
    );
    const body = bodyOf(api.createGiftedOrder, 0);
    expect(body).toMatchObject({
      giftReasonCode: 'replacement_goodwill',
      relatedOrder: { orderId: ORIGINAL, relation: 'goodwill_for' },
      shippingChargedAmount: '0.00',
      // Every line keeps its price with an equal discount (2 x 250.00), so gross is 0.
      lines: [{ variantId: VARIANT, quantity: 2, unitPrice: '250.00', discountAmount: '500.00' }],
    });
    expect(body).not.toHaveProperty('paymentMethod');
  });

  it('links a sale to the order it reopens', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewOrderPage />);
    await fillOrder(user);
    await user.selectOptions(screen.getByLabelText('Link this order to'), 'reopened_from');
    await user.click(screen.getByRole('combobox', { name: /^Order/ }));
    await user.type(screen.getByPlaceholderText('Phone or order number'), '0999');
    const option = await screen.findByRole('option', { name: /ESS\/#0999/ });
    expect(within(option).getByText('Refused')).toBeVisible();
    await user.click(option);
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(api.createOrder).toHaveBeenCalledTimes(1));
    expect(bodyOf(api.createOrder, 0).relatedOrder).toEqual({
      orderId: ORIGINAL,
      relation: 'reopened_from',
    });
  });
});
