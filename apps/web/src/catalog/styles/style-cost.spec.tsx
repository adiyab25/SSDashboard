import type {
  CostRecordRow,
  RecordCostResponse,
  StyleDetail,
  VariantCost,
} from '@ssdashboard/contracts';
import { en } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { StyleDetailPage } from './style-detail-page';

const api = vi.hoisted(() => ({
  getStyle: vi.fn(),
  listCostRecords: vi.fn(),
  recordCost: vi.fn(),
  listGroupingChoices: vi.fn(),
}));
vi.mock('@/catalog/catalog-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
const refetch = vi.hoisted(() => ({ refetchAfterWrite: vi.fn(() => Promise.resolve()) }));
vi.mock('@/api/refetch-after-write', () => refetch);
const install = vi.hoisted(() => ({ loaded: false }));
vi.mock('@/shell/client-config', () => ({
  loadConfig: () =>
    install.loaded
      ? Promise.resolve({
          clientName: 'Acme',
          version: '1.0.0',
          currency: 'EGP',
          timezone: 'Africa/Cairo',
          languages: ['en', 'ar'],
          defaultLanguage: 'en',
          mailEnabled: false,
        })
      : new Promise(() => undefined),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: STYLE_ID }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

type Person = { id: string; hats: string[]; permissions: string[] };
const me = vi.hoisted((): { current: Person } => ({
  current: { id: 'me', hats: ['manager'], permissions: [] },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));
const COST_EDITOR: Person = {
  id: 'me',
  hats: ['manager'],
  permissions: ['stock.view', 'catalog.edit', 'cost.view'],
};
const COST_VIEWER: Person = {
  id: 'me',
  hats: ['manager'],
  permissions: ['stock.view', 'cost.view'],
};
const NO_COST: Person = {
  id: 'me',
  hats: ['warehouse'],
  permissions: ['stock.view', 'catalog.edit'],
};

const STYLE_ID = '40000000-0000-4000-8000-000000000001';
const SEASON = {
  id: '30000000-0000-4000-8000-000000000001',
  code: 'SS27',
  name: { en: 'Summer 27', ar: 'صيف 27' },
};
const OLD_SEASON = {
  id: '30000000-0000-4000-8000-000000000009',
  code: 'AW19',
  name: { en: 'Winter 19' },
  startsOn: null,
  endsOn: null,
  archived: true,
  protected: false,
  updatedAt: 'x',
};
const GROUP = { id: '20000000-0000-4000-8000-000000000002', code: 'TOPS', name: { en: 'Tops' } };
const VARIANTS = ['TEE-S', 'TEE-M', 'TEE-L', 'TEE-XL'].map((code, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  code,
}));

const COSTS: Record<string, VariantCost> = {
  'TEE-S': {
    status: 'set',
    unitCost: '120.0000',
    costBasis: 'factory_invoice',
    effectiveFrom: '2026-10-01',
    inheritedFrom: 'style',
  },
  'TEE-M': {
    status: 'set',
    unitCost: '95.5000',
    costBasis: 'production_run',
    effectiveFrom: '2026-10-05',
    inheritedFrom: 'variant',
  },
  'TEE-L': {
    status: 'set',
    unitCost: '80.0000',
    costBasis: 'estimate',
    effectiveFrom: '2026-09-01',
    inheritedFrom: 'style',
  },
  'TEE-XL': { status: 'not_set' },
};

const detail = (withCost: boolean): StyleDetail => ({
  id: STYLE_ID,
  code: 'TEE',
  name: { en: 'Tee' },
  description: null,
  season: SEASON,
  productGroup: GROUP,
  tags: [],
  productType: null,
  brand: null,
  archived: false,
  updatedAt: '2026-11-03T10:00:00.123456Z',
  options: [],
  variants: VARIANTS.map((variant) => ({
    ...variant,
    options: [],
    price: '250.00',
    archived: false,
    barcodes: [],
    ...(withCost && { cost: COSTS[variant.code] }),
  })),
});

const record = (n: number, overrides: Partial<CostRecordRow> = {}): CostRecordRow => ({
  id: `90000000-0000-4000-8000-00000000000${n}`,
  variant: null,
  season: { id: SEASON.id, code: 'SS27' },
  costBasis: 'factory_invoice',
  unitCost: '120.0000',
  effectiveFrom: '2026-10-01',
  source: 'INV-77',
  recordedAt: '2026-10-02T08:00:00.000000Z',
  recordedBy: { id: '10000000-0000-4000-8000-000000000001', name: 'Mona' },
  ...overrides,
});

const inArabic = (ui: ReactElement) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

function arrange(person: Person) {
  me.current = person;
  api.getStyle.mockResolvedValue(detail(person.permissions.includes('cost.view')));
  api.listCostRecords.mockResolvedValue({
    items: [
      record(1),
      record(2, { variant: { id: VARIANTS[1]!.id, code: 'TEE-M' }, costBasis: 'estimate' }),
    ],
    nextCursor: null,
  });
  api.listGroupingChoices.mockResolvedValue([SEASON, OLD_SEASON]);
}

afterEach(() => {
  install.loaded = false;
  for (const mock of Object.values(api)) mock.mockReset();
  refetch.refetchAfterWrite.mockClear();
});

async function open(
  person: Person,
  wrap: (ui: ReactElement) => ReactElement = (ui) => ui,
  after?: () => void,
) {
  arrange(person);
  after?.();
  renderWithQuery(wrap(<StyleDetailPage />));
  await screen.findByRole('heading', { level: 1, name: 'TEE' });
}

const rowOf = (table: HTMLElement, code: string) => {
  const row = within(table).getByRole('link', { name: code }).closest('tr');
  if (!row) throw new Error(`no row for ${code}`);
  return within(row);
};

describe('Style cost column (spec 0012, AC-12, AC-16)', () => {
  it('shows inherited, override, estimate, and not set costs for a cost viewer', async () => {
    await open(COST_VIEWER);
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    expect(within(table).getByRole('columnheader', { name: 'Unit cost' })).toBeVisible();

    const small = rowOf(table, 'TEE-S');
    expect(small.getByText('120.0000')).toBeVisible();
    expect(small.getByText(/From style/)).toBeVisible();
    expect(small.getByText(/From style/).textContent).toContain('1 Oct 2026');
    expect(small.queryByText('Estimate')).toBeNull();

    const medium = rowOf(table, 'TEE-M');
    expect(medium.getByText('95.5000')).toBeVisible();
    expect(medium.getByText(/Override/)).toBeVisible();

    const large = rowOf(table, 'TEE-L');
    expect(large.getByText('80.0000')).toBeVisible();
    expect(large.getByText('Estimate')).toBeVisible();

    const none = rowOf(table, 'TEE-XL');
    expect(none.getByText('Not set')).toBeVisible();
    expect(none.queryByText(/^0/)).toBeNull();
  });

  it('reads in Arabic', async () => {
    await open(COST_VIEWER, inArabic);
    const table = screen.getByRole('table', { name: 'أصناف هذا الموديل' });
    expect(within(table).getByRole('columnheader', { name: 'تكلفة الوحدة' })).toBeVisible();
    expect(rowOf(table, 'TEE-L').getByText('تقدير')).toBeVisible();
    expect(rowOf(table, 'TEE-S').getByText(/من الموديل/)).toBeVisible();
    expect(rowOf(table, 'TEE-M').getByText(/تخصيص/)).toBeVisible();
    expect(rowOf(table, 'TEE-XL').getByText('غير محددة')).toBeVisible();
    expect(screen.getByRole('region', { name: 'سجل التكلفة' })).toBeVisible();
  });
});

describe('Cost history panel (spec 0012, AC-13)', () => {
  it('lists records newest first with the variant or Style, basis, source, and who', async () => {
    await open(COST_VIEWER);
    const panel = screen.getByRole('region', { name: 'Cost history' });
    const table = await within(panel).findByRole('table', {
      name: 'Cost records of this style, newest first',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('Style')).toBeVisible();
    expect(within(rows[1]!).getByText('Factory invoice')).toBeVisible();
    expect(within(rows[1]!).getByText('INV-77')).not.toHaveAttribute('dir');
    expect(within(rows[1]!).getByText('Mona')).toBeVisible();
    expect(within(rows[1]!).getByText('SS27')).toBeVisible();
    expect(within(rows[2]!).getByText('TEE-M')).toBeVisible();
    expect(within(rows[2]!).getByText('Estimate')).toBeVisible();
    expect(api.listCostRecords).toHaveBeenCalledWith(STYLE_ID, undefined, expect.anything());
    expect(within(panel).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('keeps free text start to end and words a missing name as an unknown person', async () => {
    await open(COST_VIEWER, undefined, () =>
      api.listCostRecords.mockResolvedValue({
        items: [
          record(1, { source: 'فاتورة 77' }),
          record(2, { recordedBy: { id: '10000000-0000-4000-8000-000000000002', name: null } }),
          record(3, { recordedBy: null }),
        ],
        nextCursor: null,
      }),
    );
    const table = await screen.findByRole('table', {
      name: 'Cost records of this style, newest first',
    });
    expect(within(table).getByText('فاتورة 77')).not.toHaveAttribute('dir');
    expect(within(table).getByText('Unknown person')).toBeVisible();
    expect(within(table).getByText('System')).toBeVisible();
  });

  it('pages with Show more and shows the empty and error states', async () => {
    arrange(COST_VIEWER);
    api.listCostRecords
      .mockResolvedValueOnce({ items: [record(1)], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [record(2)], nextCursor: null });
    const view = renderWithQuery(<StyleDetailPage />);
    const more = await screen.findByRole('button', { name: 'Show more' });
    await userEvent.click(more);
    await waitFor(() =>
      expect(api.listCostRecords).toHaveBeenLastCalledWith(
        STYLE_ID,
        'next-page',
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());
    expect(screen.getAllByRole('row')).toHaveLength(2 + 6);
    view.unmount();

    arrange(COST_VIEWER);
    api.listCostRecords.mockResolvedValue({ items: [], nextCursor: null });
    renderWithQuery(<StyleDetailPage />);
    expect(await screen.findByText('No cost has been recorded for this style yet.')).toBeVisible();
  });

  it('shows a retry when the history cannot load', async () => {
    arrange(COST_VIEWER);
    api.listCostRecords.mockRejectedValue(new ApiError(500, { code: 'INTERNAL' }));
    renderWithQuery(<StyleDetailPage />);
    expect(await screen.findByText('The cost history could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('reads in Arabic', async () => {
    await open(COST_VIEWER, inArabic);
    const panel = screen.getByRole('region', { name: 'سجل التكلفة' });
    expect(
      await within(panel).findByRole('table', { name: 'سجلات تكلفة هذا الموديل، الأحدث أولا' }),
    ).toBeVisible();
    expect(within(panel).getAllByText('فاتورة المصنع').length).toBeGreaterThan(0);
  });
});

describe('Record cost dialog (spec 0012, AC-13)', () => {
  const response = (): RecordCostResponse => ({ record: record(3), variants: [] });

  async function openDialog(wrap?: (ui: ReactElement) => ReactElement, after?: () => void) {
    await open(COST_EDITOR, wrap, after);
    await userEvent.click(screen.getByRole('button', { name: /^(Record cost|تسجيل تكلفة)$/ }));
    return screen.findByRole('dialog');
  }

  it('records a cost typed in Arabic digits, labels archived seasons, and refreshes', async () => {
    api.recordCost.mockResolvedValue(response());
    const dialog = await openDialog();
    const season = await within(dialog).findByLabelText('Season');
    await waitFor(() => expect(season).toBeEnabled());
    expect(within(season).getByRole('option', { name: 'Winter 19 (archived)' })).toBeVisible();
    expect(season).toHaveValue(SEASON.id);

    await userEvent.selectOptions(within(dialog).getByLabelText('Applies to'), VARIANTS[1]!.id);
    await userEvent.selectOptions(within(dialog).getByLabelText('Cost basis'), 'estimate');
    await userEvent.type(within(dialog).getByLabelText('Unit cost'), '١٢٠٫٥');
    fireEvent.change(within(dialog).getByLabelText('Effective from'), {
      target: { value: '2026-11-11' },
    });
    await userEvent.type(within(dialog).getByLabelText(/^Source/), 'INV-9');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record cost' }));

    await waitFor(() =>
      expect(api.recordCost).toHaveBeenCalledWith(STYLE_ID, {
        variantId: VARIANTS[1]!.id,
        seasonId: SEASON.id,
        costBasis: 'estimate',
        unitCost: '120.5',
        effectiveFrom: '2026-11-11',
        source: 'INV-9',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles', 'detail', STYLE_ID],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles', 'cost-records', STYLE_ID],
    });
  });

  it('fills the effective day once the install time zone is known and hints the reason', async () => {
    install.loaded = true;
    const dialog = await openDialog((ui) => (
      <LanguageProvider initial={{ language: 'en', catalog: en }}>{ui}</LanguageProvider>
    ));
    const day = within(dialog).getByLabelText('Effective from');
    await waitFor(() => expect((day as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/));
    expect(
      within(dialog).getByText(/before today's operating day.*Do not type amounts here/),
    ).toBeVisible();
    expect(within(dialog).getByLabelText(/^Source/)).not.toHaveAttribute('dir');
  });

  it('leaves the day empty, not invalid, and draws no disabled save while seasons load', async () => {
    const dialog = await openDialog(undefined, () =>
      api.listGroupingChoices.mockReturnValue(new Promise(() => undefined)),
    );
    expect(within(dialog).getByLabelText('Effective from')).toHaveValue('');
    expect(within(dialog).queryByRole('button', { name: 'Record cost' })).toBeNull();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading seasons');
  });

  it('keeps the dialog open and shows the reason field error on REASON_REQUIRED', async () => {
    api.recordCost.mockRejectedValueOnce(new ApiError(422, { code: 'REASON_REQUIRED' }));
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByLabelText('Season')).toBeEnabled());
    await userEvent.type(within(dialog).getByLabelText('Unit cost'), '10');
    fireEvent.change(within(dialog).getByLabelText('Effective from'), {
      target: { value: '2026-01-01' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record cost' }));

    const reason = within(dialog).getByLabelText('Reason');
    expect(
      await within(dialog).findByText('Give a reason: this cost starts before today.'),
    ).toBeVisible();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('dialog')).toBeVisible();

    api.recordCost.mockResolvedValue(response());
    await userEvent.type(reason, 'Late invoice');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record cost' }));
    await waitFor(() =>
      expect(api.recordCost).toHaveBeenLastCalledWith(
        STYLE_ID,
        expect.objectContaining({ reason: 'Late invoice' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses a unit cost with more than 4 decimals without calling the api', async () => {
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByLabelText('Season')).toBeEnabled());
    await userEvent.type(within(dialog).getByLabelText('Unit cost'), '1.23456');
    fireEvent.change(within(dialog).getByLabelText('Effective from'), {
      target: { value: '2026-11-11' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record cost' }));
    expect(
      await within(dialog).findByText('Enter 0 or more with at most 4 decimals.'),
    ).toBeVisible();
    expect(api.recordCost).not.toHaveBeenCalled();
  });

  it('words a 404 on the dialog and opens in Arabic', async () => {
    api.recordCost.mockRejectedValue(new ApiError(404, { code: 'NOT_FOUND' }));
    const dialog = await openDialog(inArabic);
    expect(within(dialog).getByText('تسجيل تكلفة للموديل TEE')).toBeVisible();
    await waitFor(() => expect(within(dialog).getByLabelText('الموسم')).toBeEnabled());
    await userEvent.type(within(dialog).getByLabelText('تكلفة الوحدة'), '٥٠');
    fireEvent.change(within(dialog).getByLabelText('سارية من'), {
      target: { value: '2026-11-11' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التكلفة' }));
    expect(
      await within(dialog).findByText('الموديل أو الموسم أو الصنف لم يعد موجودا.'),
    ).toBeVisible();
    expect(api.recordCost).toHaveBeenCalledWith(
      STYLE_ID,
      expect.objectContaining({ unitCost: '50' }),
    );
  });
});

describe('Without cost.view (spec 0012, AC-16)', () => {
  it('draws no cost column, no panel, no action, and calls no cost route', async () => {
    await open(NO_COST);
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    expect(within(table).queryByRole('columnheader', { name: 'Unit cost' })).toBeNull();
    expect(within(table).queryByText('Not set')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Cost history' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record cost' })).toBeNull();
    expect(api.listCostRecords).not.toHaveBeenCalled();
    expect(api.recordCost).not.toHaveBeenCalled();
  });

  it('shows cost but no Record cost to a cost viewer without catalog.edit', async () => {
    await open(COST_VIEWER);
    expect(screen.getByRole('region', { name: 'Cost history' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Record cost' })).toBeNull();
  });
});
