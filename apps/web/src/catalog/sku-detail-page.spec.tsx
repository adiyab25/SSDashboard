import type { SkuMovement } from '@ssdashboard/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/inventory/render-with-query';
import { SkuDetailPage } from './sku-detail-page';

const api = vi.hoisted(() => ({
  getSku: vi.fn(),
  getSkuStock: vi.fn(),
  listSkuMovements: vi.fn(),
  getSkuUsage: vi.fn(),
}));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: SKU_ID }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['warehouse'], permissions: ['stock.view', 'stock.receive'] },
  }),
}));

const SKU_ID = '00000000-0000-4000-8000-000000000001';
const RECEIPT_ID = '20000000-0000-4000-8000-000000000001';
const LOC = { id: '30000000-0000-4000-8000-000000000001', code: 'MAIN', name: { en: 'Main' } };

const movement = (n: number, overrides: Partial<SkuMovement> = {}): SkuMovement => ({
  id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  effectiveAt: '2026-11-02T10:00:00.000Z',
  recordedAt: '2026-11-02T10:00:00.000Z',
  location: LOC,
  quantity: 5,
  sourceType: 'stock_receipt',
  isReversal: false,
  source: { id: RECEIPT_ID, number: 'SR-000001' },
  postedBy: { id: 'u1', name: 'Sam Carter' },
  ...overrides,
});

function arrange(options: { cost: boolean; movements?: SkuMovement[]; next?: string | null }) {
  api.getSku.mockResolvedValue({
    id: SKU_ID,
    productId: SKU_ID,
    code: 'WIDGET-1',
    name: { en: 'Widget' },
    price: '9.00',
    archived: false,
    status: 'active',
    updatedAt: 'x',
  });
  api.getSkuStock.mockResolvedValue({
    locations: [
      {
        location: LOC,
        onHand: 5,
        ...(options.cost && { avgUnitCost: '2.0000', totalValue: '10.00' }),
      },
    ],
    totalOnHand: 5,
    ...(options.cost && { totalValue: '10.00' }),
  });
  api.listSkuMovements.mockResolvedValue({
    items: options.movements ?? [movement(1)],
    nextCursor: options.next ?? null,
  });
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe('SkuDetailPage (AC-10, AC-11)', () => {
  it('has exactly one h1 while loading', () => {
    api.getSku.mockReturnValue(new Promise(() => undefined));
    renderWithQuery(<SkuDetailPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('leaves the cost columns out entirely when the api sent no cost fields', async () => {
    arrange({ cost: false });
    renderWithQuery(<SkuDetailPage />);

    const stock = await screen.findByRole('table', { name: 'Stock by location' });
    expect(await within(stock).findByText('Main')).toBeVisible();
    expect(within(stock).queryByRole('columnheader', { name: 'Average cost' })).toBeNull();
    expect(within(stock).queryByRole('columnheader', { name: 'Stock value' })).toBeNull();
    const history = screen.getByRole('table', { name: /Movement history/ });
    expect(await within(history).findByText('Sam Carter')).toBeVisible();
    expect(within(history).queryByRole('columnheader', { name: 'Unit cost' })).toBeNull();
    expect(within(history).queryByRole('columnheader', { name: 'Total cost' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the cost columns when the api sent them', async () => {
    arrange({ cost: true, movements: [movement(1, { unitCost: '2.0000', totalCost: '10.00' })] });
    renderWithQuery(<SkuDetailPage />);

    const stock = await screen.findByRole('table', { name: 'Stock by location' });
    expect(await within(stock).findByRole('columnheader', { name: 'Average cost' })).toBeVisible();
    expect(within(stock).getByRole('columnheader', { name: 'Stock value' })).toBeVisible();
    const history = screen.getByRole('table', { name: /Movement history/ });
    expect(await within(history).findByRole('columnheader', { name: 'Unit cost' })).toBeVisible();
  });

  it('reads void rows as "Void of SR-…", links the receipt, and names the system', async () => {
    arrange({
      cost: false,
      movements: [movement(2, { quantity: -5, isReversal: true, postedBy: null }), movement(1)],
    });
    renderWithQuery(<SkuDetailPage />);

    const history = await screen.findByRole('table', { name: /Movement history/ });
    const voided = await within(history).findByRole('link', { name: 'Void of SR-000001' });
    expect(voided).toHaveAttribute('href', `/stock-receipts/${RECEIPT_ID}`);
    expect(within(history).getByText('System')).toBeVisible();
    expect(within(history).getByRole('link', { name: 'SR-000001' })).toHaveAttribute(
      'href',
      `/stock-receipts/${RECEIPT_ID}`,
    );
    const rows = within(history).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Void of SR-000001');
  });

  it('loads older movements with Load more', async () => {
    arrange({ cost: false, next: 'older' });
    api.listSkuMovements
      .mockResolvedValueOnce({ items: [movement(1)], nextCursor: 'older' })
      .mockResolvedValueOnce({
        items: [movement(2, { postedBy: { id: 'u2', name: 'Nour Newhire' } })],
        nextCursor: null,
      });
    renderWithQuery(<SkuDetailPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Nour Newhire')).toBeVisible();
    expect(screen.getByText('Sam Carter')).toBeVisible();
    expect(api.listSkuMovements).toHaveBeenLastCalledWith(SKU_ID, 'older', expect.anything());
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
