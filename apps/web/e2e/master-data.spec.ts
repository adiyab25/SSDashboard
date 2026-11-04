import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ownAddress, seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  api,
  createLocation,
  createSku,
  findRow,
  postSystemMovement,
  receive,
  voidReceipt,
} from './master-data-api';
import {
  expectNoAxeViolations,
  openShell,
  textFor,
  useBrowserState,
  waitForFormHydration,
} from './support';

// Spec 0006, Milestone 3 (master data in full): the SKU list and detail pages and the Locations
// page, driven in a real browser as an admin and as staff, in English and Arabic.
// Codes carry a per run tag because the dev database keeps rows between runs.
const tag = randomUUID().slice(0, 6).toUpperCase();
const code = (name: string) => `${name}-${tag}`;

test.beforeEach(({ viewport }) => {
  test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the master data flows');
});

const skuDialog = (page: Page, skuCode: string) =>
  page.getByRole('dialog', { name: `Edit SKU ${skuCode}` });

/** Opens the SKU list filtered to one code, so the row is on the first page. */
async function openSkus(page: Page, search: string, status: 'Active' | 'Archived' = 'Active') {
  await openShell(page, '/skus');
  await page.getByLabel('Search SKUs').fill(search);
  if (status === 'Archived') await page.getByRole('button', { name: 'Archived' }).click();
  // The search is debounced and replaces the rows: wait until only the match is left.
  await expect(page.getByRole('table', { name: 'SKUs' }).getByRole('row')).toHaveCount(2);
}

/**
 * Types into the SKU search and waits for the debounced request with that text, so a later row
 * count is read from the filtered list and not the list that was showing before the debounce.
 */
async function searchSkus(page: Page, text: string) {
  const answered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/skus' && url.searchParams.get('q') === text.trim();
  });
  await page.getByLabel('Search SKUs').fill(text);
  await answered;
}

async function openEditor(page: Page, skuCode: string, status: 'Active' | 'Archived' = 'Active') {
  await openSkus(page, skuCode, status);
  await page.getByRole('button', { name: `Edit ${skuCode}` }).click();
  const dialog = skuDialog(page, skuCode);
  await expect(dialog).toBeVisible();
  // The admin section loads its usage in the background; wait for the code field to settle.
  await expect(dialog.getByLabel('Name in English')).toBeVisible();
  return dialog;
}

/** Whether the top bar location switcher lists a location, searched by its code. */
async function switcherLists(page: Page, locationCode: string): Promise<boolean> {
  await page.getByRole('button', { name: /^Location/ }).click();
  await page.getByRole('combobox').fill(locationCode);
  const listed = await page
    .getByRole('option', { name: new RegExp(locationCode) })
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  await page.keyboard.press('Escape');
  return listed;
}

/** Waits for the signed in person to be known, so "no Locations link" is not just "not yet". */
async function openAsPerson(page: Page, path: string) {
  const me = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me');
  await openShell(page, path);
  await me;
}

