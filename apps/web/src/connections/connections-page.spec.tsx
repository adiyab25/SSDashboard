import type { ConnectionListItem } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { visibleNavItems } from '@/shell/nav';
import { ConnectionsPage } from './connections-page';

const api = vi.hoisted(() => ({ listConnections: vi.fn() }));
vi.mock('./connections-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: { id: 'a', hats: ['manager'], permissions: ['settings.manage'] },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const connection = (
  n: number,
  overrides: Partial<ConnectionListItem> = {},
): ConnectionListItem => ({
  id: `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  label: `Store ${n}`,
  provider: 'shopify',
  storeCode: `S${n}`,
  status: 'active',
  health: 'ok',
  healthReason: null,
  healthWarnings: [],
  freshness: { lastInboundAt: null, lastOrderAt: null, lastSweepAt: null },
  ...overrides,
});

const page = (items: ConnectionListItem[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
});

afterEach(() => {
  api.listConnections.mockReset();
  me.current = { id: 'a', hats: ['manager'], permissions: ['settings.manage'] };
});

describe('ConnectionsPage (spec 0015, AC-1, AC-27)', () => {
  it('shows the no access state, and asks the api for nothing, without settings.manage', async () => {
    me.current = { id: 's', hats: ['support'], permissions: ['orders.view'] };
    renderWithQuery(<ConnectionsPage />);

    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(api.listConnections).not.toHaveBeenCalled();
  });

  it('lists rows with the reason and the warnings in words, and pages with Load more', async () => {
    api.listConnections.mockImplementation((cursor?: string) =>
      Promise.resolve(
        cursor
          ? page([connection(3)])
          : page(
              [
                connection(1, {
                  health: 'failing',
                  healthReason: 'APP_NOT_INSTALLED',
                  status: 'paused',
                }),
                connection(2, { healthWarnings: ['SHOP_TIMEZONE_DIFFERS', 'APP_OWNED_BY_PERSON'] }),
              ],
              'next',
            ),
      ),
    );
    renderWithQuery(<ConnectionsPage />);

    const table = await screen.findByRole('table', { name: 'Connections' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await within(table).findByText('Store 1')).toBeVisible();
    expect(within(table).getByText('S1')).toBeVisible();
    expect(within(table).getAllByText('Shopify')).toHaveLength(2);
    expect(within(table).getByText('Paused')).toBeVisible();
    expect(within(table).getByText('Not working')).toBeVisible();
    expect(
      within(table).getByText(
        /not installed on this store, or the app and the store belong to different Shopify organizations/,
      ),
    ).toBeVisible();
    expect(within(table).getByText(/time zone of this install/)).toBeVisible();
    expect(within(table).getByText(/belongs to a person/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Connect a Shopify store' })).toHaveAttribute(
      'href',
      '/connections/new',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(table).findByText('Store 3')).toBeVisible();
    expect(api.listConnections).toHaveBeenLastCalledWith('next', expect.anything());
  });

  it('shows the empty state', async () => {
    api.listConnections.mockResolvedValue(page([]));
    renderWithQuery(<ConnectionsPage />);

    expect(await screen.findByText('No connections yet')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error with Try again when the list fails', async () => {
    api.listConnections.mockRejectedValueOnce(new Error('down'));
    renderWithQuery(<ConnectionsPage />);

    expect(await screen.findByText(/could not be loaded/)).toBeVisible();
    api.listConnections.mockResolvedValue(page([connection(1)]));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Store 1')).toBeVisible();
  });

  it('reads in Arabic, with every reason and warning translated', async () => {
    api.listConnections.mockResolvedValue(
      page([
        connection(1, {
          health: 'degraded',
          healthReason: 'WEBHOOKS_MISSING',
          healthWarnings: ['APP_OWNED_BY_PERSON'],
        }),
      ]),
    );
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    renderWithQuery(
      <I18nextProvider i18n={i18n}>
        <ConnectionsPage />
      </I18nextProvider>,
    );

    const table = await screen.findByRole('table', { name: 'الروابط' });
    expect(await within(table).findByText('يحتاج إلى انتباه')).toBeVisible();
    expect(within(table).getByText(/لم تُسجَّل بعض الرسائل/)).toBeVisible();
    expect(within(table).getByText(/مملوك لحساب شخص/)).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('الربط');
  });
});

describe('Connections navigation entry', () => {
  it('shows to managers only', () => {
    const ids = (permissions: Parameters<typeof visibleNavItems>[0]) =>
      visibleNavItems(permissions).map((item) => item.id);
    expect(ids(['settings.manage'])).toContain('connections');
    expect(ids(['orders.view'])).not.toContain('connections');
    expect(ids(undefined)).not.toContain('connections');
  });
});
