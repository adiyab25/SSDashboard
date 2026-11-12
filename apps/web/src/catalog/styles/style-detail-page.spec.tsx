import type { SkuDetail, StyleDetail } from '@ssdashboard/contracts';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/i18n/language-provider';
import { renderWithQuery } from '@/shared/render-with-query';
import { StyleDetailPage } from './style-detail-page';

const api = vi.hoisted(() => ({
  getStyle: vi.fn(),
  updateStyle: vi.fn(),
  changeStyleCode: vi.fn(),
  addVariant: vi.fn(),
  addBarcode: vi.fn(),
  removeBarcode: vi.fn(),
  listGroupingChoices: vi.fn(),
}));
vi.mock('@/catalog/catalog-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
const refetch = vi.hoisted(() => ({ refetchAfterWrite: vi.fn(() => Promise.resolve()) }));
vi.mock('@/api/refetch-after-write', () => refetch);
vi.mock('@/shell/client-config', () => ({ loadConfig: () => new Promise(() => undefined) }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: STYLE_ID }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

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

const STYLE_ID = '40000000-0000-4000-8000-000000000001';
const VARIANT_ID = '00000000-0000-4000-8000-000000000001';
const SEASON = {
  id: '30000000-0000-4000-8000-000000000001',
  code: 'SS27',
  name: { en: 'Summer 27', ar: 'صيف 27' },
};
const OLD_SEASON = {
  id: '30000000-0000-4000-8000-000000000009',
  code: 'AW19',
  name: { en: 'Winter 19' },
};
const GROUP = {
  id: '20000000-0000-4000-8000-000000000002',
  code: 'TOPS',
  name: { en: 'Tops', ar: 'قمصان' },
};
const MAIN = { id: '20000000-0000-4000-8000-000000000001', code: 'MAIN', name: { en: 'Main' } };
const BARCODE = {
  id: '50000000-0000-4000-8000-000000000001',
  code: '6221234567890',
  fromChannel: false,
};

const detail = (overrides: Partial<StyleDetail> = {}): StyleDetail => ({
  id: STYLE_ID,
  code: 'TEE',
  name: { en: 'Tee', ar: 'تيشيرت' },
  description: null,
  season: SEASON,
  productGroup: GROUP,
  tags: ['summer'],
  productType: null,
  brand: null,
  archived: false,
  updatedAt: '2026-11-03T10:00:00.123456Z',
  channelLinked: false,
  channelNameLanguage: null,
  options: [
    {
      id: '60000000-0000-4000-8000-000000000001',
      name: { en: 'Size', ar: 'المقاس' },
      role: 'size',
      position: 0,
      values: [{ en: 'M', ar: 'وسط' }, { en: 'L' }],
    },
  ],
  variants: [
    {
      id: VARIANT_ID,
      code: 'TEE-M',
      options: [{ name: { en: 'Size', ar: 'المقاس' }, value: { en: 'M', ar: 'وسط' } }],
      price: '250.00',
      archived: false,
      channelLinked: false,
      barcodes: [BARCODE],
    },
  ],
  ...overrides,
});

const sku = (overrides: Partial<SkuDetail> = {}): SkuDetail => ({
  id: VARIANT_ID,
  productId: STYLE_ID,
  code: 'TEE-M',
  name: { en: 'Tee' },
  style: { id: STYLE_ID, code: 'TEE', name: { en: 'Tee' } },
  season: SEASON,
  productGroup: GROUP,
  options: [],
  price: null,
  archived: false,
  status: 'active',
  updatedAt: 'x',
  barcodes: [BARCODE],
  channelLinked: false,
  channelNameLanguage: null,
  ...overrides,
});

const inArabic = (ui: ReactNode) => (
  <LanguageProvider initial={{ language: 'ar', catalog: ar }}>{ui}</LanguageProvider>
);

function arrange(style: StyleDetail = detail()) {
  api.getStyle.mockResolvedValue(style);
  api.listGroupingChoices.mockImplementation((kind: string) =>
    Promise.resolve(kind === 'season' ? [SEASON] : [MAIN, GROUP]),
  );
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  refetch.refetchAfterWrite.mockClear();
  me.current = EDITOR;
});

async function open(style?: StyleDetail) {
  arrange(style);
  renderWithQuery(<StyleDetailPage />);
  await screen.findByRole('heading', { level: 1, name: 'TEE' });
}

describe('Style page (spec 0012, AC-8, AC-18)', () => {
  it('shows facts, options with roles, and SKUs with links, prices, and barcodes', async () => {
    await open();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const facts = screen.getByRole('region', { name: 'About this style' });
    expect(within(facts).getByText('Summer 27')).toBeVisible();
    expect(within(facts).getByText('Tops')).toBeVisible();
    expect(within(facts).getByText('summer')).toBeVisible();
    expect(within(facts).getByText('No description')).toBeVisible();
    const options = screen.getByRole('region', { name: 'Options' });
    expect(within(options).getByText('Size (Size)')).toBeVisible();
    expect(within(options).getByText('M, L')).toBeVisible();
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    expect(within(table).getByRole('link', { name: 'TEE-M' })).toHaveAttribute(
      'href',
      `/skus/${VARIANT_ID}`,
    );
    expect(within(table).getByText('6221234567890')).toHaveAttribute('dir', 'ltr');
    expect(api.getStyle).toHaveBeenCalledWith(STYLE_ID, expect.anything());
  });

  it('gives catalog.edit Edit, Add SKU, and Barcodes, and only catalog.manage Change code', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Edit style' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add SKU' })).toBeVisible();
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    expect(within(table).getByRole('button', { name: 'Barcodes of TEE-M' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change code' })).toBeNull();
  });

  it('is read only for stock.view alone', async () => {
    me.current = { id: 'me', hats: ['support'], permissions: ['stock.view'] };
    await open();
    expect(screen.queryByRole('button', { name: 'Edit style' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add SKU' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Barcodes of/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change code' })).toBeNull();
  });

  it('shows Change code to a catalog manager', async () => {
    me.current = { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] };
    await open();
    expect(screen.getByRole('button', { name: 'Change code' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit style' })).toBeNull();
  });

  it('shows not found and the no access state', async () => {
    api.getStyle.mockRejectedValue(new ApiError(404, { code: 'NOT_FOUND' }));
    const view = renderWithQuery(<StyleDetailPage />);
    expect(await screen.findByText('This style does not exist, or it was deleted.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to styles' })).toHaveAttribute('href', '/styles');
    view.unmount();

    me.current = { id: 'me', hats: ['media_buyer'], permissions: ['campaigns.view'] };
    api.getStyle.mockReset();
    renderWithQuery(<StyleDetailPage />);
    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(api.getStyle).not.toHaveBeenCalled();
  });

  it('reads in Arabic', async () => {
    arrange();
    renderWithQuery(inArabic(<StyleDetailPage />));
    await screen.findByRole('heading', { level: 1, name: 'TEE' });
    const facts = screen.getByRole('region', { name: 'عن هذا الموديل' });
    expect(within(facts).getByText('صيف 27')).toBeVisible();
    expect(within(facts).getByText('قمصان')).toBeVisible();
    const options = screen.getByRole('region', { name: 'الخيارات' });
    expect(within(options).getByText('المقاس (مقاس)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'إضافة صنف' })).toBeVisible();
    expect(screen.getByRole('table', { name: 'أصناف هذا الموديل' })).toBeVisible();
  });
});

describe('Style edit dialog (spec 0012, AC-9)', () => {
  it('sends only what changed with updatedAt and refreshes after the write', async () => {
    await open();
    api.updateStyle.mockResolvedValue(detail({ name: { en: 'Tee shirt', ar: 'تيشيرت' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    const name = within(dialog).getByLabelText('Name in English');
    await userEvent.clear(name);
    await userEvent.type(name, 'Tee shirt');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Season'), '');
    await userEvent.selectOptions(within(dialog).getByLabelText('Product group'), MAIN.id);
    const tags = within(dialog).getByLabelText(/Tags/);
    await userEvent.clear(tags);
    await userEvent.type(tags, 'summer، cotton , summer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.updateStyle).toHaveBeenCalledWith(STYLE_ID, {
        updatedAt: detail().updatedAt,
        name: { en: 'Tee shirt', ar: 'تيشيرت' },
        seasonId: null,
        productGroupId: MAIN.id,
        tags: ['summer', 'cotton'],
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
  });

  it('keeps an archived season as a labelled choice and words ARCHIVED, STALE_RECORD, and NOT_FOUND', async () => {
    await open(detail({ season: OLD_SEASON }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    const season = await within(dialog).findByLabelText('Season');
    expect(season).toHaveValue(OLD_SEASON.id);
    expect(within(season).getByRole('option', { name: 'Winter 19 (archived)' })).toBeVisible();

    await userEvent.type(within(dialog).getByLabelText('Name in English'), 's');
    for (const [code, message] of [
      ['ARCHIVED', 'The season or group you chose is archived. Choose an active one.'],
      ['NOT_FOUND', 'This style no longer exists.'],
      [
        'STALE_RECORD',
        'Someone changed this style since you opened it. Reload to see their change, then edit again.',
      ],
    ] as const) {
      api.updateStyle.mockRejectedValueOnce(new ApiError(409, { code }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
    }

    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['seasons'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['product-groups'],
    });

    api.getStyle.mockResolvedValue(detail({ name: { en: 'Newer' }, updatedAt: 'later' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Name in English')).toHaveValue('Newer'),
    );
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('keeps the loaded style on screen when a reload fails', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    await within(dialog).findByLabelText('Season');
    await userEvent.type(within(dialog).getByLabelText('Name in English'), 's');
    api.updateStyle.mockRejectedValueOnce(new ApiError(409, { code: 'STALE_RECORD' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');

    api.getStyle.mockRejectedValue(new Error('down'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.getStyle).toHaveBeenCalledTimes(2));
    // The dialog hides the page from the accessibility tree, so look with hidden.
    expect(
      screen.getByRole('heading', { level: 1, name: 'TEE', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit style TEE' })).toBeVisible();
  });

  it('refuses too many tags before asking the api', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Edit style' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit style TEE' });
    const tags = within(dialog).getByLabelText(/Tags/);
    await userEvent.clear(tags);
    await userEvent.click(tags);
    await userEvent.paste(Array.from({ length: 51 }, (_, index) => `t${index}`).join(','));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Use at most 50 tags of at most 64 characters each.'),
    ).toBeVisible();
    expect(api.updateStyle).not.toHaveBeenCalled();
  });
});

describe('Style code dialog (spec 0012, AC-9)', () => {
  it('changes the code, and names a taken code on the field', async () => {
    me.current = { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] };
    await open();
    api.changeStyleCode
      .mockRejectedValueOnce(new ApiError(409, { code: 'STYLE_CODE_TAKEN' }))
      .mockResolvedValueOnce(detail({ code: 'TEE2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Change code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the code of TEE' });
    const code = within(dialog).getByLabelText('Style code');
    await userEvent.clear(code);
    await userEvent.type(code, 'tee2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change code' }));
    expect(await within(dialog).findByText('Another style already uses this code.')).toBeVisible();
    expect(api.changeStyleCode).toHaveBeenCalledWith(STYLE_ID, {
      updatedAt: detail().updatedAt,
      code: 'TEE2',
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Change code' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
  });

  it('words a stale answer with a reload', async () => {
    me.current = { id: 'me', hats: ['manager'], permissions: ['stock.view', 'catalog.manage'] };
    await open();
    api.changeStyleCode.mockRejectedValueOnce(new ApiError(409, { code: 'STALE_RECORD' }));
    await userEvent.click(screen.getByRole('button', { name: 'Change code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the code of TEE' });
    await userEvent.type(within(dialog).getByLabelText('Style code'), 'X');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change code' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Someone changed this style since you opened it. Reload to see their change, then try again.',
    );
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeVisible();
  });
});

describe('Add SKU dialog (spec 0012, AC-10)', () => {
  it('starts with the style option names and sends Arabic text as Arabic', async () => {
    await open();
    api.addVariant.mockResolvedValue(sku({ code: 'TEE-L-BLK' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add SKU' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a SKU to TEE' });
    expect(within(dialog).getByLabelText('Option 1 name')).toHaveValue('Size');
    await userEvent.type(within(dialog).getByLabelText('SKU code'), 'tee-l-blk');
    await userEvent.type(within(dialog).getByLabelText('Option 1 value'), 'L');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add an option' }));
    await userEvent.type(within(dialog).getByLabelText('Option 2 name'), 'اللون');
    await userEvent.type(within(dialog).getByLabelText('Option 2 value'), 'أسود');
    await userEvent.type(within(dialog).getByLabelText(/Selling price/), '300');
    await userEvent.type(within(dialog).getByLabelText(/Barcode/), '٦٢٢١');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add SKU' }));

    await waitFor(() =>
      expect(api.addVariant).toHaveBeenCalledWith(STYLE_ID, {
        sku: 'TEE-L-BLK',
        options: [
          { name: { en: 'Size' }, value: { en: 'L' } },
          { name: { ar: 'اللون' }, value: { ar: 'أسود' } },
        ],
        price: '300',
        barcode: '6221',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles'],
    });
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
  });

  it('moves focus to the next Remove button, or to Add an option, after a removal', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add SKU' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a SKU to TEE' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add an option' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove option 1' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Remove option 1' })).toHaveFocus(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove option 1' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Add an option' })).toHaveFocus(),
    );
  });

  it('refuses a name without a value, and words each refusal of the api', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add SKU' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a SKU to TEE' });
    await userEvent.type(within(dialog).getByLabelText('SKU code'), 'TEE-XL');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add SKU' }));
    expect(
      await within(dialog).findByText('Give both the name and the value, or leave both empty.'),
    ).toBeVisible();
    expect(api.addVariant).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText('Option 1 value'), 'XL');
    for (const [code, message] of [
      ['OPTION_COMBINATION_TAKEN', 'Another active SKU of this style has exactly these options.'],
      [
        'TOO_MANY_OPTIONS',
        'A style has at most 3 options. Use option names this style already has.',
      ],
      ['ARCHIVED', 'This style is archived. Unarchive one of its SKUs first.'],
      [
        'INVALID_INPUT',
        'Check the options: give each name once, and every name and value needs a letter or a digit.',
      ],
      ['NOT_FOUND', 'This style no longer exists.'],
    ] as const) {
      api.addVariant.mockRejectedValueOnce(new ApiError(409, { code }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add SKU' }));
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
    }

    api.addVariant.mockRejectedValueOnce(new ApiError(409, { code: 'SKU_TAKEN' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add SKU' }));
    expect(await within(dialog).findByText('Another SKU already uses this code.')).toBeVisible();

    await userEvent.type(within(dialog).getByLabelText(/Barcode/), '622');
    api.addVariant.mockRejectedValueOnce(
      new ApiError(409, { code: 'BARCODE_TAKEN', skuCode: 'SHIRT-S' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add SKU' }));
    expect(
      await within(dialog).findByText('This barcode already belongs to SKU SHIRT-S.'),
    ).toBeVisible();
  });
});

describe('Barcodes dialog (spec 0012, AC-10)', () => {
  async function openBarcodes() {
    await open();
    const table = screen.getByRole('table', { name: 'SKUs of this style' });
    await userEvent.click(within(table).getByRole('button', { name: 'Barcodes of TEE-M' }));
    return screen.findByRole('dialog', { name: 'Barcodes of TEE-M' });
  }

  it('adds a barcode, names the SKU holding a taken one, and refreshes', async () => {
    const dialog = await openBarcodes();
    api.addBarcode
      .mockRejectedValueOnce(new ApiError(409, { code: 'BARCODE_TAKEN', skuCode: 'SHIRT-S' }))
      .mockResolvedValueOnce(
        sku({
          barcodes: [
            BARCODE,
            { id: '50000000-0000-4000-8000-000000000002', code: 'NEW1', fromChannel: false },
          ],
        }),
      );
    const field = within(dialog).getByLabelText('New barcode');
    await userEvent.type(field, 'new1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add barcode' }));
    expect(
      await within(dialog).findByText('This barcode already belongs to SKU SHIRT-S.'),
    ).toBeVisible();
    expect(api.addBarcode).toHaveBeenCalledWith(VARIANT_ID, { code: 'NEW1' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add barcode' }));
    const list = await within(dialog).findByRole('list', { name: 'Barcodes' });
    expect(await within(list).findByText('NEW1')).toBeVisible();
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['styles', 'detail', STYLE_ID],
    });
  });

  it('removes a barcode and words a gone one', async () => {
    const dialog = await openBarcodes();
    api.removeBarcode.mockResolvedValueOnce(undefined);
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Remove barcode 6221234567890' }),
    );
    expect(await within(dialog).findByText('No barcodes yet.')).toBeVisible();
    expect(api.removeBarcode).toHaveBeenLastCalledWith(VARIANT_ID, BARCODE.id);
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
    await waitFor(() => expect(within(dialog).getByLabelText('New barcode')).toHaveFocus());
  });

  it('drops a barcode whose removal answers NOT_FOUND and says so', async () => {
    const dialog = await openBarcodes();
    api.removeBarcode.mockRejectedValueOnce(new ApiError(404, { code: 'NOT_FOUND' }));
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Remove barcode 6221234567890' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This SKU or barcode no longer exists. Close and look again.',
    );
    expect(within(dialog).getByText('No barcodes yet.')).toBeVisible();
    expect(refetch.refetchAfterWrite).toHaveBeenCalledWith(expect.anything(), {
      queryKey: ['skus'],
    });
  });

  it('refuses an invalid barcode before asking the api', async () => {
    const dialog = await openBarcodes();
    await userEvent.type(within(dialog).getByLabelText('New barcode'), 'bad code!');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add barcode' }));
    expect(
      await within(dialog).findByText('Use letters, digits, dot, dash, or underscore, up to 64.'),
    ).toBeVisible();
    expect(api.addBarcode).not.toHaveBeenCalled();
  });
});
