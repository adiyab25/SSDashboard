import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { modulesAnswer, stateView } from './module-fixtures';
import { ModulePageGate } from './module-page-gate';

const api = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('./module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

let pathname = '/stock';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

afterEach(() => {
  api.getModuleStates.mockReset();
  pathname = '/stock';
});

/**
 * Waits until the module states query has succeeded (not only been called) and React has drawn
 * the answer, so an absence check looks at the settled screen.
 */
async function settled() {
  await waitFor(() => expect(api.getModuleStates).toHaveBeenCalled());
  await waitFor(() => expect(api.getModuleStates.mock.results[0]?.value).toBeDefined());
  await act(async () => {
    await api.getModuleStates.mock.results[0]?.value;
  });
}

describe('ModulePageGate (spec 0009, AC-9)', () => {
  it('shows the page untouched while the states are not in', () => {
    api.getModuleStates.mockReturnValue(new Promise(() => {}));
    renderWithQuery(
      <ModulePageGate>
        <h1>Stock page</h1>
      </ModulePageGate>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Stock page' })).toBeVisible();
  });

  it('replaces an off page with the not available state: one h1, no page body', async () => {
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({
        modules: [stateView({ key: 'inventory', state: 'off', reason: 'toggled_off' })],
      }),
    );
    renderWithQuery(
      <ModulePageGate>
        <h1>Stock page</h1>
      </ModulePageGate>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Stock on hand' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Not available on this install')).toBeVisible();
    expect(screen.getByText(/It was switched off in Settings/)).toBeVisible();
    expect(screen.queryByText('Stock page')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the overview' })).toHaveAttribute('href', '/');
  });

  it('shows the read only notice with its date above the page', async () => {
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({
        modules: [
          stateView({
            key: 'inventory',
            state: 'read_only',
            since: '2026-11-01T22:00:00.000Z',
            reason: 'lapsed',
          }),
        ],
      }),
    );
    renderWithQuery(
      <ModulePageGate>
        <h1>Stock page</h1>
      </ModulePageGate>,
    );

    const notice = await screen.findByRole('region', { name: 'Module notice' });
    expect(notice).toHaveTextContent(/Read only since .*2026/);
    expect(notice).toHaveTextContent('Ask a person who manages settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Stock page' })).toBeVisible();
  });

  it('says only records from before the date can be finished while limited', async () => {
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({
        modules: [
          stateView({
            key: 'inventory',
            state: 'limited',
            before: '2026-11-01T22:00:00.000Z',
            reason: 'toggled_off',
          }),
        ],
      }),
    );
    renderWithQuery(
      <ModulePageGate>
        <p>Body</p>
      </ModulePageGate>,
    );
    const notice = await screen.findByRole('region', { name: 'Module notice' });
    expect(notice).toHaveTextContent(/Only records from before .*2026.* can be finished here/);
    expect(screen.getByText('Body')).toBeVisible();
  });

  it('leaves an address without a navigation entry alone', async () => {
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({ modules: [stateView({ key: 'inventory', state: 'off', reason: null })] }),
    );
    pathname = '/somewhere-else';
    renderWithQuery(
      <ModulePageGate>
        <p>Body</p>
      </ModulePageGate>,
    );
    await settled();
    expect(screen.getByText('Body')).toBeVisible();
  });

  it('shows no notice for an on module, and none when the answer does not list it', async () => {
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({ modules: [stateView({ key: 'inventory' })] }),
    );
    renderWithQuery(
      <ModulePageGate>
        <p>Body</p>
      </ModulePageGate>,
    );
    await settled();
    expect(screen.queryByRole('region', { name: 'Module notice' })).not.toBeInTheDocument();
    expect(screen.getByText('Body')).toBeVisible();
  });

  it('reads in Arabic', async () => {
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({ modules: [stateView({ key: 'inventory', state: 'off', reason: 'lapsed' })] }),
    );
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <ModulePageGate>
            <p>Body</p>
          </ModulePageGate>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('غير متاحة في هذا التثبيت')).toBeVisible();
    expect(screen.getByText(/انتهى ترخيصها/)).toBeVisible();
  });
});
