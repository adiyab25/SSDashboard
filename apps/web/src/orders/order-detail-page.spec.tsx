import type { OrderDetail } from '@ssdashboard/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { OrderDetailPage } from './order-detail-page';

const api = vi.hoisted(() => ({ getOrder: vi.fn() }));
vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const ORDER_ID = '00000000-0000-4000-8000-000000000001';
vi.mock('next/navigation', () => ({ useParams: () => ({ orderId: ORDER_ID }) }));

// The audit panel has its own spec; here it only has to appear for audit.read holders.
vi.mock('@/audit/record-history-panel', () => ({
  RecordHistoryPanel: ({ recordId }: { recordId: string }) => (
    <section aria-label="Audit panel">{recordId}</section>
  ),
}));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: { id: 'me', hats: ['support'], permissions: ['orders.view', 'customers.view'] },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const detail = (overrides: Partial<OrderDetail> = {}): OrderDetail => ({
  id: ORDER_ID,
  storeId: '20000000-0000-4000-8000-000000000001',
  storeCode: 'ESS',
  storeName: { en: 'Essentials' },
  channelId: '10000000-0000-4000-8000-000000000001',
  channelName: { en: 'WhatsApp' },
  orderNumber: '#1001',
  type: 'sale',
  giftReasonCode: null,
  relatedOrder: {
    id: '00000000-0000-4000-8000-000000000009',
    storeCode: 'ESS',
    orderNumber: '#0999',
    relation: 'reopened_from',
  },
  linkedFrom: [
    {
      id: '00000000-0000-4000-8000-000000000011',
      storeCode: 'MAIN',
      orderNumber: 'SO-2026-000042',
      relation: 'goodwill_for',
    },
  ],
  placedAt: '2026-11-03T10:00:00.000Z',
  operatingDay: '2026-11-03',
  fulfillmentState: 'confirmed',
  cashState: 'unpaid',
  outcome: 'open',
  writeBackState: 'none',
  confirmedAt: '2026-11-03T11:00:00.000Z',
  cancelledAt: null,
  cancelReasonCode: null,
  carrierDeliveryCreatedAt: null,
  source: {
    capturedFrom: 'whatsapp_thread',
    campaignId: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    discountCode: 'WELCOME',
  },
  shipTo: {
    name: 'Mona Adel',
    phone: '+201001234567',
    phoneAlt: null,
    contactPhoneRaw: null,
    address: '12 Nile Street, Cairo',
    area: null,
    courierNote: 'Call first',
  },
  customerNote: 'Please gift wrap',
  customer: { id: '30000000-0000-4000-8000-000000000001', name: 'Mona Adel', flagKind: 'refuser' },
  lines: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      position: 1,
      variantId: '50000000-0000-4000-8000-000000000001',
      skuCode: 'TEE-RED-M',
      title: 'Red tee, M',
      name: { en: 'Red tee, M', ar: 'تيشيرت أحمر، M' },
      quantity: 2,
      unitPrice: '250.00',
      discountAmount: '0.00',
      grossAmount: '500.00',
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
      lineState: 'open',
      cancelReasonCode: null,
      shortQuantity: 1,
    },
  ],
  money: {
    linesGrossAmount: '500.00',
    shippingChargedAmount: '50.00',
    shippingTaxAmount: '6.14',
    totalAmount: '550.00',
    paymentMethod: 'cod',
    prepaidAmount: '0.00',
    prepaidMethod: null,
    creditAppliedAmount: '0.00',
    codExpectedAmount: '550.00',
    codDueAmount: '550.00',
    codCollectedAmount: '0.00',
    remittedAmount: '0.00',
  },
  events: [
    {
      id: '60000000-0000-4000-8000-000000000001',
      machine: 'fulfillment',
      fromState: null,
      toState: 'new',
      amount: null,
      actorType: 'person',
      actorName: 'Sara Support',
      reasonCode: null,
      occurredAt: '2026-11-03T10:00:00.000Z',
    },
    {
      id: '60000000-0000-4000-8000-000000000002',
      machine: 'fulfillment',
      fromState: 'new',
      toState: 'confirmed',
      amount: null,
      actorType: 'person',
      actorName: null,
      reasonCode: 'channel.fake',
      occurredAt: '2026-11-03T11:00:00.000Z',
    },
  ],
  updatedAt: '2026-11-03T11:00:00.123456',
  ...overrides,
});

afterEach(() => {
  api.getOrder.mockReset();
  me.current = { id: 'me', hats: ['support'], permissions: ['orders.view', 'customers.view'] };
});

