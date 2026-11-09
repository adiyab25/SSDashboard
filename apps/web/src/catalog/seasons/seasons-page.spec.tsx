import type { Season } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { SeasonsPage } from './seasons-page';

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
vi.mock('@/shell/client-config', () => ({ loadConfig: () => new Promise(() => undefined) }));

const MANAGER = { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] };
const me = vi.hoisted(() => ({
  current: { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));

const season = (n: number, overrides: Partial<Season> = {}): Season => ({
  id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code: `SS2${n}`,
  name: { en: `Summer 2${n}`, ar: `صيف 2${n}` },
  startsOn: null,
  endsOn: null,
  archived: false,
  protected: false,
  updatedAt: '2026-11-03T10:00:00.123456Z',
  ...overrides,
});
const CORE = season(0, { code: 'CORE', name: { en: 'Core', ar: 'أساسي' }, protected: true });

const inArabic = (ui: ReactNode) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  refetch.refetchAfterWrite.mockClear();
  me.current = MANAGER;
});

async function openList(rows: Season[] = [CORE, season(7)]) {
  api.listGroupings.mockResolvedValue({ items: rows, nextCursor: null });
  renderWithQuery(<SeasonsPage />);
  return screen.findByRole('table', { name: 'Seasons' });
}

describe('SeasonsPage (spec 0012, AC-6, AC-18)', () => {
  it('lists active seasons with one h1, and the CORE row says why it cannot be archived', async () => {
    const table = await openList();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(api.listGroupings).toHaveBeenCalledWith(
      'season',
      'active',
      undefined,
      expect.anything(),
    );
    const core = within(table).getByRole('row', { name: /CORE/ });
    expect(within(core).getByText('Built in')).toBeVisible();
    expect(
      within(core).getByText(
        'Built in season: you can rename it, but not archive, delete, or recode it.',
      ),
    ).toBeVisible();
    expect(within(core).queryByRole('button', { name: /Archive/ })).toBeNull();
    expect(within(core).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(core).getByRole('button', { name: 'Edit season CORE' })).toBeVisible();
    const other = within(table).getByRole('row', { name: /SS27/ });
    expect(within(other).getByRole('button', { name: 'Archive season SS27' })).toBeVisible();
    expect(within(other).getByText('SS27', { selector: 'bdi' })).toHaveAttribute('dir', 'ltr');
  });

  it('switches to the archived and all lists', async () => {
    await openList();
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() =>
      expect(api.listGroupings).toHaveBeenLastCalledWith(
        'season',
        'archived',
        undefined,
        expect.anything(),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() =>
      expect(api.listGroupings).toHaveBeenLastCalledWith(
        'season',
        'all',
        undefined,
        expect.anything(),
      ),
    );
  });

  it('shows the empty state and the error state with a retry', async () => {
    api.listGroupings.mockResolvedValueOnce({ items: [], nextCursor: null });
    const view = renderWithQuery(<SeasonsPage />);
    expect(await screen.findByText('No seasons yet')).toBeVisible();
    view.unmount();

    api.listGroupings.mockRejectedValue(new Error('down'));
    renderWithQuery(<SeasonsPage />);
    expect(await screen.findByText('The seasons could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('creates a season with its dates and refreshes after the write', async () => {
    await openList();
    api.createGrouping.mockResolvedValue(season(8));
    await userEvent.click(screen.getByRole('button', { name: 'New season' }));
    const dialog = await screen.findByRole('dialog', { name: 'New season' });
    await userEvent.type(within(dialog).getByLabelText('Code'), 'ss28');
    await userEvent.type(within(dialog).getByLabelText('Name in English'), 'Summer 28');
    await userEvent.type(within(dialog).getByLabelText(/Starts on/), '2028-03-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(api.createGrouping).toHaveBeenCalledWith('season', {
        code: 'SS28',
        name: { en: 'Summer 28', ar: '' },
        startsOn: '2028-03-01',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['seasons'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
  });

  it('refuses dates out of order and an empty name before asking the api', async () => {
    await openList();
    await userEvent.click(screen.getByRole('button', { name: 'New season' }));
    const dialog = await screen.findByRole('dialog', { name: 'New season' });
    await userEvent.type(within(dialog).getByLabelText('Code'), 'X1');
    await userEvent.type(within(dialog).getByLabelText(/Starts on/), '2028-05-01');
    await userEvent.type(within(dialog).getByLabelText(/Ends on/), '2028-03-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    expect(
      await within(dialog).findByText('The end date cannot be before the start date.'),
    ).toBeVisible();
    expect(within(dialog).getByText('Give a name in at least one language.')).toBeVisible();
    expect(api.createGrouping).not.toHaveBeenCalled();
  });

  it('names a taken code on the field', async () => {
    await openList();
    api.createGrouping.mockRejectedValue(new ApiError(409, { code: 'SEASON_CODE_TAKEN' }));
    await userEvent.click(screen.getByRole('button', { name: 'New season' }));
    const dialog = await screen.findByRole('dialog', { name: 'New season' });
    await userEvent.type(within(dialog).getByLabelText('Code'), 'SS27');
    await userEvent.type(within(dialog).getByLabelText('Name in English'), 'Again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('Another season already uses this code.')).toBeVisible();
    expect(within(dialog).getByLabelText('Code')).toHaveAttribute('aria-invalid', 'true');
  });

  it('edits only what changed with updatedAt, and offers a reload on a stale answer', async () => {
    const table = await openList();
    api.updateGrouping.mockRejectedValueOnce(new ApiError(409, { code: 'STALE_RECORD' }));
    await userEvent.click(within(table).getByRole('button', { name: 'Edit season SS27' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit season SS27' });
    const name = within(dialog).getByLabelText('Name in English');
    await userEvent.clear(name);
    await userEvent.type(name, 'High summer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(api.updateGrouping).toHaveBeenCalledWith('season', season(7).id, {
      updatedAt: season(7).updatedAt,
      name: { en: 'High summer', ar: 'صيف 27' },
    });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Someone changed this season since you opened it. Reload to see their change, then edit again.',
    );

    const newer = season(7, { name: { en: 'Summer 27 new' }, updatedAt: 'later' });
    api.listGroupings.mockResolvedValue({ items: [CORE, newer], nextCursor: null });
    await userEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Summer 27 new'),
    );
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('reloads a stale season that moved to another status, and says when it is gone', async () => {
    const table = await openList();
    api.updateGrouping.mockRejectedValue(new ApiError(409, { code: 'STALE_RECORD' }));
    await userEvent.click(within(table).getByRole('button', { name: 'Edit season SS27' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit season SS27' });
    await userEvent.type(within(dialog).getByLabelText('Name in English'), 's');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');

    // Archived meanwhile: the active list no longer has it, the all list does.
    const moved = season(7, { archived: true, name: { en: 'Moved' }, updatedAt: 'later' });
    api.listGroupings.mockImplementation((_kind: string, status: string) =>
      Promise.resolve({ items: status === 'all' ? [CORE, moved] : [CORE], nextCursor: null }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Moved'),
    );

    // Deleted meanwhile: the dialog stays and says so.
    await userEvent.type(within(dialog).getByLabelText('Name in English'), 's');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');
    api.listGroupings.mockImplementation(() =>
      Promise.resolve({ items: [CORE], nextCursor: null }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'This season no longer exists. Close and look at the list again.',
      ),
    );
    expect(screen.getByRole('dialog', { name: 'Edit season SS27' })).toBeVisible();
  });

  it('keeps the CORE code read only and never sends it', async () => {
    const table = await openList();
    api.updateGrouping.mockResolvedValue({ ...CORE, name: { en: 'Always' } });
    await userEvent.click(within(table).getByRole('button', { name: 'Edit season CORE' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit season CORE' });
    expect(within(dialog).getByLabelText('Code')).toHaveAttribute('readonly');
    expect(within(dialog).getByText('The built in season keeps its code.')).toBeVisible();
    const name = within(dialog).getByLabelText('Name in English');
    await userEvent.clear(name);
    await userEvent.type(name, 'Always');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateGrouping).toHaveBeenCalledWith('season', CORE.id, {
        updatedAt: CORE.updatedAt,
        name: { en: 'Always', ar: 'أساسي' },
      }),
    );
  });

  it('archives after confirming, and words IN_USE, PROTECTED, and NOT_FOUND on delete', async () => {
    const table = await openList();
    api.setGroupingArchived.mockResolvedValue(season(7, { archived: true }));
    await userEvent.click(within(table).getByRole('button', { name: 'Archive season SS27' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive season SS27?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(api.setGroupingArchived).toHaveBeenCalledWith('season', season(7).id, true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['seasons'],
    });

    for (const [code, message] of [
      ['IN_USE', 'Styles or cost records still use this season. Archive it instead.'],
      ['SEASON_PROTECTED', 'The built in season cannot be archived, deleted, or recoded.'],
      ['NOT_FOUND', 'This season no longer exists. Close and look at the list again.'],
    ] as const) {
      api.deleteGrouping.mockRejectedValueOnce(new ApiError(409, { code }));
      await userEvent.click(within(table).getByRole('button', { name: 'Delete season SS27' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete season SS27?' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('shows the no access state to a person with stock.view only, and asks for nothing', async () => {
    me.current = { id: 'me', hats: ['support'], permissions: ['stock.view'] };
    renderWithQuery(<SeasonsPage />);
    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Seasons' })).toBeVisible();
    expect(api.listGroupings).not.toHaveBeenCalled();
  });

  it('reads in Arabic', async () => {
    api.listGroupings.mockResolvedValue({ items: [CORE, season(7)], nextCursor: null });
    renderWithQuery(inArabic(<SeasonsPage />));
    const table = await screen.findByRole('table', { name: 'المواسم' });
    expect(screen.getByRole('heading', { level: 1, name: 'المواسم' })).toBeVisible();
    expect(within(table).getByText('أساسي', { selector: 'td' })).toBeVisible();
    expect(within(table).getByText('صيف 27')).toBeVisible();
    expect(
      within(table).getByText(
        'موسم أساسي: يمكنك تغيير اسمه، لكن لا يمكن أرشفته أو حذفه أو تغيير رمزه.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'موسم جديد' })).toBeVisible();
  });
});
