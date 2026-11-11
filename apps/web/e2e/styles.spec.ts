import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { ownerDatabaseUrl } from './auth';
import { api } from './master-data-api';
import { expectNoAxeViolations, openShell, textFor, useBrowserState } from './support';

// Spec 0012, milestone 2 (AC-6 to AC-11, AC-16 to AC-18): the Seasons, Product groups, Styles
// list, and style pages driven in a real browser as the manager (the e2e admin), a warehouse
// person, and a support person, in English and Arabic. Runs in both projects: tables at desktop
// width and cards at phone width. Codes carry a per run tag because the dev database keeps rows
// between runs. Data is planted through the api with the admin's cookie.
const tag = randomUUID().slice(0, 6).toUpperCase();
let counter = 0;
/** A code unique to this worker and call: `<tag><n>`, at most 16 characters. */
const next = (prefix = '') => `${prefix}${tag}${(counter += 1)}`;
const digits = () =>
  `62${Math.floor(Math.random() * 1e11)
    .toString()
    .padStart(11, '0')}`;

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

/** The rows (desktop table) or cards (phone) of a list with this caption. */
function rowsOf(page: Page, label: string): Locator {
  return isPhone(page)
    ? page.getByRole('list', { name: label }).getByRole('listitem')
    : page
        .getByRole('table', { name: label })
        .getByRole('row')
        .filter({ hasNot: page.locator('th') });
}

/** Clicks Load more until a row with this text is on screen (the dev database keeps rows). */
async function rowWith(page: Page, label: string, text: string, loadMore = 'Load more') {
  const rows = rowsOf(page, label);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if ((await rows.filter({ hasText: text }).count()) > 0) break;
    const more = page.getByRole('button', { name: loadMore });
    if (!(await more.isVisible())) {
      await page.waitForTimeout(300);
      if ((await rows.filter({ hasText: text }).count()) > 0) break;
      if (!(await more.isVisible())) break;
    }
    await more.click();
    await page.waitForTimeout(200);
  }
  const row = rows.filter({ hasText: text });
  await expect(row).toHaveCount(1);
  return row;
}

