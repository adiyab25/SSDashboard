import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { modulesAnswer, stateView } from './module-fixtures';
import { StockOutSourceNotice } from './stock-out-source-notice';

const api = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('./module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

afterEach(() => api.getModuleStates.mockReset());

const waiting = modulesAnswer({
  capabilities: [
    stateView({
      key: 'connectors.shopify.stock_push',
      state: 'read_only',
      reason: 'no_stock_out_source',
    }),
  ],
});

/** Waits until the module states answer is drawn, so an absence check looks at the settled screen. */
async function settled() {
  await waitFor(() => expect(api.getModuleStates).toHaveBeenCalled());
  await act(async () => {
    await api.getModuleStates.mock.results[0]?.value;
  });
}

describe('StockOutSourceNotice (spec 0009, AC-29, W9)', () => {
  it('says online sales are not deducted while the stock push waits for a stock out source', async () => {
    api.getModuleStates.mockResolvedValue(waiting);
    renderWithQuery(<StockOutSourceNotice />);
    expect(
      await screen.findByText('Online sales are not deducted from stock on this install yet.'),
    ).toBeVisible();
  });

  it('draws nothing when the stock push is unknown (not built yet), on, or off for another reason', async () => {
    for (const answer of [
      modulesAnswer(),
      modulesAnswer({
        capabilities: [stateView({ key: 'connectors.shopify.stock_push', state: 'on' })],
      }),
      modulesAnswer({
        capabilities: [
          stateView({
            key: 'connectors.shopify.stock_push',
            state: 'off',
            reason: 'not_licensed',
          }),
        ],
      }),
    ]) {
      api.getModuleStates.mockResolvedValue(answer);
      const { unmount } = renderWithQuery(<StockOutSourceNotice />);
      await settled();
      expect(screen.queryByText(/not deducted from stock/)).toBeNull();
      unmount();
      api.getModuleStates.mockReset();
    }
  });

  it('draws nothing while the states are not in', async () => {
    api.getModuleStates.mockReturnValue(new Promise(() => undefined));
    renderWithQuery(<StockOutSourceNotice />);
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('draws nothing when the states fail', async () => {
    api.getModuleStates.mockRejectedValue(new Error('down'));
    renderWithQuery(<StockOutSourceNotice />);
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalled());
    // Wait for the rejection itself to settle before looking at the screen.
    await act(async () => {
      const answer = api.getModuleStates.mock.results[0]?.value as Promise<unknown> | undefined;
      await answer?.catch(() => undefined);
    });
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('names its landmark as the online stock notice', async () => {
    api.getModuleStates.mockResolvedValue(waiting);
    renderWithQuery(<StockOutSourceNotice />);
    expect(await screen.findByRole('region', { name: 'Online stock notice' })).toBeVisible();
  });

  it('reads in Arabic', async () => {
    api.getModuleStates.mockResolvedValue(waiting);
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <StockOutSourceNotice />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText('المبيعات الإلكترونية لا تُخصم من المخزون في هذا التثبيت بعد.'),
    ).toBeVisible();
  });
});
