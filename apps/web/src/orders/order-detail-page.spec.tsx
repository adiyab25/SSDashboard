import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { OrderDetailPage } from './order-detail-page';
import { ORDER_ID, orderDetailOf as detail } from './order-detail-fixture';

const api = vi.hoisted(() => ({ getOrder: vi.fn() }));
vi.mock('./orders-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

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

  it('lists each open write back command with its state and the provider error code', async () => {
    api.getOrder.mockResolvedValue(
      detail({
        writeBackState: 'failed',
        writeBackCommands: [
          {
            id: '70000000-0000-4000-8000-000000000001',
            kind: 'shopify.order_edit',
            syncState: 'failed',
            failureReason: 'STEP_OFF',
            queuedAt: '2026-11-03T12:00:00.000Z',
          },
          {
            id: '70000000-0000-4000-8000-000000000002',
            kind: 'shopify.order_cancel',
            syncState: 'waiting',
            failureReason: null,
            queuedAt: '2026-11-03T12:05:00.000Z',
          },
        ],
      }),
    );
    renderWithQuery(<OrderDetailPage />);
    const block = await screen.findByRole('status');
    const commands = within(block).getByRole('list', {
      name: 'Changes waiting to reach the sales channel',
    });
    const [edit, cancel] = within(commands).getAllByRole('listitem');
    expect(edit).toHaveTextContent('Order edit to Shopify');
    expect(edit).toHaveTextContent('Failed');
    expect(
      within(edit as HTMLElement)
        .getByText('STEP_OFF')
        .closest('bdi'),
    ).toHaveAttribute('dir', 'ltr');
    expect(cancel).toHaveTextContent('Cancellation to Shopify');
    expect(cancel).toHaveTextContent('Waiting');
  });

  it('shows no action to a viewer who may only read', async () => {
    api.getOrder.mockResolvedValue(detail());
    renderWithQuery(<OrderDetailPage />);
    await screen.findByRole('heading', { level: 1, name: 'ESS/#1001' });
    expect(screen.queryByRole('region', { name: 'Order actions' })).toBeNull();
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
