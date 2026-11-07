import type { SkuSummary } from '@ssdashboard/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { inventoryKeys } from '@/inventory/inventory-api';
import { renderWithQuery } from '@/inventory/render-with-query';
import { SkusPage } from './skus-page';

const api = vi.hoisted(() => ({
  listSkus: vi.fn(),
  getSku: vi.fn(),
  updateSku: vi.fn(),
  deleteSku: vi.fn(),
  getSkuUsage: vi.fn(),
  changeSkuCode: vi.fn(),
  setSkuArchived: vi.fn(),
}));
vi.mock('@/inventory/inventory-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(
  (): { current: { id: string; hats: string[]; permissions: string[] } | null } => ({
    current: {
      id: 'me',
      hats: ['warehouse'],
      permissions: ['stock.view', 'catalog.edit', 'stock.receive'],
    },
  }),
);
vi.mock('@/auth/use-me', () => ({
  useMeState: () => (me.current ? { status: 'ready', me: me.current } : { status: 'loading' }),
}));

const sku = (n: number, overrides: Partial<SkuSummary> = {}): SkuSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  productId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code: `SKU-${n}`,
  name: { en: `Item ${n}` },
  price: '12.50',
  archived: false,
  ...overrides,
});

const detail = (n: number) => ({
  ...sku(n),
  status: 'active' as const,
  updatedAt: '2026-11-03T10:00:00.123456Z',
});

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  me.current = {
    id: 'me',
    hats: ['warehouse'],
    permissions: ['stock.view', 'catalog.edit', 'stock.receive'],
  };
});

