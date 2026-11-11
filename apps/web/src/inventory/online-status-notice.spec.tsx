import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { OnlineStatusNotice } from './online-status-notice';

const api = vi.hoisted(() => ({ getOnlineStatus: vi.fn() }));
vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(() => ({ permissions: ['stock.view', 'catalog.manage'] as string[] }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'a', hats: ['manager'], permissions: me.permissions },
  }),
}));

afterEach(() => {
  api.getOnlineStatus.mockReset();
  me.permissions = ['stock.view', 'catalog.manage'];
});

const LINE = 'No location feeds online stock: Shopify is not being updated';

/** Waits for the status read and a beat after it, so an absence check sees the settled screen. */
async function settled() {
  await waitFor(() => expect(api.getOnlineStatus).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('OnlineStatusNotice (spec 0011 AC-20)', () => {
  it('says Shopify is not being updated, with a link to the gate for catalog.manage', async () => {
    api.getOnlineStatus.mockResolvedValue({ onlineLocation: null });
    renderWithQuery(<OnlineStatusNotice linkToGate />);

    expect(await screen.findByText(LINE)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the online gate' })).toHaveAttribute(
      'href',
      '/locations',
    );
  });

  it('shows the line without the link for a person without catalog.manage', async () => {
    me.permissions = ['stock.view'];
    api.getOnlineStatus.mockResolvedValue({ onlineLocation: null });
    renderWithQuery(<OnlineStatusNotice linkToGate />);

    expect(await screen.findByText(LINE)).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('draws nothing while a location feeds online stock', async () => {
    api.getOnlineStatus.mockResolvedValue({
      onlineLocation: {
        id: '50000000-0000-4000-8000-000000000001',
        code: 'MAIN',
        name: { en: 'Main' },
      },
    });
    renderWithQuery(<OnlineStatusNotice linkToGate />);

    await settled();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('says the status could not be loaded, with Try again, instead of drawing nothing (AC-16)', async () => {
    api.getOnlineStatus.mockRejectedValueOnce(new Error('down'));
    api.getOnlineStatus.mockResolvedValue({ onlineLocation: null });
    renderWithQuery(<OnlineStatusNotice linkToGate />);

    expect(await screen.findByText('Online stock status could not be loaded')).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(LINE)).toBeVisible();
    expect(screen.queryByText('Online stock status could not be loaded')).toBeNull();
  });
});
