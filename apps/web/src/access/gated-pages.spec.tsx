import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPage } from '@/audit/audit-page';
import { SkuDetailPage } from '@/catalog/sku-detail-page';
import { SkusPage } from '@/catalog/skus-page';
import { LocationsPage } from '@/inventory/locations-page';
import { ReceiptDetailPage } from '@/inventory/receipt-detail-page';
import { ReceiptFormPage } from '@/inventory/receipt-form-page';
import { ReceiptsPage } from '@/inventory/receipts-page';
import { StockPage } from '@/inventory/stock-page';

type Person = { id: string; hats: string[]; permissions: string[] };
type MeAnswer = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; me: Person };

const me = vi.hoisted((): { answer: MeAnswer; attempts: number[] } => ({
  answer: { status: 'loading' },
  attempts: [],
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: (_path: string | undefined, attempt = 0) => {
    me.attempts.push(attempt);
    return me.answer;
  },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '50000000-0000-4000-8000-000000000001' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/shell/current-location-provider', () => ({
  useCurrentLocation: () => 'all',
  useLocationSwitcher: () => ({
    retry: vi.fn(),
    current: 'all',
    ready: true,
    status: 'ready',
    locations: [],
  }),
  locationName: () => '',
}));

/** Has `stock.view` and nothing else that matters to these pages. */
const SUPPORT: Person = { id: 'p', hats: ['support'], permissions: ['stock.view'] };
const MEDIA_BUYER: Person = { id: 'p', hats: ['media_buyer'], permissions: ['campaigns.view'] };
const WAREHOUSE: Person = {
  id: 'p',
  hats: ['warehouse'],
  permissions: ['stock.view', 'stock.receive', 'catalog.edit', 'catalog.manage'],
};
const MANAGER: Person = {
  id: 'p',
  hats: ['manager'],
  permissions: ['audit.read', 'catalog.manage', 'stock.view'],
};

interface GatedPage {
  name: string;
  element: ReactElement;
  denied: Person;
  allowed: Person;
  /** The request the page makes once allowed; null for the form, which makes none of its own. */
  request: string | null;
}

const PAGES: GatedPage[] = [
  {
    name: '/stock',
    element: <StockPage />,
    denied: MEDIA_BUYER,
    allowed: WAREHOUSE,
    request: '/api/stock?',
  },
  {
    name: '/stock-receipts',
    element: <ReceiptsPage />,
    denied: MEDIA_BUYER,
    allowed: WAREHOUSE,
    request: '/api/stock-receipts?',
  },
  {
    name: '/stock-receipts/[id]',
    element: <ReceiptDetailPage />,
    denied: MEDIA_BUYER,
    allowed: WAREHOUSE,
    request: '/api/stock-receipts/50000000-0000-4000-8000-000000000001',
  },
  // Support holds stock.view but not stock.receive: the case the form gate exists for.
  {
    name: '/stock-receipts/new',
    element: <ReceiptFormPage />,
    denied: SUPPORT,
    allowed: WAREHOUSE,
    request: null,
  },
  {
    name: '/skus',
    element: <SkusPage />,
    denied: MEDIA_BUYER,
    allowed: WAREHOUSE,
    request: '/api/skus?',
  },
  {
    name: '/skus/[id]',
    element: <SkuDetailPage />,
    denied: MEDIA_BUYER,
    allowed: WAREHOUSE,
    request: '/api/skus/50000000-0000-4000-8000-000000000001',
  },
  {
    name: '/locations',
    element: <LocationsPage />,
    denied: SUPPORT,
    allowed: MANAGER,
    request: '/api/locations?',
  },
  {
    name: '/audit',
    element: <AuditPage />,
    denied: SUPPORT,
    allowed: MANAGER,
    request: '/api/audit/entries?',
  },
];

const fetchSpy = vi.fn();
beforeEach(() => {
  me.answer = { status: 'loading' };
  me.attempts = [];
  // Never answers: the specs only look at what was asked, not at what comes back.
  fetchSpy.mockReset().mockImplementation(() => new Promise(() => undefined));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function mount(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrap = (ui: ReactElement) => (
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
  const view = render(wrap(element));
  return { rerender: () => view.rerender(wrap(cloneElement(element))) };
}

const requested = () => fetchSpy.mock.calls.map(([url]) => String(url));

describe.each(PAGES)('$name gate (spec 0008, AC-11)', ({ element, denied, allowed, request }) => {
  it('asks the api for nothing while the person is unknown, then for nothing once denied', async () => {
    const { rerender } = mount(element);

    // Loading: no person yet. `enabled` is the only thing keeping the page quiet.
    expect(screen.queryByText('You do not have access to this page')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    me.answer = { status: 'ready', me: denied };
    rerender();

    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes its request once the person is allowed', async () => {
    const { rerender } = mount(element);
    expect(fetchSpy).not.toHaveBeenCalled();

    me.answer = { status: 'ready', me: allowed };
    rerender();

    expect(screen.queryByText('You do not have access to this page')).toBeNull();
    if (request) {
      await waitFor(() => expect(requested().some((url) => url.includes(request))).toBe(true));
    } else {
      expect(await screen.findByRole('button', { name: /^Post receipt|Receive/ })).toBeVisible();
    }
  });

  it('shows an error with Try again when the who am I call fails, and retries it', async () => {
    me.answer = { status: 'failed' };
    const { rerender } = mount(element);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/We could not check what you can use/)).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(me.attempts.every((attempt) => attempt === 0)).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(me.attempts.at(-1)).toBe(1);

    me.answer = { status: 'ready', me: denied };
    rerender();
    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.queryByText(/We could not check what you can use/)).toBeNull();
  });
});
