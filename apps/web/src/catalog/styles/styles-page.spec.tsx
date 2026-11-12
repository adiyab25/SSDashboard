import type { StyleSummary } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { StylesPage } from './styles-page';

const api = vi.hoisted(() => ({
  listStyles: vi.fn(),
  listGroupingChoices: vi.fn(),
  assignStyles: vi.fn(),
}));
vi.mock('@/catalog/catalog-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
const refetch = vi.hoisted(() => ({ refetchAfterWrite: vi.fn(() => Promise.resolve()) }));
vi.mock('@/api/refetch-after-write', () => refetch);
vi.mock('@/shell/client-config', () => ({ loadConfig: () => new Promise(() => undefined) }));

type Person = { id: string; hats: string[]; permissions: string[] };
const EDITOR: Person = {
  id: 'me',
  hats: ['warehouse'],
  permissions: ['stock.view', 'catalog.edit'],
};
const me = vi.hoisted((): { current: Person } => ({
  current: { id: 'me', hats: ['warehouse'], permissions: ['stock.view', 'catalog.edit'] },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));

const SEASON = {
  id: '30000000-0000-4000-8000-000000000001',
  code: 'SS27',
  name: { en: 'Summer 27', ar: 'صيف 27' },
};
const GROUP = {
  id: '20000000-0000-4000-8000-000000000002',
  code: 'TOPS',
  name: { en: 'Tops', ar: 'قمصان' },
};
const MAIN = { id: '20000000-0000-4000-8000-000000000001', code: 'MAIN', name: { en: 'Main' } };

const style = (n: number, overrides: Partial<StyleSummary> = {}): StyleSummary => ({
  id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code: `TEE${n}`,
  name: { en: `Tee ${n}`, ar: `تيشيرت ${n}` },
  season: SEASON,
  productGroup: GROUP,
  activeVariantCount: 3,
  archived: false,
  ...overrides,
});

const inArabic = (ui: ReactNode) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

function arrange(rows: StyleSummary[] = [style(1), style(2, { season: null })]) {
  api.listStyles.mockResolvedValue({ items: rows, nextCursor: null });
  api.listGroupingChoices.mockImplementation((kind: string) =>
    Promise.resolve(kind === 'season' ? [SEASON] : [MAIN, GROUP]),
  );
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  refetch.refetchAfterWrite.mockClear();
  me.current = EDITOR;
});

describe('StylesPage list and filters (spec 0012, AC-8, AC-18)', () => {
  it('lists styles with code links, season ("No season"), group, and active SKUs', async () => {
    arrange();
    renderWithQuery(<StylesPage />);
    const table = await screen.findByRole('table', { name: 'Styles' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const first = within(table).getByRole('row', { name: /TEE1/ });
    expect(within(first).getByRole('link', { name: 'TEE1' })).toHaveAttribute(
      'href',
      `/styles/${style(1).id}`,
    );
    expect(within(first).getByText('Summer 27')).toBeVisible();
    expect(within(first).getByText('Tops')).toBeVisible();
    expect(within(first).getByText('3')).toBeVisible();
    expect(
      within(within(table).getByRole('row', { name: /TEE2/ })).getByText('No season'),
    ).toBeVisible();
    expect(api.listStyles).toHaveBeenCalledWith(
      { q: '', status: 'active' },
      undefined,
      expect.anything(),
    );
  });

  it('loads the filter choices from the seasons and groups lists and sends the filters', async () => {
    arrange();
    renderWithQuery(<StylesPage />);
    await screen.findByRole('table', { name: 'Styles' });
    expect(api.listGroupingChoices).toHaveBeenCalledWith('season', expect.anything());
    expect(api.listGroupingChoices).toHaveBeenCalledWith('productGroup', expect.anything());

    const season = screen.getByLabelText('Season');
    await waitFor(() =>
      expect(within(season).getByRole('option', { name: 'Summer 27' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(season, 'none');
    await userEvent.selectOptions(screen.getByLabelText('Group'), GROUP.id);
    await userEvent.type(screen.getByLabelText('Style code, name, or SKU'), 'tee');
    await waitFor(() =>
      expect(api.listStyles).toHaveBeenLastCalledWith(
        { q: 'tee', status: 'active', seasonId: 'none', productGroupId: GROUP.id },
        undefined,
        expect.anything(),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() =>
      expect(api.listStyles).toHaveBeenLastCalledWith(
        { q: 'tee', status: 'archived', seasonId: 'none', productGroupId: GROUP.id },
        undefined,
        expect.anything(),
      ),
    );
  });

  it('shows the empty, no match, and error states', async () => {
    api.listGroupingChoices.mockResolvedValue([]);
    api.listStyles.mockResolvedValue({ items: [], nextCursor: null });
    const view = renderWithQuery(<StylesPage />);
    expect(await screen.findByText('No styles yet')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Style code, name, or SKU'), 'zzz');
    expect(await screen.findByText('No style matches this search.')).toBeVisible();
    view.unmount();

    api.listStyles.mockRejectedValue(new Error('down'));
    renderWithQuery(<StylesPage />);
    expect(await screen.findByText('The styles could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('reads in Arabic', async () => {
    arrange();
    renderWithQuery(inArabic(<StylesPage />));
    const table = await screen.findByRole('table', { name: 'الموديلات' });
    const first = within(table).getByRole('row', { name: /TEE1/ });
    expect(within(first).getByText('تيشيرت 1')).toBeVisible();
    expect(within(first).getByText('صيف 27')).toBeVisible();
    expect(
      within(within(table).getByRole('row', { name: /TEE2/ })).getByText('بدون موسم'),
    ).toBeVisible();
    expect(screen.getByLabelText('رمز الموديل أو الاسم أو رمز الصنف')).toBeVisible();
    expect(screen.getByRole('button', { name: 'تحديد الموسم' })).toBeVisible();
  });
});

describe('StylesPage bulk assign (spec 0012, AC-9)', () => {
  async function select(...codes: string[]) {
    arrange();
    renderWithQuery(<StylesPage />);
    const table = await screen.findByRole('table', { name: 'Styles' });
    for (const code of codes) {
      await userEvent.click(within(table).getByRole('checkbox', { name: `Select style ${code}` }));
    }
    return table;
  }

  it('sets one season on the selected styles and refreshes after the write', async () => {
    await select('TEE1', 'TEE2');
    expect(screen.getByText('Selected styles: 2')).toBeVisible();
    api.assignStyles.mockResolvedValue({ updated: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Set season' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set season' });
    expect(within(dialog).getByText(/Selected styles: 2\./)).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByText('Choose a season, or No season.')).toBeVisible();
    expect(api.assignStyles).not.toHaveBeenCalled();

    await userEvent.selectOptions(within(dialog).getByLabelText('Season'), SEASON.id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(api.assignStyles).toHaveBeenCalledWith({
        styleIds: [style(1).id, style(2).id],
        seasonId: SEASON.id,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Selected styles: 0')).toBeVisible();
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
  });

  it('sends No season as null and a group as productGroupId', async () => {
    await select('TEE1');
    api.assignStyles.mockResolvedValue({ updated: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Set season' }));
    let dialog = await screen.findByRole('dialog', { name: 'Set season' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Season'), 'none');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(api.assignStyles).toHaveBeenLastCalledWith({
        styleIds: [style(1).id],
        seasonId: null,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set group' }));
    dialog = await screen.findByRole('dialog', { name: 'Set group' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Product group'), MAIN.id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(api.assignStyles).toHaveBeenLastCalledWith({
        styleIds: [style(1).id, style(2).id],
        productGroupId: MAIN.id,
      }),
    );
  });

  it('names the styles the api no longer finds, and words ARCHIVED and INVALID_INPUT', async () => {
    await select('TEE1', 'TEE2');
    api.assignStyles.mockRejectedValueOnce(
      new ApiError(404, { code: 'NOT_FOUND', missingIds: [style(2).id] }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set group' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set group' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Product group'), GROUP.id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Some selected styles no longer exist: TEE2. Nothing was changed. The list is reloaded, so select again.',
    );
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles'],
    });

    for (const [code, message] of [
      ['ARCHIVED', 'That season or group is archived. Nothing was changed. Choose an active one.'],
      ['INVALID_INPUT', 'Choose 1 to 200 styles and a season or a group.'],
    ] as const) {
      api.assignStyles.mockRejectedValueOnce(new ApiError(422, { code }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
    }
  });

  async function failAssign(error: ApiError) {
    api.assignStyles.mockRejectedValueOnce(error);
    await userEvent.click(screen.getByRole('button', { name: 'Set group' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set group' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Product group'), GROUP.id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await within(dialog).findByRole('alert');
    return dialog;
  }

  it('drops the styles the api did not find from the selection', async () => {
    await select('TEE1', 'TEE2');
    const dialog = await failAssign(
      new ApiError(404, { code: 'NOT_FOUND', missingIds: [style(2).id] }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Selected styles: 1')).toBeVisible();
  });

  it('words a missing style without a code list when the api names none', async () => {
    await select('TEE1');
    const dialog = await failAssign(new ApiError(404, { code: 'NOT_FOUND' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Some selected styles no longer exist. Nothing was changed. The list is reloaded, so select again.',
    );
  });

  it('refreshes the season and group choices when the api says one is archived', async () => {
    await select('TEE1');
    await failAssign(new ApiError(422, { code: 'ARCHIVED' }));
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['seasons'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['product-groups'],
    });
  });

  it('refuses more than 200 selected styles: the bulk steps are disabled and say why', async () => {
    arrange(Array.from({ length: 201 }, (_, index) => style(index + 1)));
    renderWithQuery(<StylesPage />);
    const table = await screen.findByRole('table', { name: 'Styles' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    expect(screen.getByText('Selected styles: 201')).toBeVisible();
    expect(screen.getByText('Select at most 200 styles at a time.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set season' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Set group' })).toBeDisabled();
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select style TEE201' }));
    expect(screen.getByText('Selected styles: 200')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set group' })).toBeEnabled();
  }, 20_000);

  it('clears the selection when a filter changes', async () => {
    await select('TEE1');
    expect(screen.getByText('Selected styles: 1')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.getByText('Selected styles: 0')).toBeVisible();
  });

  it('offers no selection or bulk steps without catalog.edit', async () => {
    me.current = { id: 'me', hats: ['support'], permissions: ['stock.view'] };
    arrange();
    renderWithQuery(<StylesPage />);
    const table = await screen.findByRole('table', { name: 'Styles' });
    expect(within(table).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set season' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set group' })).toBeNull();
  });

  it('shows the no access state without stock.view and asks for nothing', async () => {
    me.current = { id: 'me', hats: ['media_buyer'], permissions: ['campaigns.view'] };
    renderWithQuery(<StylesPage />);
    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Styles' })).toBeVisible();
    expect(api.listStyles).not.toHaveBeenCalled();
    expect(api.listGroupingChoices).not.toHaveBeenCalled();
  });
});