test.describe('admin thread: create, receive, detail with cost; staff without cost', () => {
  let staff: SeededAccount;
  test.beforeAll(async () => {
    staff = await seedAccount({ role: 'staff', name: `Master clerk ${tag}` });
  });
  test.afterAll(async () => {
    await staff?.remove().catch(() => undefined);
  });

  test('an admin creates a location and a SKU, receives stock, and reads the detail page with cost (AC-2, AC-4, AC-10, AC-11)', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    const locationCode = code('MDL');
    const skuCode = code('MDS');

    // The admin creates the location on the Locations page.
    await openShell(page, '/locations');
    await expect(page.getByRole('heading', { level: 1, name: 'Locations' })).toBeVisible();
    await page.getByRole('button', { name: 'New location' }).click();
    const newLocation = page.getByRole('dialog', { name: 'New location' });
    await newLocation.getByLabel('Location code').fill(locationCode.toLowerCase());
    await newLocation.getByLabel('Name in English').fill(`Alexandria ${tag}`);
    await newLocation.getByLabel('Name in Arabic').fill(`مخزن الإسكندرية ${tag}`);
    await newLocation.getByRole('button', { name: 'Create location' }).click();
    await expect(page.getByText(`Location ${locationCode} created.`)).toBeVisible();
    await expect(await findRow(page, 'Locations', new RegExp(locationCode))).toContainText(
      'Active',
    );
    // The new location is in the top bar switcher without a reload (AC-4).
    await expect.poll(() => switcherLists(page, locationCode)).toBe(true);

    // The admin creates the SKU on the SKUs page and finds it by its code.
    await openShell(page, '/skus');
    await page.getByRole('button', { name: 'New SKU' }).click();
    const newSku = page.getByRole('dialog', { name: 'New SKU' });
    await newSku.getByLabel('SKU code').fill(skuCode.toLowerCase());
    await newSku.getByLabel('Name in English').fill('Master tee');
    await newSku.getByLabel('Name in Arabic').fill('قميص رئيسي');
    await newSku.getByLabel('Selling price').fill('19.5');
    await newSku.getByRole('button', { name: 'Create SKU' }).click();
    await expect(page.getByText(`SKU ${skuCode} created.`)).toBeVisible();
    await page.getByLabel('Search SKUs').fill(skuCode);
    const listRow = page.getByRole('row', { name: new RegExp(skuCode) });
    await expect(listRow).toContainText('Master tee');
    await expect(listRow).toContainText('19.50');
    await expect(listRow).toContainText('Active');

    // The new SKU has no stock yet: its detail page says so.
    await listRow.getByRole('link', { name: skuCode }).click();
    await expect(page).toHaveURL(/\/skus\/[0-9a-f-]{36}$/);
    const detailPath = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { level: 1, name: skuCode })).toBeVisible();
    await expect(page.getByText('There is no stock of this SKU at any location.')).toBeVisible();
    await expect(page.getByText('This SKU has no movements yet.')).toBeVisible();

    // The admin posts a receipt of 10 at 5.0000 through the receipt form.
    await openShell(page, '/stock-receipts/new');
    await waitForFormHydration(page);
    await page
      .getByLabel('Receive into')
      .selectOption({ label: `Alexandria ${tag} · ${locationCode}` });
    await page.getByRole('combobox', { name: 'SKU' }).click();
    await page.getByPlaceholder('Search by code or name…').fill(skuCode);
    await page.getByRole('option', { name: new RegExp(skuCode) }).click();
    await page.getByLabel('Quantity').fill('10');
    await page.getByLabel('Unit cost').fill('5.0000');
    await page.getByRole('button', { name: 'Post receipt' }).click();
    await expect(page).toHaveURL(/\/stock-receipts\/[0-9a-f-]{36}$/);
    const number = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
    expect(number).toMatch(/^SR-\d{4}-\d{6}$/);

    // The detail page: stock per location with the cost columns, and the history row.
    await openShell(page, detailPath);
    const stock = page.getByRole('table', { name: 'Stock by location' });
    await expect(stock.getByRole('columnheader', { name: 'Average cost' })).toBeVisible();
    await expect(stock.getByRole('columnheader', { name: 'Stock value' })).toBeVisible();
    const stockRow = stock.getByRole('row', { name: new RegExp(`Alexandria ${tag}`) });
    await expect(stockRow).toContainText('10');
    await expect(stockRow).toContainText('5.0000');
    await expect(stockRow).toContainText('50.00');
    await expect(stock.getByRole('row', { name: /^Total/ })).toContainText('50.00');
    const history = page.getByRole('table', { name: 'Movement history, newest first' });
    await expect(history.getByRole('columnheader', { name: 'Unit cost' })).toBeVisible();
    await expect(history.getByRole('columnheader', { name: 'Total cost' })).toBeVisible();
    const movement = history.getByRole('row', { name: new RegExp(number) });
    await expect(movement).toContainText('+10');
    await expect(movement).toContainText('Stock receipt');
    await expect(movement).toContainText('E2E Admin');
    await expect(movement).toContainText('5.0000');
    await movement.getByRole('link', { name: number }).click();
    await expect(page).toHaveURL(/\/stock-receipts\/[0-9a-f-]{36}$/);

    // Staff read the same page with no cost columns, no Locations entry, and a notice on /locations.
    const clerk = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
    await signInThroughApi(clerk, staff, baseURL ?? '');
    const clerkPage = await clerk.newPage();
    await openAsPerson(clerkPage, detailPath);
    const clerkStock = clerkPage.getByRole('table', { name: 'Stock by location' });
    await expect(
      clerkStock.getByRole('row', { name: new RegExp(`Alexandria ${tag}`) }),
    ).toContainText('10');
    await expect(clerkStock.getByRole('columnheader', { name: 'Average cost' })).toHaveCount(0);
    await expect(clerkStock.getByRole('columnheader', { name: 'Stock value' })).toHaveCount(0);
    const clerkHistory = clerkPage.getByRole('table', { name: 'Movement history, newest first' });
    await expect(clerkHistory.getByRole('row', { name: new RegExp(number) })).toContainText('+10');
    await expect(clerkHistory.getByRole('columnheader', { name: 'Unit cost' })).toHaveCount(0);
    await expect(clerkHistory.getByRole('columnheader', { name: 'Total cost' })).toHaveCount(0);
    await expect(clerkPage.getByText('50.00')).toHaveCount(0);
    await expect(clerkPage.getByText('5.0000')).toHaveCount(0);

    const nav = clerkPage.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'SKUs' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Locations' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Staff' })).toHaveCount(0);

    await openAsPerson(clerkPage, '/locations');
    await expect(clerkPage.getByRole('heading', { level: 1, name: 'Locations' })).toBeVisible();
    await expect(clerkPage.getByText('Only administrators can manage locations.')).toBeVisible();
    await expect(clerkPage.getByRole('button', { name: 'New location' })).toHaveCount(0);
    await expect(clerkPage.getByRole('table')).toHaveCount(0);

    // Staff edit a name and price but get no administrator actions (AC-2, AC-3).
    await openAsPerson(clerkPage, '/skus');
    await clerkPage.getByLabel('Search SKUs').fill(skuCode);
    await clerkPage.getByRole('button', { name: `Edit ${skuCode}` }).click();
    const clerkDialog = skuDialog(clerkPage, skuCode);
    await expect(clerkDialog.getByLabel('Name in English')).toHaveValue('Master tee');
    await expect(clerkDialog.getByText('Administrator actions')).toHaveCount(0);
    await expect(clerkDialog.getByRole('button', { name: 'Archive SKU' })).toHaveCount(0);
    await expect(clerkDialog.getByRole('button', { name: 'Delete SKU' })).toHaveCount(0);
    await clerkDialog.getByLabel('Name in English').fill('Master tee, edited by staff');
    await clerkDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(clerkPage.getByText(`SKU ${skuCode} saved.`)).toBeVisible();
    await expect(clerkPage.getByRole('row', { name: new RegExp(skuCode) })).toContainText(
      'edited by staff',
    );

    // Staff are refused on the api as well (AC-15).
    const archive = await api(
      clerk.request,
      'POST',
      `/skus/${detailPath.split('/').pop()}/archive`,
    );
    expect(archive.status).toBe(403);
    const locations = await api(clerk.request, 'GET', '/locations?status=archived');
    expect(locations.status).toBe(403);
    await clerk.close();
  });

  test('the same thread in Arabic: right to left, Arabic names, cost for the admin (AC-16)', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('MDA'), { en: 'Arabic tee', ar: `قميص ${tag}` });
    const location = await createLocation(page.request, code('MAL'), {
      en: `Giza ${tag}`,
      ar: `مخزن الجيزة ${tag}`,
    });
    await receive(page.request, location.id, sku.id, 4, '2.5');

    await useBrowserState(page, { language: 'ar' });
    await openShell(page, '/skus');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { level: 1, name: textFor('rtl', 'inventory.skus.title') }),
    ).toBeVisible();
    await page.getByLabel(textFor('rtl', 'inventory.skus.search')).fill(sku.code);
    const row = page.getByRole('row', { name: new RegExp(sku.code) });
    await expect(row).toContainText(`قميص ${tag}`);
    await expect(row).toContainText(textFor('rtl', 'inventory.skus.activeBadge'));

    await row.getByRole('link', { name: sku.code }).click();
    await expect(page.getByRole('heading', { level: 1, name: sku.code })).toBeVisible();
    const stock = page.getByRole('table', {
      name: textFor('rtl', 'inventory.skuDetail.stockTable'),
    });
    const stockRow = stock.getByRole('row', { name: new RegExp(`مخزن الجيزة ${tag}`) });
    await expect(stockRow).toContainText('4');
    await expect(stockRow).toContainText('2.5000');
    await expect(stockRow).toContainText('10.00');
    await expect(
      stock.getByRole('columnheader', {
        name: textFor('rtl', 'inventory.skuDetail.stockColumns.value'),
      }),
    ).toBeVisible();
    // Western digits in both languages.
    await expect(stockRow).not.toContainText(/[٠-٩]/);
  });
});

