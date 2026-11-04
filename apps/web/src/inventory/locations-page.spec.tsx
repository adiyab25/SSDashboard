import type { LocationDetail } from '@ssdashboard/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LocationsPage } from './locations-page';
import { renderWithQuery } from './render-with-query';

const api = vi.hoisted(() => ({
  listLocations: vi.fn(),
  updateLocation: vi.fn(),
  setLocationArchived: vi.fn(),
  deleteLocation: vi.fn(),
}));
vi.mock('./inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted((): { current: { id: string; role: string } | null } => ({
  current: { id: 'a', role: 'admin' },
}));
vi.mock('@/auth/use-me', () => ({ useMe: () => me.current }));
vi.mock('@/shell/current-location', () => ({
  useLocationSwitcher: () => ({ retry: vi.fn(), locations: [] }),
}));

const location = (n: number, overrides: Partial<LocationDetail> = {}): LocationDetail => ({
  id: `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code: `LOC${n}`,
  name: { en: `Place ${n}` },
  type: 'warehouse',
  archived: false,
  updatedAt: '2026-11-03T10:00:00.654321Z',
  codeLocked: false,
  ...overrides,
});

const page = (items: LocationDetail[], nextCursor: string | null = null) => ({ items, nextCursor });

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = { id: 'a', role: 'admin' };
});

describe('LocationsPage (AC-4)', () => {
  it('says only administrators can manage locations, and asks the api for nothing, to staff', async () => {
    me.current = { id: 's', role: 'staff' };
    renderWithQuery(<LocationsPage />);

    expect(await screen.findByText('Only administrators can manage locations.')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(api.listLocations).not.toHaveBeenCalled();
  });

  it('lists active locations, switches to archived, and pages with Load more', async () => {
    api.listLocations.mockImplementation((status: string, cursor?: string) =>
      Promise.resolve(
        status === 'archived'
          ? page([location(9, { archived: true })])
          : cursor
            ? page([location(2)])
            : page([location(1)], 'next'),
      ),
    );
    renderWithQuery(<LocationsPage />);

    const table = await screen.findByRole('table', { name: 'Locations' });
    expect(await within(table).findByText('LOC1')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(table).findByText('LOC2')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('LOC9')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Unarchive LOC9' })).toBeVisible();
    expect(api.listLocations).toHaveBeenCalledWith('archived', undefined, expect.anything());
  });

  it('sends updatedAt as received, keeps a locked code read only, and offers Reload when stale', async () => {
    api.listLocations.mockResolvedValue(page([location(1, { codeLocked: true })]));
    api.updateLocation.mockRejectedValue(new ApiError(409, { code: 'STALE_RECORD' }));
    renderWithQuery(<LocationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit LOC1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit location LOC1' });
    expect(within(dialog).getByLabelText('Location code')).toHaveAttribute('readonly');
    expect(within(dialog).getByText(/The code is fixed because stock was posted/)).toBeVisible();

    await userEvent.type(within(dialog).getByLabelText('Name in English'), ' x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateLocation).toHaveBeenCalledWith(location(1).id, {
        updatedAt: '2026-11-03T10:00:00.654321Z',
        name: { en: 'Place 1 x', ar: '' },
      }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Someone else changed this location/,
    );

    api.listLocations.mockResolvedValue(
      page([location(1, { name: { en: 'Fresh' }, updatedAt: 'later' })]),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Fresh'),
    );
  });

  it('shows the stock on hand message when archive is refused', async () => {
    api.listLocations.mockResolvedValue(page([location(1)]));
    api.setLocationArchived.mockRejectedValue(new ApiError(409, { code: 'STOCK_ON_HAND' }));
    renderWithQuery(<LocationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Archive LOC1' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive location LOC1?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));

    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'This location still has stock on hand, so it cannot be archived.',
    );
  });

  it('shows the in use message when delete is refused, and deletes otherwise', async () => {
    api.listLocations.mockResolvedValue(page([location(1)]));
    api.deleteLocation.mockRejectedValueOnce(new ApiError(409, { code: 'IN_USE' }));
    renderWithQuery(<LocationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete LOC1' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete location LOC1?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/cannot be deleted/);

    api.deleteLocation.mockResolvedValueOnce(undefined);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.deleteLocation).toHaveBeenCalledTimes(2);
  });

  it('opens the existing new location dialog', async () => {
    api.listLocations.mockResolvedValue(page([]));
    renderWithQuery(<LocationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'New location' }));
    expect(await screen.findByRole('dialog', { name: 'New location' })).toBeVisible();
  });
});
