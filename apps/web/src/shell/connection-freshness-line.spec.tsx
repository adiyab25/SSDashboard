import type { ConnectionFreshnessItem, ConnectionFreshnessResponse } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { ConnectionFreshnessLine } from './connection-freshness-line';

const api = vi.hoisted(() => ({ getConnectionFreshness: vi.fn() }));
vi.mock('./connection-freshness-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(() => ({ permissions: ['orders.view'] as string[] }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['manager'], permissions: me.permissions },
  }),
}));

afterEach(() => {
  api.getConnectionFreshness.mockReset();
  me.permissions = ['orders.view'];
});

const AS_OF = '2026-11-09T10:00:00.000Z';
const item = (extra: Partial<ConnectionFreshnessItem> = {}): ConnectionFreshnessItem => ({
  connectionId: '0b0f6a4e-5d1c-4f7e-9a53-2d6f1c8e7a10',
  storePublicName: { en: 'Shopify Essentials', ar: 'شوبيفاي إيسنشيالز' },
  lastOrderAt: '2026-11-09T09:57:00.000Z',
  lastSweepAt: '2026-11-09T09:58:00.000Z',
  failedCommands: 0,
  failedOrderEvents: 0,
  state: 'fresh',
  ...extra,
});
const answer = (...items: ConnectionFreshnessItem[]): ConnectionFreshnessResponse => ({
  asOf: AS_OF,
  items,
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('ConnectionFreshnessLine (spec 0015, AC-18)', () => {
  it('shows a fresh line against the server instant, with no warning', async () => {
    api.getConnectionFreshness.mockResolvedValue(answer(item()));
    renderWithQuery(<ConnectionFreshnessLine />);
    expect(
      await screen.findByText(
        'Shopify Essentials: last order 3 minutes ago, checked 2 minutes ago',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Tell the manager/)).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('warns and says to tell the manager when late', async () => {
    api.getConnectionFreshness.mockResolvedValue(answer(item({ state: 'late' })));
    renderWithQuery(<ConnectionFreshnessLine />);
    expect(
      (await screen.findAllByText(/Orders may be late\. Tell the manager\./)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shopify Essentials: Orders may be late. Tell the manager.',
    );
  });

  it('warns when failing', async () => {
    api.getConnectionFreshness.mockResolvedValue(answer(item({ state: 'failing' })));
    renderWithQuery(<ConnectionFreshnessLine />);
    expect(
      (await screen.findAllByText(/The connection is failing\. Tell the manager\./)).length,
    ).toBeGreaterThan(0);
  });

  it('shows the failed counts with plural forms and warns although the state is fresh', async () => {
    api.getConnectionFreshness.mockResolvedValue(
      answer(item({ failedCommands: 2, failedOrderEvents: 1 })),
    );
    renderWithQuery(<ConnectionFreshnessLine />);
    expect(
      (await screen.findAllByText(/2 Shopify writes failed, 1 order failed to arrive\./)).length,
    ).toBeGreaterThan(0);
  });

  it('shows the singular write and the never wording', async () => {
    api.getConnectionFreshness.mockResolvedValue(
      answer(item({ failedCommands: 1, lastOrderAt: null, lastSweepAt: null })),
    );
    renderWithQuery(<ConnectionFreshnessLine />);
    expect((await screen.findAllByText(/1 Shopify write failed\./)).length).toBeGreaterThan(0);
    expect(screen.getByText(/no order yet, not checked yet/)).toBeVisible();
  });

  it('draws nothing without orders.view and does not ask the api', async () => {
    me.permissions = ['stock.view'];
    renderWithQuery(<ConnectionFreshnessLine />);
    await pause();
    expect(api.getConnectionFreshness).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('draws nothing while there is no connection', async () => {
    api.getConnectionFreshness.mockResolvedValue(answer());
    renderWithQuery(<ConnectionFreshnessLine />);
    await waitFor(() => expect(api.getConnectionFreshness).toHaveBeenCalled());
    await pause();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('reads in Arabic with the plural forms', async () => {
    api.getConnectionFreshness.mockResolvedValue(
      answer(item({ failedCommands: 2, failedOrderEvents: 1 })),
    );
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <ConnectionFreshnessLine />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('region', { name: 'حداثة بيانات Shopify' })).toBeVisible();
    expect(screen.getAllByText(/فشلت عمليتا كتابة إلى Shopify/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/تعذّر وصول طلب واحد/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/أخبر المدير\./).length).toBeGreaterThan(0);
    expect(screen.getByText(/منذ 3 دقائق/)).toBeVisible();
  });
});