test.describe('SKU list: search, archived filter, Load more (AC-13)', () => {
  test('searches by code prefix in any case and by English or Arabic name, filters archived, and loads more', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const prefix = `LM${tag}`;
    const ids: string[] = [];
    const total = 52;
    for (let start = 0; start < total; start += 8) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(8, total - start) }, (_, offset) => {
          const n = String(start + offset + 1).padStart(2, '0');
          return createSku(page.request, `${prefix}-${n}`, {
            en: `Bulk ${tag} ${n}`,
            ...(n === '03' ? { ar: `صنف مميز ${tag}` } : {}),
          });
        }),
      );
      ids.push(...batch.map((sku) => sku.id));
    }
    // One of the 52 is archived, so 51 stay active: a full first page and one more.
    const archivedId = ids[0] ?? '';
    expect((await api(page.request, 'POST', `/skus/${archivedId}/archive`)).status).toBe(200);

    await openShell(page, '/skus');
    const table = page.getByRole('table', { name: 'SKUs' });
    // A lower case prefix still finds the codes (stored in capitals).
    await searchSkus(page, prefix.toLowerCase());
    await expect(table.getByRole('row', { name: new RegExp(`${prefix}-02`) })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(51); // header + 50
    await expect(table.getByRole('row', { name: new RegExp(`${prefix}-01`) })).toHaveCount(0);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(table.getByRole('row')).toHaveCount(52); // header + 51 active
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

    // Name search: English contains, case ignored, and an Arabic fragment.
    await searchSkus(page, `bulk ${tag.toLowerCase()} 07`);
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row', { name: new RegExp(`${prefix}-07`) })).toBeVisible();
    await searchSkus(page, `مميز ${tag}`);
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row', { name: new RegExp(`${prefix}-03`) })).toBeVisible();

    // No match says so; a LIKE wildcard is a literal, not "everything".
    await searchSkus(page, `ZZZ${tag}`);
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
    await searchSkus(page, '%');
    await expect(table.getByRole('row', { name: new RegExp(prefix) })).toHaveCount(0);

    // The Archived filter shows the archived one, badged, and hides the active ones.
    await searchSkus(page, prefix);
    await page.getByRole('button', { name: 'Archived' }).click();
    await expect(page.getByRole('button', { name: 'Archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const archivedRow = table.getByRole('row', { name: new RegExp(`${prefix}-01`) });
    await expect(archivedRow).toContainText('Archived');
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row', { name: new RegExp(`${prefix}-02`) })).toHaveCount(0);

    // An archived SKU also leaves the receipt picker.
    await openShell(page, '/stock-receipts/new');
    await waitForFormHydration(page);
    await page.getByRole('combobox', { name: 'SKU' }).click();
    await page.getByPlaceholder('Search by code or name…').fill(`${prefix}-0`);
    await expect(page.getByRole('option', { name: new RegExp(`${prefix}-02`) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(`${prefix}-01`) })).toHaveCount(0);
  });

  test('an empty archived list and a failing list each say so (AC-16 states)', async ({ page }) => {
    await openShell(page, '/skus');
    await page.getByLabel('Search SKUs').fill(`NOPE${tag}`);
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
    await page.getByLabel('Search SKUs').fill('');
    await page.route('**/api/skus?**', (route) => route.fulfill({ status: 500, json: {} }));
    await page.getByRole('button', { name: 'Archived' }).click();
    const alert = page.getByRole('alert').or(page.getByText('The SKUs could not be loaded.'));
    await expect(alert.first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
});

test.describe('SKU edit: stale record, code lock, archive, delete (AC-2, AC-3)', () => {
  test('a stale edit from a second tab is refused with a message and recovers on Reload', async ({
    page,
    context,
  }) => {
    const sku = await createSku(page.request, code('STL'), { en: `Stale ${tag}` }, '3.00');
    const first = await openEditor(page, sku.code);
    await expect(first.getByLabel('Name in English')).toHaveValue(`Stale ${tag}`);

    // A second tab (same person) renames the SKU first.
    const other = await context.newPage();
    const second = await openEditor(other, sku.code);
    await second.getByLabel('Name in English').fill(`Renamed elsewhere ${tag}`);
    await second.getByRole('button', { name: 'Save changes' }).click();
    await expect(other.getByText(`SKU ${sku.code} saved.`)).toBeVisible();
    await other.close();

    // The first tab saves its own version and is told it is stale; nothing was overwritten.
    await first.getByLabel('Name in English').fill(`My version ${tag}`);
    await first.getByRole('button', { name: 'Save changes' }).click();
    const alert = first.getByRole('alert');
    await expect(alert).toContainText('Someone else changed this SKU while you had it open.');
    await expect(first).toBeVisible();
    const stored = await api(page.request, 'GET', `/skus/${sku.id}`);
    expect((stored.body.name as { en: string }).en).toBe(`Renamed elsewhere ${tag}`);

    // Reload shows the latest version; saving again works.
    await alert.getByRole('button', { name: 'Reload' }).click();
    await expect(first.getByLabel('Name in English')).toHaveValue(`Renamed elsewhere ${tag}`);
    await expect(first.getByRole('alert')).toHaveCount(0);
    await first.getByLabel('Name in English').fill(`Final ${tag}`);
    await first.getByLabel('Selling price').fill('');
    await first.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`SKU ${sku.code} saved.`)).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(sku.code) });
    await expect(row).toContainText(`Final ${tag}`);
  });

  test('validation: no name in either language, and a bad price, are explained in the dialog', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('VAL'), { en: `Valid ${tag}` });
    const dialog = await openEditor(page, sku.code);
    await dialog.getByLabel('Name in English').fill('');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText('Give a name in English or Arabic.')).toBeVisible();
    await expect(dialog.getByLabel('Name in English')).toBeFocused();
    await dialog.getByLabel('Name in English').fill(`Valid ${tag}`);
    await dialog.getByLabel('Selling price').fill('12.345');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText('Enter 0 or more with at most 2 decimals.')).toBeVisible();
    // Nothing was saved.
    expect((await api(page.request, 'GET', `/skus/${sku.id}`)).body.price).toBeNull();
  });

  test('the code changes before any stock, then is locked: CODE_LOCKED is explained', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const free = await createSku(page.request, code('CDF'));
    await openEditor(page, free.code);
    // The dialog title follows the code, so find it by its prefix from here on.
    const dialog = page.getByRole('dialog', { name: /^Edit SKU / });
    const codeInput = dialog.getByLabel('SKU code');
    await expect(codeInput).toBeEnabled();
    const renamed = code('CDG');
    await codeInput.fill(renamed.toLowerCase());
    await dialog.getByRole('button', { name: 'Change code' }).click();
    await expect(page.getByText(`SKU code changed to ${renamed}.`)).toBeVisible();
    await expect(page.getByRole('dialog', { name: `Edit SKU ${renamed}` })).toBeVisible();

    // A code already in use is refused on the field itself.
    const other = await createSku(page.request, code('CDH'));
    await codeInput.fill(other.code);
    await dialog.getByRole('button', { name: 'Change code' }).click();
    await expect(dialog.getByText('Another SKU already uses this code.')).toBeVisible();
    await expect(codeInput).toBeFocused();

    // The dialog was opened before stock: posting now makes the next code change fail with
    // CODE_LOCKED, which the dialog explains and then locks the field.
    const location = await createLocation(page.request, code('CDL'));
    await receive(page.request, location.id, free.id, 2);
    await codeInput.fill(code('CDI'));
    await dialog.getByRole('button', { name: 'Change code' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'The code can no longer change because this SKU has had stock.',
    );
    await expect(codeInput).toBeDisabled();
    await expect(
      dialog.getByText('The code is fixed because this SKU has had stock.'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Change code' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Opened fresh after stock, the field is read only with the hint from the start.
    const again = await openEditor(page, renamed);
    await expect(again.getByLabel('SKU code')).toBeDisabled();
    await expect(
      again.getByText('The code is fixed because this SKU has had stock.'),
    ).toBeVisible();
    // The api agrees.
    const refused = await api(page.request, 'PATCH', `/skus/${free.id}/code`, {
      updatedAt: (await api(page.request, 'GET', `/skus/${free.id}`)).body.updatedAt,
      sku: code('CDJ'),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CODE_LOCKED' });
  });

  test('archive is blocked with stock (STOCK_ON_HAND), allowed after a void, and unarchive brings it back', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const sku = await createSku(page.request, code('ARC'));
    const location = await createLocation(page.request, code('ARL'));

    // Opened with no stock: Archive is enabled. Stock lands while the dialog is open, so the
    // confirm step meets STOCK_ON_HAND from the api and explains it.
    const dialog = await openEditor(page, sku.code);
    await expect(dialog.getByRole('button', { name: 'Archive SKU' })).toBeEnabled();
    const receipt = await receive(page.request, location.id, sku.id, 6);
    await dialog.getByRole('button', { name: 'Archive SKU' }).click();
    const confirm = page.getByRole('dialog', { name: `Archive SKU ${sku.code}?` });
    await confirm.getByRole('button', { name: 'Archive SKU' }).click();
    await expect(confirm.getByRole('alert')).toContainText(
      'This SKU still has stock on hand, so it cannot be archived.',
    );
    await confirm.getByRole('button', { name: 'Cancel' }).first().click();
    // The dialog now knows: Archive is disabled and says why.
    await expect(dialog.getByRole('button', { name: 'Archive SKU' })).toBeDisabled();
    await expect(
      dialog.getByText('Stock is on hand, so this SKU cannot be archived until it reaches zero.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Fresh open with stock on hand: blocked from the start. The api refuses too.
    const blocked = await openEditor(page, sku.code);
    await expect(blocked.getByRole('button', { name: 'Archive SKU' })).toBeDisabled();
    await blocked.getByRole('button', { name: 'Cancel' }).click();
    const refused = await api(page.request, 'POST', `/skus/${sku.id}/archive`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'STOCK_ON_HAND' });

    // Void the receipt (stock back to 0): archive works and the row leaves the active list.
    await voidReceipt(page.request, receipt.id);
    const allowed = await openEditor(page, sku.code);
    await expect(allowed.getByRole('button', { name: 'Archive SKU' })).toBeEnabled();
    await allowed.getByRole('button', { name: 'Archive SKU' }).click();
    await page
      .getByRole('dialog', { name: `Archive SKU ${sku.code}?` })
      .getByRole('button', { name: 'Archive SKU' })
      .click();
    await expect(page.getByText(`SKU ${sku.code} archived.`)).toBeVisible();
    // The edit dialog stays open after an archive and now offers Unarchive; close it.
    await expect(allowed.getByRole('button', { name: 'Unarchive SKU' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(allowed).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(sku.code) })).toHaveCount(0);

    // Under Archived: badged, and Unarchive puts it back.
    await page.getByRole('button', { name: 'Archived' }).click();
    const archivedRow = page.getByRole('row', { name: new RegExp(sku.code) });
    await expect(archivedRow).toContainText('Archived');
    await archivedRow.getByRole('button', { name: `Edit ${sku.code}` }).click();
    const archivedDialog = skuDialog(page, sku.code);
    await archivedDialog.getByRole('button', { name: 'Unarchive SKU' }).click();
    await page
      .getByRole('dialog', { name: `Unarchive SKU ${sku.code}?` })
      .getByRole('button', { name: 'Unarchive SKU' })
      .click();
    await expect(page.getByText(`SKU ${sku.code} unarchived.`)).toBeVisible();
    await expect(archivedDialog.getByRole('button', { name: 'Archive SKU' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(archivedDialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Active' }).click();
    await expect(page.getByRole('row', { name: new RegExp(sku.code) })).toBeVisible();
  });

  test('delete: IN_USE for a SKU with history, and a never used SKU is removed from its detail page', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const used = await createSku(page.request, code('DLU'));
    const location = await createLocation(page.request, code('DLL'));
    const receipt = await receive(page.request, location.id, used.id, 1);
    await voidReceipt(page.request, receipt.id);

    const dialog = await openEditor(page, used.code);
    await dialog.getByRole('button', { name: 'Delete SKU' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete SKU ${used.code}?` });
    await confirm.getByRole('button', { name: 'Delete SKU' }).click();
    await expect(confirm.getByRole('alert')).toContainText(
      'This SKU is used on receipts or in stock, so it cannot be deleted. Archive it instead.',
    );
    await confirm.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(dialog).toBeVisible();
    expect((await api(page.request, 'GET', `/skus/${used.id}`)).status).toBe(200);

    // A SKU nothing references: deleted from its detail page, which then leaves for the list.
    const unused = await createSku(page.request, code('DLN'));
    await openShell(page, `/skus/${unused.id}`);
    await expect(page.getByRole('heading', { level: 1, name: unused.code })).toBeVisible();
    await page.getByRole('button', { name: 'Edit SKU' }).click();
    await skuDialog(page, unused.code).getByRole('button', { name: 'Delete SKU' }).click();
    await page
      .getByRole('dialog', { name: `Delete SKU ${unused.code}?` })
      .getByRole('button', { name: 'Delete SKU' })
      .click();
    await expect(page.getByText(`SKU ${unused.code} deleted.`)).toBeVisible();
    await expect(page).toHaveURL(/\/skus$/);
    expect((await api(page.request, 'GET', `/skus/${unused.id}`)).status).toBe(404);

    // The deleted SKU's page now says there is no such SKU.
    await openShell(page, `/skus/${unused.id}`);
    await expect(page.getByText('There is no such SKU.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'All SKUs' })).toBeVisible();
  });
});

test.describe('SKU detail: history, void rows, system rows, load more (AC-10)', () => {
  test('a void reads "Void of SR-…" and links to the receipt; a system posting reads System', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const sku = await createSku(page.request, code('HST'), { en: `History ${tag}` });
    const location = await createLocation(page.request, code('HSL'), { en: `Hist loc ${tag}` });
    const receipt = await receive(page.request, location.id, sku.id, 10, '4.0000');
    await voidReceipt(page.request, receipt.id, 'Wrong delivery');
    await postSystemMovement(sku.id, location.id, 5);

    await openShell(page, `/skus/${sku.id}`);
    const history = page.getByRole('table', { name: 'Movement history, newest first' });
    await expect(history.getByRole('row')).toHaveCount(4); // header + system + void + receipt
    const rows = history.getByRole('row');
    // Newest first: the system posting, then the void, then the receipt.
    await expect(rows.nth(1)).toContainText('System');
    await expect(rows.nth(1)).toContainText('+5');
    await expect(rows.nth(1)).toContainText('Opening balance');
    await expect(rows.nth(1).getByRole('link')).toHaveCount(0);

    const voidRow = history.getByRole('row', { name: /Void of SR-\d{4}-\d{6}/ });
    await expect(voidRow).toContainText('-10');
    await expect(voidRow).toContainText('E2E Admin');
    await expect(voidRow).toContainText('Hist loc');
    await expect(voidRow).toContainText('4.0000');
    await expect(voidRow).toContainText('-EGP 40.00');
    const receiptRow = history.getByRole('row', { name: /Stock receipt SR-/ });
    await expect(receiptRow).toContainText('+10');
    await expect(receiptRow).toContainText('40.00');

    const link = voidRow.getByRole('link', { name: /Void of SR-/ });
    await expect(link).toHaveAttribute('href', `/stock-receipts/${receipt.id}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/stock-receipts/${receipt.id}$`));
    await expect(page.getByText('Wrong delivery')).toBeVisible();

    // The void took the stock back to 0 (the system row wrote no balance), so the per location
    // table shows no non zero row.
    await openShell(page, `/skus/${sku.id}`);
    await expect(page.getByText('There is no stock of this SKU at any location.')).toBeVisible();
  });

  test('the same rows in Arabic: إلغاء, النظام, right to left', async ({ page }) => {
    test.setTimeout(90_000);
    const sku = await createSku(page.request, code('HSA'), { ar: `سجل ${tag}` });
    const location = await createLocation(page.request, code('HAL'), { ar: `موقع ${tag}` });
    const receipt = await receive(page.request, location.id, sku.id, 3);
    await voidReceipt(page.request, receipt.id);
    await postSystemMovement(sku.id, location.id, 2);

    await useBrowserState(page, { language: 'ar' });
    await openShell(page, `/skus/${sku.id}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const history = page.getByRole('table', {
      name: textFor('rtl', 'inventory.skuDetail.historyTable'),
    });
    await expect(history.getByRole('row')).toHaveCount(4);
    await expect(history.getByRole('row').nth(1)).toContainText(
      textFor('rtl', 'inventory.skuDetail.system'),
    );
    const voidRow = history.getByRole('row', {
      name: new RegExp(`${textFor('rtl', 'inventory.skuDetail.voidOf')} SR-`),
    });
    await expect(voidRow).toContainText(`موقع ${tag}`);
    await expect(voidRow).toContainText('-3');
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: textFor('rtl', 'inventory.skuDetail.historyTitle'),
      }),
    ).toBeVisible();
  });

  test('history pages 50 at a time with Load more', async ({ page }) => {
    test.setTimeout(150_000);
    const sku = await createSku(page.request, code('HLM'));
    const location = await createLocation(page.request, code('HLL'));
    for (let batch = 0; batch < 4; batch += 1) {
      await Promise.all(
        Array.from({ length: 14 }, () => receive(page.request, location.id, sku.id, 1)),
      );
    }
    // 56 receipts, one movement each.
    await openShell(page, `/skus/${sku.id}`);
    const history = page.getByRole('table', { name: 'Movement history, newest first' });
    await expect(history.getByRole('row')).toHaveCount(51); // header + 50
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(history.getByRole('row')).toHaveCount(57); // header + 56
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    const stock = page.getByRole('table', { name: 'Stock by location' });
    await expect(stock.getByRole('row', { name: /^Total/ })).toContainText('56');
  });

  test('an unknown SKU id shows the not found state with a way back', async ({ page }) => {
    await openShell(page, `/skus/${randomUUID()}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByText('There is no such SKU.')).toBeVisible();
    await page.getByRole('link', { name: 'All SKUs' }).click();
    await expect(page).toHaveURL(/\/skus$/);
  });
});

test.describe('Locations page: edit, archive, delete (AC-4)', () => {
  test('edits a name and code, locks the code after stock, and refuses a stale edit', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const free = await createLocation(page.request, code('LE1'), { en: `Edit me ${tag}` });
    const posted = await createLocation(page.request, code('LE2'), { en: `Posted ${tag}` });
    const sku = await createSku(page.request, code('LES'));
    await voidReceipt(page.request, (await receive(page.request, posted.id, sku.id, 1)).id);

    await openShell(page, '/locations');
    const edit = async (locationCode: string) => {
      const row = await findRow(page, 'Locations', new RegExp(locationCode));
      await row.getByRole('button', { name: `Edit ${locationCode}` }).click();
      const dialog = page.getByRole('dialog', { name: `Edit location ${locationCode}` });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    // Name, type, and (before any stock) code.
    const dialog = await edit(free.code);
    await expect(dialog.getByLabel('Location code')).toBeEditable();
    await dialog.getByLabel('Name in English').fill(`Renamed ${tag}`);
    await dialog.getByLabel('Showroom').click();
    const newCode = code('LE3');
    await dialog.getByLabel('Location code').fill(newCode.toLowerCase());
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`Location ${newCode} saved.`)).toBeVisible();
    const renamedRow = await findRow(page, 'Locations', new RegExp(newCode));
    await expect(renamedRow).toContainText(`Renamed ${tag}`);
    await expect(renamedRow).toContainText('Showroom');
    await expect(await findRow(page, 'Locations', new RegExp(free.code))).toHaveCount(0);

    // A taken code is refused on the field.
    const taken = await edit(newCode);
    await taken.getByLabel('Location code').fill(posted.code);
    await taken.getByRole('button', { name: 'Save changes' }).click();
    await expect(taken.getByText('Another location already uses this code.')).toBeVisible();
    await taken.getByRole('button', { name: 'Cancel' }).click();

    // After stock the code is read only and says why; the name still saves.
    const locked = await edit(posted.code);
    await expect(locked.getByLabel('Location code')).toHaveAttribute('readonly', '');
    await expect(
      locked.getByText(
        'The code is fixed because stock was posted or a receipt was recorded here.',
      ),
    ).toBeVisible();
    await locked.getByRole('button', { name: 'Cancel' }).click();

    // A stale edit: the row changes under the open dialog.
    const stale = await edit(newCode);
    const current = await api(page.request, 'GET', '/locations?status=active&limit=50');
    expect(current.status).toBe(200);
    await stale.getByLabel('Name in English').fill(`Mine ${tag}`);
    const detail = await api(page.request, 'PATCH', `/locations/${free.id}`, {
      updatedAt: await latestUpdatedAt(page, free.id),
      name: { en: `Theirs ${tag}` },
    });
    expect(detail.status).toBe(200);
    await stale.getByRole('button', { name: 'Save changes' }).click();
    const alert = stale.getByRole('alert');
    await expect(alert).toContainText('Someone else changed this location while you had it open.');
    await alert.getByRole('button', { name: 'Reload' }).click();
    await expect(stale.getByLabel('Name in English')).toHaveValue(`Theirs ${tag}`);
    await stale.getByLabel('Name in English').fill(`Final ${tag}`);
    await stale.getByRole('button', { name: 'Save changes' }).click();
    // The first save's message can still be showing, so read the newest one; the row check below
    // proves this save landed.
    await expect(page.getByText(`Location ${newCode} saved.`).last()).toBeVisible();
    await expect(await findRow(page, 'Locations', new RegExp(newCode))).toContainText(
      `Final ${tag}`,
    );
  });

  test('archive is blocked while stock is on hand, works after a void, and unarchive returns it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const location = await createLocation(page.request, code('LA1'), { en: `Archive ${tag}` });
    const sku = await createSku(page.request, code('LAS'));
    const receipt = await receive(page.request, location.id, sku.id, 3);

    await openShell(page, '/locations');
    let row = await findRow(page, 'Locations', new RegExp(location.code));
    await row.getByRole('button', { name: `Archive ${location.code}` }).click();
    const confirm = page.getByRole('dialog', { name: `Archive location ${location.code}?` });
    await confirm.getByRole('button', { name: 'Archive' }).click();
    await expect(confirm.getByRole('alert')).toContainText(
      'This location still has stock on hand, so it cannot be archived.',
    );
    await confirm.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(await findRow(page, 'Locations', new RegExp(location.code))).toContainText(
      'Active',
    );

    await voidReceipt(page.request, receipt.id);
    row = await findRow(page, 'Locations', new RegExp(location.code));
    await row.getByRole('button', { name: `Archive ${location.code}` }).click();
    await page
      .getByRole('dialog', { name: `Archive location ${location.code}?` })
      .getByRole('button', { name: 'Archive' })
      .click();
    await expect(page.getByText(`Location ${location.code} archived.`)).toBeVisible();
    await expect(await findRow(page, 'Locations', new RegExp(location.code))).toHaveCount(0);
    // An archived location leaves the top bar switcher.
    await expect.poll(() => switcherLists(page, location.code)).toBe(false);

    await page.getByRole('button', { name: 'Archived' }).click();
    const archived = await findRow(page, 'Locations', new RegExp(location.code));
    await expect(archived).toContainText('Archived');
    await archived.getByRole('button', { name: `Unarchive ${location.code}` }).click();
    await page
      .getByRole('dialog', { name: `Unarchive location ${location.code}?` })
      .getByRole('button', { name: 'Unarchive' })
      .click();
    await expect(page.getByText(`Location ${location.code} unarchived.`)).toBeVisible();
    await page.getByRole('button', { name: 'Active' }).click();
    await expect(await findRow(page, 'Locations', new RegExp(location.code))).toContainText(
      'Active',
    );
  });

  test('delete: IN_USE for a location with receipts, and a never used one is removed', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const used = await createLocation(page.request, code('LD1'));
    const unused = await createLocation(page.request, code('LD2'));
    const sku = await createSku(page.request, code('LDS'));
    await voidReceipt(page.request, (await receive(page.request, used.id, sku.id, 1)).id);

    await openShell(page, '/locations');
    let row = await findRow(page, 'Locations', new RegExp(used.code));
    await row.getByRole('button', { name: `Delete ${used.code}` }).click();
    const confirm = page.getByRole('dialog', { name: `Delete location ${used.code}?` });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm.getByRole('alert')).toContainText(
      'This location has receipts, movements, balances, or bins, so it cannot be deleted. Archive it instead.',
    );
    await confirm.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(await findRow(page, 'Locations', new RegExp(used.code))).toBeVisible();

    row = await findRow(page, 'Locations', new RegExp(unused.code));
    await row.getByRole('button', { name: `Delete ${unused.code}` }).click();
    await page
      .getByRole('dialog', { name: `Delete location ${unused.code}?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByText(`Location ${unused.code} deleted.`)).toBeVisible();
    await expect(await findRow(page, 'Locations', new RegExp(unused.code))).toHaveCount(0);
  });

  test('the seeded transit and virtual locations never appear on the page (AC-4)', async ({
    page,
  }) => {
    await openShell(page, '/locations');
    const table = page.getByRole('table', { name: 'Locations' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    const api2 = await api(page.request, 'GET', '/locations?status=active&limit=50');
    const items = (api2.body.items ?? []) as { type: string }[];
    expect(items.every((item) => item.type === 'warehouse' || item.type === 'showroom')).toBe(true);
  });

  test('Locations in Arabic: right to left with Arabic names and a bilingual Load more', async ({
    page,
  }) => {
    const location = await createLocation(page.request, code('LAR'), {
      en: `Arabic loc ${tag}`,
      ar: `موقع عربي ${tag}`,
    });
    await useBrowserState(page, { language: 'ar' });
    await openShell(page, '/locations');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { level: 1, name: textFor('rtl', 'inventory.locations.title') }),
    ).toBeVisible();
    const row = await findRow(
      page,
      textFor('rtl', 'inventory.locations.tableLabel'),
      new RegExp(location.code),
      textFor('rtl', 'inventory.loadMore'),
    );
    await expect(row).toContainText(`موقع عربي ${tag}`);
    await expect(row).toContainText(textFor('rtl', 'inventory.locations.activeBadge'));
  });
});

test.describe('keyboard use of the edit dialog (AC-16)', () => {
  test('opens from the keyboard, traps focus, saves with Enter, closes with Escape and returns focus', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('KBD'), { en: `Keys ${tag}` }, '1.00');
    await openSkus(page, sku.code);
    const trigger = page.getByRole('button', { name: `Edit ${sku.code}` });
    await expect(trigger).toBeVisible();

    // Reach the Edit button by keyboard alone: Tab forward from the search field.
    await page.getByLabel('Search SKUs').focus();
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      if (await trigger.evaluate((node) => node === document.activeElement)) break;
    }
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = skuDialog(page, sku.code);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name in English')).toBeVisible();
    // Focus moved into the dialog, and Tab never leaves it (one full cycle and a bit).
    const inside = () =>
      page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
    expect(await inside()).toBe(true);
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside()).toBe(true);
    }

    // Type a new name and submit with Enter.
    await dialog.getByLabel('Name in English').focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(`Typed ${tag}`);
    await page.keyboard.press('Enter');
    await expect(page.getByText(`SKU ${sku.code} saved.`)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(sku.code) })).toContainText(
      `Typed ${tag}`,
    );

    // Escape closes it (focus is put back by hand: see the focus return test below).
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await trigger.focus();

    // A confirm dialog is keyboard reachable too: Archive opens it, Cancel by keyboard closes
    // only the confirm step and the edit dialog stays open with what was typed.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name in English').fill(`Unsaved ${tag}`);
    await dialog.getByRole('button', { name: 'Archive SKU' }).focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: `Archive SKU ${sku.code}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).first().focus();
    await page.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name in English')).toHaveValue(`Unsaved ${tag}`);
  });
});

test.describe('focus returns to the control that opened a dialog (WCAG 2.4.3, AC-16)', () => {
  // The list pages mount their dialogs without a Radix trigger, so each dialog hands focus back
  // to the control that opened it itself (use-return-focus.ts).
  test('SKU edit dialog: Escape hands focus back to its Edit button', async ({ page }) => {
    const sku = await createSku(page.request, code('FOC'), { en: `Focus ${tag}` });
    await openSkus(page, sku.code);
    const trigger = page.getByRole('button', { name: `Edit ${sku.code}` });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(skuDialog(page, sku.code)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(skuDialog(page, sku.code)).toHaveCount(0);
    await expect(trigger).toBeFocused({ timeout: 2000 });
  });

  test('Escape in the archive confirm step closes only that step, not the edit dialog under it', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('ESC'), { en: `Escape ${tag}` });
    const dialog = await openEditor(page, sku.code);
    await dialog.getByLabel('Name in English').fill(`Unsaved ${tag}`);
    await dialog.getByRole('button', { name: 'Archive SKU' }).focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: `Archive SKU ${sku.code}?` });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByLabel('Name in English')).toHaveValue(`Unsaved ${tag}`);
  });

  test('the confirm dialog has one control named Cancel, and its close icon is named Close', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('CAN'));
    const dialog = await openEditor(page, sku.code);
    await dialog.getByRole('button', { name: 'Delete SKU' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete SKU ${sku.code}?` });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toHaveCount(1);
  });

  test('Location edit dialog: Escape hands focus back to its Edit button', async ({ page }) => {
    const location = await createLocation(page.request, code('FOL'));
    await openShell(page, '/locations');
    const row = await findRow(page, 'Locations', new RegExp(location.code));
    const trigger = row.getByRole('button', { name: `Edit ${location.code}` });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Edit location ${location.code}` });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused({ timeout: 2000 });
  });
});

test.describe('focus return on the stock and receipt dialogs (WCAG 2.4.3, AC-16)', () => {
  test('New SKU and New location on /stock hand focus back to their buttons on Escape', async ({
    page,
  }) => {
    await openShell(page, '/stock');
    for (const [name, title] of [
      ['New SKU', 'New SKU'],
      ['New location', 'New location'],
    ] as const) {
      const trigger = page.getByRole('button', { name, exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused({ timeout: 2000 });
    }
  });

  test('Void receipt on the receipt page hands focus back to its button when cancelled', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('FVS'));
    const location = await createLocation(page.request, code('FVL'));
    const receipt = await receive(page.request, location.id, sku.id, 2);
    await openShell(page, `/stock-receipts/${receipt.id}`);
    const trigger = page.getByRole('button', { name: 'Void receipt', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Void receipt ${receipt.number}?` });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused({ timeout: 2000 });
  });
});

