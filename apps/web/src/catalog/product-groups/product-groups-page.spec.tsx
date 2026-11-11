import type { ProductGroup } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { ProductGroupsPage } from './product-groups-page';

const api = vi.hoisted(() => ({
  listGroupings: vi.fn(),
  createGrouping: vi.fn(),
  updateGrouping: vi.fn(),
  setGroupingArchived: vi.fn(),
  deleteGrouping: vi.fn(),
}));
vi.mock('@/catalog/catalog-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
const refetch = vi.hoisted(() => ({ refetchAfterWrite: vi.fn(() => Promise.resolve()) }));
vi.mock('@/api/refetch-after-write', () => refetch);

const MANAGER = { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] };
const me = vi.hoisted(() => ({
  current: { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));

const group = (n: number, overrides: Partial<ProductGroup> = {}): ProductGroup => ({
  id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code: `G${n}`,
  name: { en: `Group ${n}`, ar: `مجموعة ${n}` },
  archived: false,
  protected: false,
  updatedAt: '2026-11-03T10:00:00.123456Z',
  ...overrides,
});
const MAIN = group(0, { code: 'MAIN', name: { en: 'Main', ar: 'الرئيسية' }, protected: true });
const TOPS = group(2, { code: 'TOPS', name: { en: 'Tops', ar: 'قمصان' } });

const inArabic = (ui: ReactNode) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  refetch.refetchAfterWrite.mockClear();
  me.current = MANAGER;
});

async function openList() {
  api.listGroupings.mockResolvedValue({ items: [MAIN, TOPS], nextCursor: null });
  renderWithQuery(<ProductGroupsPage />);
  return screen.findByRole('table', { name: 'Product groups' });
}

describe('ProductGroupsPage (spec 0012, AC-7, AC-18)', () => {
  it('lists groups with no dates column, and MAIN says why it cannot be archived', async () => {
    const table = await openList();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(api.listGroupings).toHaveBeenCalledWith(
      'productGroup',
      'active',
      undefined,
      expect.anything(),
    );
    expect(within(table).queryByRole('columnheader', { name: 'Dates' })).toBeNull();
    const main = within(table).getByRole('row', { name: /MAIN/ });
    expect(
      within(main).getByText(
        'Built in group: you can rename it, but not archive, delete, or recode it.',
      ),
    ).toBeVisible();
    expect(within(main).queryByRole('button', { name: /Archive|Delete/ })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Delete product group TOPS' })).toBeVisible();
  });

  it('creates a group without dates and words a taken code', async () => {
    await openList();
    api.createGrouping.mockRejectedValueOnce(
      new ApiError(409, { code: 'PRODUCT_GROUP_CODE_TAKEN' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'New product group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New product group' });
    expect(within(dialog).queryByLabelText(/Starts on/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Code'), 'tops');
    await userEvent.type(within(dialog).getByLabelText('Name in Arabic'), 'قمصان');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(
      await within(dialog).findByText('Another product group already uses this code.'),
    ).toBeVisible();
    expect(api.createGrouping).toHaveBeenCalledWith('productGroup', {
      code: 'TOPS',
      name: { en: '', ar: 'قمصان' },
    });

    api.createGrouping.mockResolvedValueOnce(group(3, { code: 'DRESS' }));
    const code = within(dialog).getByLabelText('Code');
    await userEvent.clear(code);
    await userEvent.type(code, 'DRESS');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['product-groups'],
    });
  });

  it('words the protected, invalid, and stale answers on an edit', async () => {
    const table = await openList();
    for (const [code, message] of [
      [
        'PRODUCT_GROUP_PROTECTED',
        'The built in product group cannot be archived, deleted, or recoded.',
      ],
      ['INVALID_INPUT', 'Check the code and the name, then try again.'],
      [
        'STALE_RECORD',
        'Someone changed this product group since you opened it. Reload to see their change, then edit again.',
      ],
    ] as const) {
      api.updateGrouping.mockRejectedValueOnce(new ApiError(409, { code }));
      await userEvent.click(within(table).getByRole('button', { name: 'Edit product group TOPS' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit product group TOPS' });
      const name = within(dialog).getByLabelText('Name in English');
      await userEvent.clear(name);
      await userEvent.type(name, 'Shirts');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('unarchives an archived group after confirming', async () => {
    const archived = group(4, { code: 'OLD', archived: true });
    api.listGroupings.mockResolvedValue({ items: [archived], nextCursor: null });
    api.setGroupingArchived.mockResolvedValue({ ...archived, archived: false });
    renderWithQuery(<ProductGroupsPage />);
    const table = await screen.findByRole('table', { name: 'Product groups' });
    await userEvent.click(
      within(table).getByRole('button', { name: 'Unarchive product group OLD' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Unarchive product group OLD?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() =>
      expect(api.setGroupingArchived).toHaveBeenCalledWith('productGroup', archived.id, false),
    );
    await waitFor(() =>
      expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
        queryKey: ['product-groups'],
      }),
    );
  });

  it('shows the no access state without catalog.manage and asks for nothing', async () => {
    me.current = { id: 'me', hats: ['warehouse'], permissions: ['stock.view', 'catalog.edit'] };
    renderWithQuery(<ProductGroupsPage />);
    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(api.listGroupings).not.toHaveBeenCalled();
  });

  it('reads in Arabic', async () => {
    api.listGroupings.mockResolvedValue({ items: [MAIN, TOPS], nextCursor: null });
    renderWithQuery(inArabic(<ProductGroupsPage />));
    const table = await screen.findByRole('table', { name: 'مجموعات المنتجات' });
    expect(within(table).getByText('قمصان')).toBeVisible();
    expect(within(table).getAllByText('أساسي').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'مجموعة منتجات جديدة' })).toBeVisible();
  });
});