describe('OrderDetailPage (AC-3, AC-5, AC-20)', () => {
  it('shows every block of the page under one h1 with the store beside the number', async () => {
    api.getOrder.mockResolvedValue(detail());
    renderWithQuery(<OrderDetailPage />);

    const heading = await screen.findByRole('heading', { level: 1, name: 'ESS/#1001' });
    expect(heading).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    // Header facts, related order link, and the customer with her risk flag.
    expect(screen.getByText('Essentials')).toBeVisible();
    expect(screen.getByRole('link', { name: 'ESS/#0999' })).toHaveAttribute(
      'href',
      '/orders/00000000-0000-4000-8000-000000000009',
    );
    expect(screen.getByText('Reopened from')).toBeVisible();
    expect(screen.getByRole('link', { name: 'MAIN/SO-2026-000042' })).toHaveAttribute(
      'href',
      '/orders/00000000-0000-4000-8000-000000000011',
    );
    expect(screen.getByText('Goodwill gift')).toBeVisible();
    const customer = screen.getByRole('link', { name: 'Mona Adel' });
    expect(customer).toHaveAttribute('href', '/customers/30000000-0000-4000-8000-000000000001');
    expect(screen.getByText('Refuses orders')).toBeVisible();

    // Ship to, note, lines, money, timeline.
    expect(screen.getByText('12 Nile Street, Cairo')).toBeVisible();
    expect(screen.getByText('Please gift wrap')).toBeVisible();
    const lines = screen.getByRole('table', { name: 'Lines' });
    expect(within(lines).getByText('TEE-RED-M')).toBeVisible();
    expect(within(lines).getByText('Short by 1')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Money' })).toBeVisible();
    expect(screen.getByText('Cash on delivery due')).toBeVisible();
    const history = screen.getByRole('heading', { level: 2, name: 'History' }).closest('section');
    expect(history).not.toBeNull();
    expect(within(history as HTMLElement).getByText('Sara Support')).toBeVisible();
    expect(within(history as HTMLElement).getByText('Parcel: New to Confirmed')).toBeVisible();
    // A channel's own reason code is shown as it is, not dropped.
    expect(within(history as HTMLElement).getByText('channel.fake')).toBeVisible();
  });

  it('translates the source and keeps campaign ids and the store code left to right', async () => {
    api.getOrder.mockResolvedValue(
      detail({
        source: {
          capturedFrom: 'whatsapp_thread',
          campaignId: 'CMP-7',
          utmSource: null,
          utmMedium: null,
          utmCampaign: 'eid',
          discountCode: 'WELCOME',
        },
      }),
    );
    renderWithQuery(<OrderDetailPage />);
    await screen.findByRole('heading', { level: 1, name: 'ESS/#1001' });

    expect(screen.getByText('WhatsApp conversation')).toBeVisible();
    for (const id of ['CMP-7', 'eid', 'WELCOME']) {
      expect(screen.getByText(id).closest('bdi')).toHaveAttribute('dir', 'ltr');
    }
    expect(screen.queryByText('whatsapp_thread')).toBeNull();
    expect(
      screen.getByText('Essentials').parentElement?.querySelector('bdi[dir="ltr"]'),
    ).toHaveTextContent('ESS');
  });

  it('says to wait on a 429', async () => {
    api.getOrder.mockRejectedValue(new ApiError(429, { code: 'RATE_LIMITED' }, 20));
    renderWithQuery(<OrderDetailPage />);
    expect(
      await screen.findByText('Too many requests. Wait a moment and try again.'),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the unit cost column only when the answer carries cost', async () => {
    api.getOrder.mockResolvedValue(detail());
    const { unmount } = renderWithQuery(<OrderDetailPage />);
    const lines = await screen.findByRole('table', { name: 'Lines' });
    expect(within(lines).queryByRole('columnheader', { name: 'Unit cost' })).toBeNull();
    unmount();

    const priced = detail();
    const [first] = priced.lines;
    if (!first) throw new Error('no line');
    api.getOrder.mockResolvedValue({ ...priced, lines: [{ ...first, unitCost: '90.0000' }] });
    renderWithQuery(<OrderDetailPage />);
    const withCost = await screen.findByRole('table', { name: 'Lines' });
    expect(within(withCost).getByRole('columnheader', { name: 'Unit cost' })).toBeVisible();
  });

  it('shows the audit entries only to a viewer holding audit.read', async () => {
    api.getOrder.mockResolvedValue(detail());
    const { unmount } = renderWithQuery(<OrderDetailPage />);
    await screen.findByRole('heading', { level: 1, name: 'ESS/#1001' });
    expect(screen.queryByLabelText('Audit panel')).toBeNull();
    unmount();

    me.current = {
      id: 'me',
      hats: ['manager'],
      permissions: ['orders.view', 'customers.view', 'audit.read'],
    };
    renderWithQuery(<OrderDetailPage />);
    expect(await screen.findByLabelText('Audit panel')).toHaveTextContent(ORDER_ID);
  });

  it('says an edit is on hold when the write back is waiting', async () => {
    api.getOrder.mockResolvedValue(detail({ writeBackState: 'waiting' }));
    renderWithQuery(<OrderDetailPage />);
    expect(await screen.findByRole('status')).toHaveTextContent('Edit not synced, hold');
  });

  it('answers an unknown id with a message and a way back, under one h1', async () => {
    api.getOrder.mockRejectedValue(new ApiError(404, { code: 'ORDER_NOT_FOUND' }));
    renderWithQuery(<OrderDetailPage />);

    expect(await screen.findByText('This order does not exist.')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Back to orders' })).toHaveAttribute('href', '/orders');
  });

  it('shows the no access state and asks for nothing without orders.view', () => {
    me.current = { id: 'me', hats: ['media_buyer'], permissions: ['campaigns.view'] };
    renderWithQuery(<OrderDetailPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('You do not have access to this page')).toBeVisible();
    expect(api.getOrder).not.toHaveBeenCalled();
  });
});