describe('SkusPage (AC-13)', () => {
  it('lists active SKUs, links each to its detail page, and has one h1', async () => {
    api.listSkus.mockResolvedValue({ items: [sku(1), sku(2)], nextCursor: null });
    renderWithQuery(<SkusPage />);

    const table = await screen.findByRole('table', { name: 'SKUs' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await within(table).findByRole('link', { name: 'SKU-1' })).toHaveAttribute(
      'href',
      `/skus/${sku(1).id}`,
    );
    expect(within(table).getByText('Item 2')).toBeVisible();
    expect(api.listSkus).toHaveBeenCalledWith('', 'active', undefined, expect.anything());
  });

  it('searches with q and switches to the archived filter', async () => {
    api.listSkus.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<SkusPage />);
    await screen.findByText(/No SKUs yet/);

    await userEvent.type(screen.getByLabelText('Search SKUs'), 'AB_');
    await waitFor(() =>
      expect(api.listSkus).toHaveBeenLastCalledWith('AB_', 'active', undefined, expect.anything()),
    );
    expect(await screen.findByText('No SKU matches this search.')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() =>
      expect(api.listSkus).toHaveBeenLastCalledWith(
        'AB_',
        'archived',
        undefined,
        expect.anything(),
      ),
    );
  });

  it('loads the next page with the cursor from Load more', async () => {
    api.listSkus
      .mockResolvedValueOnce({ items: [sku(1)], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [sku(2)], nextCursor: null });
    renderWithQuery(<SkusPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'SKU-2' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'SKU-1' })).toBeVisible();
    expect(api.listSkus).toHaveBeenLastCalledWith('', 'active', 'cursor-2', expect.anything());
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('SKU edit dialog (AC-2, AC-3)', () => {
  async function openEdit(n = 1) {
    api.listSkus.mockResolvedValue({ items: [sku(n)], nextCursor: null });
    renderWithQuery(<SkusPage />);
    await userEvent.click(await screen.findByRole('button', { name: `Edit SKU-${n}` }));
    return screen.findByRole('dialog', { name: 'Edit SKU SKU-1' });
  }

  it('sends updatedAt back exactly as received and only the changed fields (staff)', async () => {
    api.getSku.mockResolvedValue(detail(1));
    api.updateSku.mockResolvedValue({ ...detail(1), price: '15.00' });
    const dialog = await openEdit();

    expect(within(dialog).queryByText('Administrator actions')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete SKU' })).not.toBeInTheDocument();
    const price = within(dialog).getByLabelText(/Selling price/);
    await userEvent.clear(price);
    await userEvent.type(price, '15.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateSku).toHaveBeenCalledWith(detail(1).id, {
        updatedAt: '2026-11-03T10:00:00.123456Z',
        price: '15.00',
      }),
    );
    expect(api.getSkuUsage).not.toHaveBeenCalled();
  });

  it('accepts an Arabic price and sends it in Western digits (AC-18)', async () => {
    api.getSku.mockResolvedValue(detail(1));
    api.updateSku.mockResolvedValue({ ...detail(1), price: '15.50' });
    const dialog = await openEdit();

    const price = within(dialog).getByLabelText(/Selling price/);
    expect(price).toHaveAttribute('dir', 'ltr');
    await userEvent.clear(price);
    await userEvent.type(price, '١٥٫٥٠');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateSku).toHaveBeenCalledWith(detail(1).id, {
        updatedAt: '2026-11-03T10:00:00.123456Z',
        price: '15.50',
      }),
    );
  });

  it('shows the price error for a decimal comma (AC-18)', async () => {
    api.getSku.mockResolvedValue(detail(1));
    const dialog = await openEdit();

    const price = within(dialog).getByLabelText(/Selling price/);
    await userEvent.clear(price);
    await userEvent.type(price, '1,5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(
      await within(dialog).findByText('Enter 0 or more with at most 2 decimals.'),
    ).toBeVisible();
    expect(api.updateSku).not.toHaveBeenCalled();
  });

  it('shows the stale message with a Reload that fetches the latest version', async () => {
    api.getSku.mockResolvedValueOnce(detail(1));
    api.updateSku.mockRejectedValue(new ApiError(409, { code: 'STALE_RECORD' }));
    const dialog = await openEdit();

    await userEvent.type(within(dialog).getByLabelText('Name in English'), ' edited');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Someone else changed this SKU/,
    );

    api.getSku.mockResolvedValue({ ...detail(1), name: { en: 'Fresh name' }, updatedAt: 'later' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Fresh name'),
    );
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the version it opened with when the shared query refreshes mid edit', async () => {
    api.getSku.mockResolvedValue(detail(1));
    api.updateSku.mockResolvedValue({ ...detail(1), price: '15.00' });
    api.listSkus.mockResolvedValue({ items: [sku(1)], nextCursor: null });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SkusPage />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Edit SKU-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit SKU SKU-1' });
    await within(dialog).findByLabelText('Name in English');

    // A colleague renames the SKU and the detail page refetches it while this dialog is open.
    act(() => {
      client.setQueryData(inventoryKeys.sku(detail(1).id), {
        ...detail(1),
        name: { en: 'Colleague rename' },
        updatedAt: '2026-11-03T11:00:00.000000Z',
      });
    });

    const price = within(dialog).getByLabelText(/Selling price/);
    await userEvent.clear(price);
    await userEvent.type(price, '15.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateSku).toHaveBeenCalledWith(detail(1).id, {
        updatedAt: '2026-11-03T10:00:00.123456Z',
        price: '15.00',
      }),
    );
  });

  it('adopts the fresh fetch as the base while the form is untouched', async () => {
    const fresh = { ...detail(1), name: { en: 'Fresh name' }, updatedAt: 'later' };
    api.getSku.mockResolvedValue(fresh);
    api.updateSku.mockResolvedValue(fresh);
    api.listSkus.mockResolvedValue({ items: [sku(1)], nextCursor: null });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(inventoryKeys.sku(detail(1).id), detail(1));
    render(
      <QueryClientProvider client={client}>
        <SkusPage />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Edit SKU-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit SKU SKU-1' });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Fresh name'),
    );

    const price = within(dialog).getByLabelText(/Selling price/);
    await userEvent.clear(price);
    await userEvent.type(price, '15.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateSku).toHaveBeenCalledWith(detail(1).id, {
        updatedAt: 'later',
        price: '15.00',
      }),
    );
  });

  it('keeps the stale alert and the typed edits when Reload itself fails', async () => {
    api.getSku.mockResolvedValueOnce(detail(1));
    api.updateSku.mockRejectedValue(new ApiError(409, { code: 'STALE_RECORD' }));
    const dialog = await openEdit();

    await userEvent.type(within(dialog).getByLabelText('Name in English'), ' edited');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Someone else changed this SKU/,
    );

    api.getSku.mockRejectedValue(new ApiError(500, { code: 'INTERNAL' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.getSku).toHaveBeenCalledTimes(2));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Someone else changed this SKU/,
    );
    expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Item 1 edited');
  });

  it('hands focus back to the Edit button when the dialog closes (WCAG 2.4.3)', async () => {
    api.getSku.mockResolvedValue(detail(1));
    const dialog = await openEdit();
    await within(dialog).findByLabelText('Name in English');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit SKU-1' })).toHaveFocus());
  });

  describe('as an admin', () => {
    it('explains a locked code, disables it, and blocks archive while stock is on hand', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: true, canArchive: false });
      const dialog = await openEdit();

      const code = await within(dialog).findByLabelText('SKU code');
      await waitFor(() => expect(code).toBeDisabled());
      expect(
        within(dialog).getByText(/The code is fixed because this SKU has had stock/),
      ).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Change code' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Archive SKU' })).toBeDisabled();
      expect(within(dialog).getByText(/cannot be archived until it reaches zero/)).toBeVisible();
    });

    it('changes an unlocked code with updatedAt, and reports SKU_TAKEN on the field', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: false, canArchive: true });
      api.changeSkuCode.mockRejectedValue(new ApiError(409, { code: 'SKU_TAKEN' }));
      const dialog = await openEdit();

      const code = await within(dialog).findByLabelText('SKU code');
      await waitFor(() => expect(code).toBeEnabled());
      await userEvent.clear(code);
      await userEvent.type(code, 'new-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Change code' }));

      await waitFor(() =>
        expect(api.changeSkuCode).toHaveBeenCalledWith(detail(1).id, {
          updatedAt: '2026-11-03T10:00:00.123456Z',
          sku: 'NEW-1',
        }),
      );
      expect(await within(dialog).findByText('Another SKU already uses this code.')).toBeVisible();
    });

    it('reports STYLE_CODE_TAKEN on the code field, apart from SKU_TAKEN', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: false, canArchive: true });
      api.changeSkuCode.mockRejectedValue(new ApiError(409, { code: 'STYLE_CODE_TAKEN' }));
      const dialog = await openEdit();

      const code = await within(dialog).findByLabelText('SKU code');
      await waitFor(() => expect(code).toBeEnabled());
      await userEvent.clear(code);
      await userEvent.type(code, 'new-1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Change code' }));

      expect(
        await within(dialog).findByText(
          "This code is already used as another product's style code. Choose another code.",
        ),
      ).toBeVisible();
      expect(within(dialog).queryByText('Another SKU already uses this code.')).toBeNull();
    });

    it('shows the stock on hand message when archiving is refused', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: false, canArchive: true });
      api.setSkuArchived.mockRejectedValue(new ApiError(409, { code: 'STOCK_ON_HAND' }));
      const dialog = await openEdit();

      const archive = await within(dialog).findByRole('button', { name: 'Archive SKU' });
      await waitFor(() => expect(archive).toBeEnabled());
      await userEvent.click(archive);
      const confirm = await screen.findByRole('dialog', { name: 'Archive SKU SKU-1?' });
      await userEvent.click(within(confirm).getByRole('button', { name: 'Archive SKU' }));

      expect(await within(confirm).findByRole('alert')).toHaveTextContent(
        'This SKU still has stock on hand, so it cannot be archived.',
      );
      expect(api.setSkuArchived).toHaveBeenCalledWith(detail(1).id, true);
    });

    it('shows the in use message when delete is refused', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: true, canArchive: true });
      api.deleteSku.mockRejectedValue(new ApiError(409, { code: 'IN_USE' }));
      const dialog = await openEdit();

      await userEvent.click(await within(dialog).findByRole('button', { name: 'Delete SKU' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete SKU SKU-1?' });
      await userEvent.click(within(confirm).getByRole('button', { name: 'Delete SKU' }));

      expect(await within(confirm).findByRole('alert')).toHaveTextContent(/cannot be deleted/);
    });

    it('Escape in the confirm step closes only that step and keeps the typed edits', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: false, canArchive: true });
      const dialog = await openEdit();

      await userEvent.type(within(dialog).getByLabelText('Name in English'), ' edited');
      const archive = await within(dialog).findByRole('button', { name: 'Archive SKU' });
      await waitFor(() => expect(archive).toBeEnabled());
      await userEvent.click(archive);
      const confirm = await screen.findByRole('dialog', { name: 'Archive SKU SKU-1?' });

      await userEvent.keyboard('{Escape}');

      await waitFor(() => expect(confirm).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: 'Edit SKU SKU-1' })).toBeVisible();
      expect(screen.getByLabelText('Name in English')).toHaveValue('Item 1 edited');
      // Focus returns to the button that opened the confirm step.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Archive SKU' })).toHaveFocus(),
      );
    });

    it('names the confirm close icon Close and keeps one control named Cancel', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue(detail(1));
      api.getSkuUsage.mockResolvedValue({ codeLocked: true, canArchive: true });
      const dialog = await openEdit();

      await userEvent.click(await within(dialog).findByRole('button', { name: 'Delete SKU' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete SKU SKU-1?' });

      expect(within(confirm).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
      expect(within(confirm).getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    });

    it('offers Unarchive for an archived SKU', async () => {
      me.current = {
        id: 'a',
        hats: ['manager'],
        permissions: [
          'catalog.manage',
          'catalog.edit',
          'stock.receive',
          'stock.view',
          'cost.view',
          'people.manage',
          'stock.correct',
        ],
      };
      api.getSku.mockResolvedValue({ ...detail(1), archived: true, status: 'archived' });
      api.getSkuUsage.mockResolvedValue({ codeLocked: true, canArchive: true });
      const dialog = await openEdit();

      expect(await within(dialog).findByRole('button', { name: 'Unarchive SKU' })).toBeEnabled();
      expect(within(dialog).queryByRole('button', { name: 'Archive SKU' })).not.toBeInTheDocument();
    });
  });
});