/** Plants a season through the api; returns its id, code, and names. */
async function makeSeason(request: APIRequestContext, extra: Record<string, unknown> = {}) {
  const code = next('S');
  const { status, body } = await api(request, 'POST', '/seasons', {
    code,
    name: { en: `Season ${code}`, ar: `موسم ${code}` },
    ...extra,
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return { id: body.id as string, code, en: `Season ${code}`, ar: `موسم ${code}` };
}

/** Plants a product group through the api. */
async function makeGroup(request: APIRequestContext) {
  const code = next('G');
  const { status, body } = await api(request, 'POST', '/product-groups', {
    code,
    name: { en: `Group ${code}`, ar: `مجموعة ${code}` },
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return { id: body.id as string, code, en: `Group ${code}`, ar: `مجموعة ${code}` };
}

/** Plants a style with one SKU through the api (a style is made by adding a SKU). */
async function makeStyle(
  request: APIRequestContext,
  options: { seasonId?: string; groupId?: string; name?: string; label?: string } = {},
) {
  const styleCode = next(options.label ?? 'ST-');
  const sku = `${styleCode}-1`;
  const { status, body } = await api(request, 'POST', '/products', {
    name: { en: options.name ?? `Style ${styleCode}`, ar: `طراز ${styleCode}` },
    styleCode,
    variants: [{ sku, price: '250.00' }],
    ...(options.seasonId && { seasonId: options.seasonId }),
    ...(options.groupId && { productGroupId: options.groupId }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return { id: body.productId as string, code: styleCode, sku, variantId: body.id as string };
}

/** Adds a SKU to a style through the api. */
async function addSku(
  request: APIRequestContext,
  styleId: string,
  sku: string,
  options: { name: string; value: string }[] = [],
  barcode?: string,
) {
  const { status, body } = await api(request, 'POST', `/styles/${styleId}/variants`, {
    sku,
    options: options.map((option) => ({ name: { en: option.name }, value: { en: option.value } })),
    ...(barcode && { barcode }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body;
}

test.describe('Seasons (AC-6, AC-18) in English', () => {
  test('the manager creates a season with dates, a repeat in lower case says the code is taken, dates out of order are refused', async ({
    page,
  }) => {
    const code = next('SS');
    await openShell(page, '/seasons');
    await expect(page.getByRole('heading', { level: 1, name: 'Seasons' })).toBeVisible();
    await page.getByRole('button', { name: 'New season' }).click();
    const dialog = page.getByRole('dialog', { name: 'New season' });
    await dialog.getByLabel('Code', { exact: true }).fill(code.toLowerCase());
    await dialog.getByLabel('Name in English').fill(`Summer ${tag}`);
    await dialog.getByLabel(/^Starts on/).fill('2027-03-01');
    await dialog.getByLabel(/^Ends on/).fill('2027-08-31');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText(`Season ${code} added.`)).toBeVisible();
    const row = await rowWith(page, 'Seasons', code);
    await expect(row).toContainText(`Summer ${tag}`);
    await expect(row).toContainText('Active');
    await expect(row).toContainText(/Mar|2027/);

    // The same code again, in lower case: refused with the taken wording, the dialog stays.
    await page.getByRole('button', { name: 'New season' }).click();
    const again = page.getByRole('dialog', { name: 'New season' });
    await again.getByLabel('Code', { exact: true }).fill(code.toLowerCase());
    await again.getByLabel('Name in English').fill('Duplicate');
    await again.getByRole('button', { name: 'Add' }).click();
    await expect(again.getByText('Another season already uses this code.')).toBeVisible();
    await expect(again).toBeVisible();

    // Dates out of order are refused before any request.
    await again.getByLabel('Code', { exact: true }).fill(next('SX'));
    await again.getByLabel(/^Starts on/).fill('2027-06-01');
    await again.getByLabel(/^Ends on/).fill('2027-01-01');
    await again.getByRole('button', { name: 'Add' }).click();
    await expect(again.getByText('The end date cannot be before the start date.')).toBeVisible();
    await again.getByRole('button', { name: 'Cancel' }).click();
    await expect(again).toHaveCount(0);
  });

  test('archive leaves the pickers, the Archived tab shows it, unarchive brings it back, an unused season deletes', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const season = await makeSeason(request);
    const style = await makeStyle(request);
    await openShell(page, '/seasons');
    await rowWith(page, 'Seasons', season.code);
    await page.getByRole('button', { name: `Archive season ${season.code}` }).click();
    const confirm = page.getByRole('dialog', { name: `Archive season ${season.code}?` });
    await confirm.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText(`Season ${season.code} archived.`)).toBeVisible();
    await expect(rowsOf(page, 'Seasons').filter({ hasText: season.code })).toHaveCount(0);

    // It is gone from the style edit picker.
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Edit style' }).click();
    const edit = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(edit.getByLabel('Season')).toBeVisible();
    await expect(edit.getByLabel('Season').locator('option', { hasText: season.en })).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await expect(edit).toHaveCount(0);

    // The Archived tab lists it; unarchive restores it.
    await openShell(page, '/seasons');
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    const archived = await rowWith(page, 'Seasons', season.code);
    await expect(archived).toContainText('Archived');
    await page.getByRole('button', { name: `Unarchive season ${season.code}` }).click();
    await page
      .getByRole('dialog', { name: `Unarchive season ${season.code}?` })
      .getByRole('button', { name: 'Unarchive' })
      .click();
    await expect(page.getByText(`Season ${season.code} unarchived.`)).toBeVisible();

    // Unused, so it deletes.
    await page.getByRole('button', { name: 'Active', exact: true }).click();
    await rowWith(page, 'Seasons', season.code);
    await page.getByRole('button', { name: `Delete season ${season.code}` }).click();
    await page
      .getByRole('dialog', { name: `Delete season ${season.code}?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByText(`Season ${season.code} deleted.`)).toBeVisible();
  });

  test('deleting a season a style uses says it is in use; the built in CORE season explains why it cannot be archived or deleted', async ({
    page,
    request,
  }) => {
    const season = await makeSeason(request);
    await makeStyle(request, { seasonId: season.id });
    await openShell(page, '/seasons');
    await rowWith(page, 'Seasons', season.code);
    await page.getByRole('button', { name: `Delete season ${season.code}` }).click();
    const confirm = page.getByRole('dialog', { name: `Delete season ${season.code}?` });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(
      confirm.getByText('Styles or cost records still use this season. Archive it instead.'),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();

    const core = await rowWith(page, 'Seasons', 'CORE');
    await expect(core).toContainText('Built in');
    await expect(core).toContainText(
      'Built in season: you can rename it, but not archive, delete, or recode it.',
    );
    await expect(core.getByRole('button', { name: 'Archive season CORE' })).toHaveCount(0);
    await expect(core.getByRole('button', { name: 'Delete season CORE' })).toHaveCount(0);
    await core.getByRole('button', { name: 'Edit season CORE' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit season CORE' });
    await expect(edit.getByLabel('Code', { exact: true })).toHaveAttribute('readonly', '');
    await expect(edit.getByText('The built in season keeps its code.')).toBeVisible();
  });

  test('a season edit that is stale shows the stale wording with Reload', async ({
    page,
    request,
  }) => {
    const season = await makeSeason(request);
    await openShell(page, '/seasons');
    await rowWith(page, 'Seasons', season.code);
    await page.getByRole('button', { name: `Edit season ${season.code}` }).click();
    const dialog = page.getByRole('dialog', { name: `Edit season ${season.code}` });
    // Someone else changes it first.
    const { body: current } = await api(request, 'GET', `/seasons?q=${season.code}&status=all`);
    const mine = (current.items as { id: string; updatedAt: string }[]).find(
      (item) => item.id === season.id,
    );
    const changed = await api(request, 'PATCH', `/seasons/${season.id}`, {
      updatedAt: mine?.updatedAt,
      name: { en: 'Changed elsewhere' },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await dialog.getByLabel('Name in English').fill('My change');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText(/Someone changed this season since you opened it/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Reload' }).click();
    await expect(dialog.getByLabel('Name in English')).toHaveValue('Changed elsewhere');
    await dialog.getByLabel('Name in English').fill('My change');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Season ${season.code} saved.`)).toBeVisible();
  });
});

test.describe('Product groups (AC-7, AC-18) in English', () => {
  test('create, taken code, in use refusal, delete when unused, and the built in MAIN explanation', async ({
    page,
    request,
  }) => {
    const code = next('PG');
    await openShell(page, '/product-groups');
    await expect(page.getByRole('heading', { level: 1, name: 'Product groups' })).toBeVisible();
    await page.getByRole('button', { name: 'New product group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New product group' });
    await dialog.getByLabel('Code', { exact: true }).fill(code.toLowerCase());
    await dialog.getByLabel('Name in English').fill(`Collective ${tag}`);
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText(`Product group ${code} added.`)).toBeVisible();
    await rowWith(page, 'Product groups', code);

    await page.getByRole('button', { name: 'New product group' }).click();
    const again = page.getByRole('dialog', { name: 'New product group' });
    await again.getByLabel('Code', { exact: true }).fill(code);
    await again.getByLabel('Name in English').fill('Duplicate');
    await again.getByRole('button', { name: 'Add' }).click();
    await expect(again.getByText('Another product group already uses this code.')).toBeVisible();
    await again.getByRole('button', { name: 'Cancel' }).click();

    // A style uses it: delete is refused as in use. Then it deletes once nothing uses it.
    const group = await (async () => {
      const { body } = await api(request, 'GET', `/product-groups?q=${code}&status=all`);
      return (body.items as { id: string }[])[0]?.id ?? '';
    })();
    const style = await makeStyle(request, { groupId: group });
    await page.getByRole('button', { name: `Delete product group ${code}` }).click();
    const confirm = page.getByRole('dialog', { name: `Delete product group ${code}?` });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(
      confirm.getByText('Styles or cost records still use this product group. Archive it instead.'),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();

    const main = await rowWith(page, 'Product groups', 'MAIN');
    await expect(main).toContainText('Built in');
    await expect(main).toContainText(
      'Built in group: you can rename it, but not archive, delete, or recode it.',
    );
    await expect(main.getByRole('button', { name: 'Delete product group MAIN' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Archive product group MAIN' })).toHaveCount(0);

    // Move the style out (to MAIN) and delete the now unused group.
    const mainId = (await api(request, 'GET', '/product-groups?q=MAIN&status=all')).body.items as {
      id: string;
      code: string;
    }[];
    const assign = await api(request, 'POST', '/styles/assign', {
      styleIds: [style.id],
      productGroupId: mainId.find((item) => item.code === 'MAIN')?.id,
    });
    expect(assign.status).toBe(200);
    await page.getByRole('button', { name: `Delete product group ${code}` }).click();
    await page
      .getByRole('dialog', { name: `Delete product group ${code}?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByText(`Product group ${code} deleted.`)).toBeVisible();
  });
});

test.describe('Styles list (AC-8, AC-9, AC-17, AC-18) in English', () => {
  test('filters by season, No season and group, and the search finds by style code', async ({
    page,
    request,
  }) => {
    const season = await makeSeason(request);
    const group = await makeGroup(request);
    const label = next('FL-');
    const inSeason = await makeStyle(request, { seasonId: season.id, label });
    const inGroup = await makeStyle(request, { groupId: group.id, label });
    await openShell(page, '/styles');
    await expect(page.getByRole('heading', { level: 1, name: 'Styles' })).toBeVisible();
    await page.getByLabel('Style code, name, or SKU').fill(label.toLowerCase());
    const rows = rowsOf(page, 'Styles');
    await expect(rows).toHaveCount(2);

    await page.getByLabel('Season', { exact: true }).selectOption({ label: season.en });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(inSeason.code);
    await page.getByLabel('Season', { exact: true }).selectOption({ label: 'No season' });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(inGroup.code);
    await expect(rows).toContainText('No season');
    await page.getByLabel('Season', { exact: true }).selectOption({ label: 'All seasons' });
    await page.getByLabel('Group', { exact: true }).selectOption({ label: group.en });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(inGroup.code);
    await expect(rows).toContainText('Active');

    await page.getByLabel('Group', { exact: true }).selectOption({ label: 'All groups' });
    await page.getByLabel('Season', { exact: true }).selectOption({ label: season.en });
    await page.getByLabel('Group', { exact: true }).selectOption({ label: group.en });
    await expect(page.getByText('No style matches this search.')).toBeVisible();
  });

  test('select three, Set season to one season: all three show it, and the audit holds three style.edited in one action', async ({
    page,
    request,
  }) => {
    const season = await makeSeason(request);
    const label = next('BK-');
    const made = [
      await makeStyle(request, { label }),
      await makeStyle(request, { label }),
      await makeStyle(request, { label }),
    ];
    await openShell(page, '/styles');
    await page.getByLabel('Style code, name, or SKU').fill(label.toLowerCase());
    const rows = rowsOf(page, 'Styles');
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Set season' })).toBeDisabled();
    for (const style of made)
      await page.getByRole('checkbox', { name: `Select style ${style.code}` }).check();
    await expect(page.getByText('Selected styles: 3')).toBeVisible();
    await page.getByRole('button', { name: 'Set season' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set season' });
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByText('Choose a season, or No season.')).toBeVisible();
    await dialog.getByLabel('Season', { exact: true }).selectOption({ label: season.en });
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Styles updated: 3.')).toBeVisible();
    await expect(rows.filter({ hasText: season.en })).toHaveCount(3);
    await expect(page.getByText('Selected styles: 0')).toBeVisible();

    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    try {
      const { rows: audit } = await pool.query<{ entries: string; actions: string }>(
        `SELECT count(*) AS entries, count(DISTINCT correlation_id) AS actions
         FROM audit_entries WHERE action = 'style.edited' AND record_id = ANY($1::uuid[])`,
        [made.map((style) => style.id)],
      );
      expect(audit[0]).toEqual({ entries: '3', actions: '1' });
    } finally {
      await pool.end();
    }
    // The entries are visible on /audit for the manager.
    await openShell(page, '/audit');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('Set group works, and a selected style that is gone answers the not found wording with nothing changed', async ({
    page,
    request,
  }) => {
    const group = await makeGroup(request);
    const label = next('GN-');
    const keep = await makeStyle(request, { label });
    const gone = await makeStyle(request, { label });
    await openShell(page, '/styles');
    await page.getByLabel('Style code, name, or SKU').fill(label.toLowerCase());
    const rows = rowsOf(page, 'Styles');
    await expect(rows).toHaveCount(2);
    await page.getByLabel('Select all shown').check();
    await expect(page.getByText('Selected styles: 2')).toBeVisible();

    // One style disappears behind the screen (planted as the owner: no screen deletes a style).
    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    try {
      await pool.query(
        `DELETE FROM barcodes WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`,
        [gone.id],
      );
      await pool.query(`DELETE FROM product_variants WHERE product_id = $1`, [gone.id]);
      await pool.query(`DELETE FROM product_options WHERE product_id = $1`, [gone.id]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [gone.id]);
    } finally {
      await pool.end();
    }
    await page.getByRole('button', { name: 'Set group' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set group' });
    await dialog.getByLabel('Product group', { exact: true }).selectOption({ label: group.en });
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(
      dialog.getByText(new RegExp(`Some selected styles no longer exist: .*${gone.code}`)),
    ).toBeVisible();
    await expect(dialog.getByText(/Nothing was changed/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // The kept style did not move to the group.
    const { body } = await api(request, 'GET', `/styles/${keep.id}`);
    expect((body.productGroup as { code: string }).code).not.toBe(group.code);
  });

  test('a person with no catalog.edit sees no checkboxes; axe passes on the list', async ({
    page,
    request,
  }) => {
    const label = next('AX-');
    await makeStyle(request, { label });
    await openShell(page, '/styles');
    await page.getByLabel('Style code, name, or SKU').fill(label.toLowerCase());
    await expect(rowsOf(page, 'Styles')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });
});

test.describe('Style page (AC-8, AC-10, AC-11, AC-18) in English', () => {
  test('a stale edit shows the stale wording, Reload shows the other change, and the second save works', async ({
    page,
    request,
  }) => {
    const style = await makeStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 1, name: style.code })).toBeVisible();
    await page.getByRole('button', { name: 'Edit style' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(dialog.getByLabel('Name in English')).toHaveValue(`Style ${style.code}`);

    const current = (await api(request, 'GET', `/styles/${style.id}`)).body;
    const other = await api(request, 'PATCH', `/styles/${style.id}`, {
      updatedAt: current.updatedAt,
      name: { en: 'Renamed elsewhere' },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);

    await dialog.getByLabel('Name in English').fill('My rename');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText(/Someone changed this style since you opened it/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Reload' }).click();
    await expect(dialog.getByLabel('Name in English')).toHaveValue('Renamed elsewhere');
    await dialog.getByLabel('Name in English').fill('My rename');
    await dialog.getByLabel('Tags').fill('summer, cotton');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Style ${style.code} saved.`)).toBeVisible();
    await expect(page.getByText('My rename')).toBeVisible();
    await expect(page.getByText('cotton')).toBeVisible();
  });

  test('at phone width the Edit style dialog keeps Save and Cancel reachable', async ({
    page,
    request,
  }) => {
    test.skip(!isPhone(page), 'the dialog fits the desktop viewport');
    const style = await makeStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Edit style' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(dialog.getByLabel('Name in English')).toBeVisible();
    const viewport = page.viewportSize();
    await page.screenshot({ path: test.info().outputPath('edit-style-phone.png') });
    const save = dialog.getByRole('button', { name: 'Save' });
    await save.scrollIntoViewIfNeeded();
    const box = await save.boundingBox();
    expect(box, 'Save is rendered').not.toBeNull();
    // Reachable: the dialog scrolls inside the viewport, so after scrolling Save is in view.
    expect(box && box.y >= 0 && box.y + box.height <= (viewport?.height ?? 0)).toBe(true);
  });

  test('the manager changes the style code; a taken code is refused', async ({ page, request }) => {
    const style = await makeStyle(request);
    const other = await makeStyle(request);
    const fresh = next('NEW-');
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Change code' }).click();
    const dialog = page.getByRole('dialog', { name: `Change the code of ${style.code}` });
    await dialog.getByLabel('Style code').fill(other.code.toLowerCase());
    await dialog.getByRole('button', { name: 'Change code' }).click();
    await expect(dialog.getByText('Another style already uses this code.')).toBeVisible();
    await dialog.getByLabel('Style code').fill(fresh.toLowerCase());
    await dialog.getByRole('button', { name: 'Change code' }).click();
    await expect(page.getByText(`Style code changed to ${fresh}.`)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: fresh })).toBeVisible();
  });

  test('add a SKU with Color Navy and Size L; the same combination again says it exists', async ({
    page,
    request,
  }) => {
    const style = await makeStyle(request);
    await openShell(page, `/styles/${style.id}`);
    const sku = next('NV-');
    await page.getByRole('button', { name: 'Add SKU' }).click();
    const dialog = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await dialog.getByLabel('SKU code').fill(sku.toLowerCase());
    await dialog.getByLabel('Option 1 name').fill('Color');
    await dialog.getByLabel('Option 1 value').fill('Navy');
    await dialog.getByRole('button', { name: 'Add an option' }).click();
    await dialog.getByLabel('Option 2 name').fill('Size');
    await dialog.getByLabel('Option 2 value').fill('L');
    await dialog.getByLabel('Selling price').fill('300');
    await dialog.getByRole('button', { name: 'Add SKU' }).click();
    await expect(page.getByText(`SKU ${sku} added.`)).toBeVisible();
    await expect(page.getByText('Color (Color)')).toBeVisible();
    await expect(page.getByText('Size (Size)')).toBeVisible();
    const variants = rowsOf(page, 'SKUs of this style');
    await expect(variants.filter({ hasText: sku })).toContainText('Navy, L');
    await expect(variants.filter({ hasText: sku })).toContainText('300.00');

    await page.getByRole('button', { name: 'Add SKU' }).click();
    const again = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await again.getByLabel('SKU code').fill(next('NV-'));
    await again.getByLabel('Option 1 value').fill('navy');
    await again.getByLabel('Option 2 value').fill('l');
    await again.getByRole('button', { name: 'Add SKU' }).click();
    await expect(
      again.getByText('Another active SKU of this style has exactly these options.'),
    ).toBeVisible();
  });

  test('a fourth option name says a style has at most 3 options', async ({ page, request }) => {
    const style = await makeStyle(request);
    await addSku(request, style.id, next('TM-'), [
      { name: 'Size', value: 'S' },
      { name: 'Color', value: 'Red' },
      { name: 'Fabric', value: 'Wool' },
    ]);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Add SKU' }).click();
    const dialog = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await dialog.getByLabel('SKU code').fill(next('TM-'));
    await dialog.getByLabel('Option 1 value').fill('XL');
    await dialog.getByLabel('Option 2 value').fill('Pink');
    await dialog.getByLabel('Option 3 name').fill('Pattern');
    await dialog.getByLabel('Option 3 value').fill('Dots');
    await dialog.getByRole('button', { name: 'Add SKU' }).click();
    await expect(
      dialog.getByText('A style has at most 3 options. Use option names this style already has.'),
    ).toBeVisible();
  });

  test('a barcode another SKU holds names that SKU; a free barcode is added and removed', async ({
    page,
    request,
  }) => {
    const style = await makeStyle(request);
    const held = digits();
    const second = next('BC-');
    await addSku(request, style.id, second, [{ name: 'Size', value: 'M' }], held);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: `Barcodes of ${style.sku}` }).click();
    const dialog = page.getByRole('dialog', { name: `Barcodes of ${style.sku}` });
    await expect(dialog.getByText('No barcodes yet.')).toBeVisible();
    await dialog.getByLabel('New barcode').fill(held);
    await dialog.getByRole('button', { name: 'Add barcode' }).click();
    await expect(dialog.getByText(`This barcode already belongs to SKU ${second}.`)).toBeVisible();

    const free = digits();
    await dialog.getByLabel('New barcode').fill(free);
    await dialog.getByRole('button', { name: 'Add barcode' }).click();
    await expect(page.getByText(`Barcode ${free} added.`)).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Barcodes' })).toContainText(free);
    await dialog.getByRole('button', { name: `Remove barcode ${free}` }).click();
    await expect(page.getByText(`Barcode ${free} removed.`)).toBeVisible();
    await expect(dialog.getByText('No barcodes yet.')).toBeVisible();
  });

  test('the add SKU dialog names the holder of a taken barcode on its barcode field', async ({
    page,
    request,
  }) => {
    const style = await makeStyle(request);
    const held = digits();
    await addSku(request, style.id, next('BH-'), [{ name: 'Size', value: 'M' }], held);
    const holder = (await api(request, 'GET', `/styles/${style.id}`)).body.variants as {
      code: string;
      barcodes: { code: string }[];
    }[];
    const holderCode = holder.find((variant) =>
      variant.barcodes.some((b) => b.code === held),
    )?.code;
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Add SKU' }).click();
    const dialog = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await dialog.getByLabel('SKU code').fill(next('BH-'));
    await dialog.getByLabel('Option 1 name').fill('Size');
    await dialog.getByLabel('Option 1 value').fill('XL');
    await dialog.getByLabel('Barcode').fill(held);
    await dialog.getByRole('button', { name: 'Add SKU' }).click();
    await expect(
      dialog.getByText(`This barcode already belongs to SKU ${holderCode}.`),
    ).toBeVisible();
  });

  test('archiving one of two SKUs keeps the style active; the last one archives it; unarchive restores it (AC-11)', async ({
    page,
    request,
  }) => {
    const style = await makeStyle(request);
    const second = await addSku(request, style.id, next('AR-'), [{ name: 'Size', value: 'M' }]);
    const archive = async (skuId: string) => {
      const result = await api(request, 'POST', `/skus/${skuId}/archive`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    };
    await archive(style.variantId);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(rowsOf(page, 'SKUs of this style').filter({ hasText: style.sku })).toContainText(
      'Archived',
    );
    await expect(page.getByRole('button', { name: 'Add SKU' })).toBeVisible();
    await archive(second.id as string);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: style.code })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add SKU' })).toHaveCount(0);
    const { body: archivedStyle } = await api(request, 'GET', `/styles/${style.id}`);
    expect(archivedStyle.archived).toBe(true);

    const restored = await api(request, 'POST', `/skus/${style.variantId}/unarchive`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Add SKU' })).toBeVisible();
  });

  test('a style that does not exist shows the not found state; the SKU page links to its style', async ({
    page,
    request,
  }) => {
    await openShell(page, `/styles/${randomUUID()}`);
    await expect(page.getByText('This style does not exist, or it was deleted.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to styles' })).toBeVisible();

    const style = await makeStyle(request);
    await openShell(page, `/skus/${style.variantId}`);
    const block = page.getByRole('region', { name: 'About this SKU' });
    await block.getByRole('link', { name: style.code }).click();
    await expect(page).toHaveURL(new RegExp(`/styles/${style.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: style.code })).toBeVisible();
  });

  test('keyboard only: open Edit style, pick a season, save with Enter, close with Escape; axe passes with the dialog open', async ({
    page,
    request,
  }) => {
    test.skip(isPhone(page), 'the keyboard flow is the same at phone width');
    const season = await makeSeason(request);
    const style = await makeStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Edit style' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name in English')).toBeFocused();
    await expectNoAxeViolations(page);
    await dialog.getByLabel('Season', { exact: true }).focus();
    await page.keyboard.type(`Season ${season.code}`.slice(0, 12));
    await dialog.getByLabel('Season', { exact: true }).selectOption({ label: season.en });
    await dialog.getByRole('button', { name: 'Save' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(`Style ${style.code} saved.`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'About this style' })).toContainText(season.en);

    await page.getByRole('button', { name: 'Add SKU' }).press('Enter');
    const add = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await expect(add).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(add).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add SKU' })).toBeFocused();
  });

  test('axe passes on the style page, the add SKU dialog, and the seasons and groups pages', async ({
    page,
    request,
  }) => {
    const style = await makeStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('region', { name: 'About this style' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Add SKU' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');
    for (const [path, label] of [
      ['/seasons', 'Seasons'],
      ['/product-groups', 'Product groups'],
    ] as const) {
      await openShell(page, path);
      await expect(rowsOf(page, label).first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);
    }
  });

  test('at phone width the lists are cards, not tables', async ({ page, request }) => {
    test.skip(!isPhone(page), 'the card layout is the phone project');
    const style = await makeStyle(request);
    await openShell(page, '/styles');
    await page.getByLabel('Style code, name, or SKU').fill(style.code.toLowerCase());
    await expect(page.getByRole('list', { name: 'Styles' }).getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('table', { name: 'Styles' })).toHaveCount(0);
    await openShell(page, '/seasons');
    await expect(page.getByRole('list', { name: 'Seasons' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Seasons' })).toHaveCount(0);
  });
});

test.describe('Gated actions per hat (AC-16, AC-18)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;
  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  test('a support person (stock.view, no catalog.edit) reads a style with no actions and gets no access on /seasons and /product-groups', async ({
    page,
    context,
    baseURL,
    browser,
  }) => {
    person = await seedAccount({ hats: ['support'] });
    await signInThroughApi(context, person, baseURL ?? '');
    const style = await plantAsAdmin(browser, baseURL ?? '');
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 1, name: style.code })).toBeVisible();
    await expect(page.getByRole('region', { name: 'About this style' })).toBeVisible();
    for (const name of ['Edit style', 'Add SKU', 'Change code']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^Barcodes of/ })).toHaveCount(0);

    await openShell(page, '/styles');
    await page.getByLabel('Style code, name, or SKU').fill(style.code.toLowerCase());
    await expect(rowsOf(page, 'Styles')).toHaveCount(1);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Set season' })).toHaveCount(0);

    for (const path of ['/seasons', '/product-groups']) {
      const asked: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (/^\/api\/(seasons|product-groups)/.test(url.pathname)) asked.push(url.pathname);
      });
      await page.goto(path);
      await expect(
        page.getByRole('main').getByText(textFor('ltr', 'access.noAccess.title')),
      ).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      expect(asked).toEqual([]);
    }
  });

  test('a warehouse person edits and adds SKUs but cannot change the code or open /seasons', async ({
    page,
    context,
    baseURL,
    browser,
  }) => {
    person = await seedAccount({ hats: ['warehouse'] });
    await signInThroughApi(context, person, baseURL ?? '');
    const style = await plantAsAdmin(browser, baseURL ?? '');
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('button', { name: 'Edit style' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add SKU' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Barcodes of ${style.sku}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change code' })).toHaveCount(0);
    await page.goto('/seasons');
    await expect(
      page.getByRole('main').getByText(textFor('ltr', 'access.noAccess.title')),
    ).toBeVisible();
  });
});

/** Plants a style as the e2e admin (the manager) in a context of its own. */
async function plantAsAdmin(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    storageState: test.info().project.use.storageState as string,
    baseURL,
  });
  try {
    return await makeStyle(context.request, { label: next('HT-') });
  } finally {
    await context.close();
  }
}

test.describe('Catalog pages in Arabic (AC-18)', () => {
  test('seasons, styles and the style page are right to left with Arabic labels, codes stay left to right, axe passes', async ({
    page,
    request,
  }) => {
    const season = await makeSeason(request);
    const style = await makeStyle(request, { seasonId: season.id });
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);

    await openShell(page, '/seasons');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { level: 1, name: t('catalog.seasons.title') }),
    ).toBeVisible();
    const seasonRow = await rowWith(
      page,
      t('catalog.seasons.tableLabel'),
      season.code,
      t('catalog.common.loadMore'),
    );
    await expect(seasonRow).toContainText(season.ar);
    await expect(seasonRow.locator('bdi[dir="ltr"], [dir="ltr"]').first()).toBeVisible();
    await expectNoAxeViolations(page);

    await openShell(page, '/styles');
    await page.getByLabel(t('catalog.styles.search')).fill(style.code.toLowerCase());
    const rows = rowsOf(page, t('catalog.styles.tableLabel'));
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(`طراز ${style.code}`);
    await expect(rows).toContainText(season.ar);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);

    await openShell(page, `/styles/${style.id}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('region', { name: t('catalog.style.factsTitle') })).toContainText(
      season.ar,
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('button', { name: t('catalog.style.addVariant') })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: t('catalog.style.addVariant') }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('the Arabic taken code and in use wording show on the seasons page', async ({
    page,
    request,
  }) => {
    const season = await makeSeason(request);
    await makeStyle(request, { seasonId: season.id });
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);
    await openShell(page, '/seasons');
    await rowWith(page, t('catalog.seasons.tableLabel'), season.code, t('catalog.common.loadMore'));
    await page
      .getByRole('button', {
        name: t('catalog.seasons.deleteLabel').replace('{{code}}', season.code),
      })
      .click();
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('button', { name: t('catalog.grouping.delete') }).click();
    await expect(confirm.getByText(t('catalog.seasons.errors.IN_USE'))).toBeVisible();
  });
});