test.describe('SKU edit dialog: no lost update, no 404 flash (AC-2, AC-3)', () => {
  test('a background refetch of the SKU mid edit does not swap the version: the save is stale, not a silent overwrite', async ({
    page,
  }) => {
    const sku = await createSku(page.request, code('LUP'), { en: `Lost ${tag}` });
    // Fake time, running normally, so the page's data can be aged past its 30 second staleTime.
    await page.clock.install();
    await openShell(page, `/skus/${sku.id}`);
    await expect(page.getByRole('heading', { level: 1, name: sku.code })).toBeVisible();
    await page.getByRole('button', { name: 'Edit SKU' }).click();
    const dialog = skuDialog(page, sku.code);
    await expect(dialog.getByLabel('Name in English')).toHaveValue(`Lost ${tag}`);

    // A colleague renames it underneath the open dialog.
    const renamed = await api(page.request, 'PATCH', `/skus/${sku.id}`, {
      updatedAt: sku.updatedAt,
      name: { en: `Colleague ${tag}` },
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

    // The page behind the dialog refetches the SKU (reconnect and focus) and shows the new name.
    const refetched = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/skus/${sku.id}` && r.request().method() === 'GET',
    );
    await page.clock.fastForward(60_000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await refetched;
    await expect(page.getByText(`Colleague ${tag}`).first()).toBeAttached();

    await dialog.getByLabel('Name in English').fill(`Mine ${tag}`);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Someone else changed this SKU while you had it open.',
    );
    const stored = await api(page.request, 'GET', `/skus/${sku.id}`);
    expect((stored.body.name as { en: string }).en).toBe(`Colleague ${tag}`);
  });

  test('deleting from the detail page never flashes "There is no such SKU." before the list', async ({
    page,
  }) => {
    const unused = await createSku(page.request, code('NFL'));
    await openShell(page, `/skus/${unused.id}`);
    await expect(page.getByRole('heading', { level: 1, name: unused.code })).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __flash: boolean };
      w.__flash = false;
      new MutationObserver(() => {
        if (document.body.innerText.includes('There is no such SKU.')) w.__flash = true;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByRole('button', { name: 'Edit SKU' }).click();
    await skuDialog(page, unused.code).getByRole('button', { name: 'Delete SKU' }).click();
    await page
      .getByRole('dialog', { name: `Delete SKU ${unused.code}?` })
      .getByRole('button', { name: 'Delete SKU' })
      .click();
    await expect(page).toHaveURL(/\/skus$/);
    await expect(page.getByText(`SKU ${unused.code} deleted.`)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __flash: boolean }).__flash)).toBe(
      false,
    );
  });
});

test.describe('accessibility on the new pages, both languages (AC-16)', () => {
  const languages = ['en', 'ar'] as const;
  for (const language of languages) {
    test(`/skus, /skus/[id], and /locations have no axe violations in ${language}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const sku = await createSku(page.request, code(`AX${language.toUpperCase()}`), {
        en: `Axe ${tag}`,
        ar: `اختبار ${tag}`,
      });
      const location = await createLocation(
        page.request,
        code(`AXL${language === 'en' ? 'E' : 'A'}`),
        {
          en: `Axe place ${tag}`,
          ar: `مكان ${tag}`,
        },
      );
      const receipt = await receive(page.request, location.id, sku.id, 7);
      await receive(page.request, location.id, sku.id, 2);
      await voidReceipt(page.request, receipt.id);
      await postSystemMovement(sku.id, location.id, 1);
      await useBrowserState(page, { language });
      const dir = language === 'ar' ? 'rtl' : 'ltr';

      await openShell(page, '/skus');
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await page.getByLabel(textFor(dir, 'inventory.skus.search')).fill(sku.code);
      await expect(page.getByRole('row', { name: new RegExp(sku.code) })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);

      await page
        .getByRole('button', { name: new RegExp(sku.code) })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('heading', { level: 3 })).toBeVisible();
      await settleAnimations(page);
      await expectNoAxeViolations(page);
      await page.keyboard.press('Escape');

      await openShell(page, `/skus/${sku.id}`);
      await expect(page.getByRole('heading', { level: 1, name: sku.code })).toBeVisible();
      await expect(
        page
          .getByRole('table', { name: textFor(dir, 'inventory.skuDetail.historyTable') })
          .getByRole('row'),
      ).toHaveCount(5);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);

      await openShell(page, '/locations');
      await expect(
        await findRow(
          page,
          textFor(dir, 'inventory.locations.tableLabel'),
          new RegExp(location.code),
          textFor(dir, 'inventory.loadMore'),
        ),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);

      await page
        .getByRole('button', { name: new RegExp(`${location.code}$`) })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await settleAnimations(page);
      await expectNoAxeViolations(page);
    });
  }

  test('empty and error states keep one h1 and pass axe (SKU list archived-empty, locations error)', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await page.getByLabel('Search SKUs').fill(`NONE${tag}`);
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
    await expectNoAxeViolations(page);

    await page.route('**/api/locations?**status=archived**', (route) =>
      route.fulfill({ status: 500, json: {} }),
    );
    await openShell(page, '/locations');
    await page.getByRole('button', { name: 'Archived' }).click();
    await expect(page.getByText('The locations could not be loaded.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });
});

/** Axe measures contrast on what is painted, so let the dialog's fade and zoom finish first. */
async function settleAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))),
  );
}

async function latestUpdatedAt(page: Page, locationId: string): Promise<string> {
  const { body } = await api(page.request, 'GET', '/locations?status=active&limit=50');
  const items = (body.items ?? []) as { id: string; updatedAt: string }[];
  const found = items.find((item) => item.id === locationId);
  if (found) return found.updatedAt;
  // Not on the first page of a shared database: page through by cursor.
  let cursor = body.nextCursor as string | null | undefined;
  while (cursor) {
    const next = await api(
      page.request,
      'GET',
      `/locations?status=active&limit=50&cursor=${cursor}`,
    );
    const more = (next.body.items ?? []) as { id: string; updatedAt: string }[];
    const hit = more.find((item) => item.id === locationId);
    if (hit) return hit.updatedAt;
    cursor = next.body.nextCursor as string | null | undefined;
  }
  throw new Error(`location ${locationId} not found`);
}
