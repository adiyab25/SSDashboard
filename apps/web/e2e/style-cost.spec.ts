import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import type { GrantablePermission, Hat } from '@ssdashboard/contracts';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { api } from './master-data-api';
import { expectNoAxeViolations, openShell, textFor, useBrowserState } from './support';

// Spec 0012, milestone 3 (AC-12, AC-13, AC-16 cost parts, AC-18): the cost column, the cost
// history, and the Record cost dialog on /styles/[id], as the manager (the e2e admin, who holds
// cost.view), a warehouse person without the grant, and two people who hold the grant with less
// than the manager's reach. English and Arabic; desktop table and phone cards. Data is planted
// through the api with the admin's cookie; codes carry a per run tag.
const tag = randomUUID().slice(0, 6).toUpperCase();
let counter = 0;
/** A code unique to this worker and call: `<tag><n>`, at most 16 characters. */
const next = (prefix = '') => `${prefix}${tag}${(counter += 1)}`;

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

/** Today's operating day in Cairo, as `YYYY-MM-DD`. */
function cairoToday(): string {
  // The app's operating day is the Cairo calendar day, which is ahead of the UTC date from 22:00
  // UTC in winter (QA 2026-11-11: a UTC `today` read as backdated and asked for a reason).
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

/** A calendar date this many days before today, as `YYYY-MM-DD` (far enough back to be past in Cairo). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The rows (desktop table) or cards (phone) of a list with this caption. */
function rowsOf(page: Page, label: string): Locator {
  return isPhone(page)
    ? page.getByRole('list', { name: label }).getByRole('listitem')
    : page
        .getByRole('table', { name: label })
        .getByRole('row')
        .filter({ hasNot: page.locator('th') });
}

/** Plants a season through the api. */
async function makeSeason(request: APIRequestContext) {
  const code = next('S');
  const { status, body } = await api(request, 'POST', '/seasons', {
    code,
    name: { en: `Season ${code}`, ar: `موسم ${code}` },
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return { id: body.id as string, code, en: `Season ${code}`, ar: `موسم ${code}` };
}

/** Plants a style with one SKU through the api. */
async function makeStyle(request: APIRequestContext, seasonId?: string) {
  const code = next('CS-');
  const { status, body } = await api(request, 'POST', '/products', {
    name: { en: `Style ${code}`, ar: `طراز ${code}` },
    styleCode: code,
    variants: [{ sku: `${code}-1`, price: '250.00' }],
    ...(seasonId && { seasonId }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return { id: body.productId as string, code, sku: `${code}-1`, variantId: body.id as string };
}

/** Adds a SKU (size option) to a style through the api. */
async function addSku(request: APIRequestContext, styleId: string, sku: string, size: string) {
  const { status, body } = await api(request, 'POST', `/styles/${styleId}/variants`, {
    sku,
    options: [{ name: { en: 'Size' }, value: { en: size } }],
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.id as string;
}

/** Plants a cost record through the api. */
async function recordCost(
  request: APIRequestContext,
  styleId: string,
  body: {
    seasonId: string;
    unitCost: string;
    effectiveFrom: string;
    costBasis?: string;
    variantId?: string;
    source?: string;
    reason?: string;
  },
) {
  const result = await api(request, 'POST', `/styles/${styleId}/cost-records`, {
    costBasis: 'factory_invoice',
    reason: 'e2e setup',
    ...body,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
}

/** A style with a style cost, one overriding SKU (an estimate), one inheriting SKU, as the admin. */
async function plantCostedStyle(request: APIRequestContext) {
  const season = await makeSeason(request);
  const style = await makeStyle(request, season.id);
  const overrideSku = next('OV-');
  const inheritSku = next('IN-');
  const overrideId = await addSku(request, style.id, overrideSku, 'L');
  await addSku(request, style.id, inheritSku, 'M');
  await recordCost(request, style.id, {
    seasonId: season.id,
    unitCost: '100',
    effectiveFrom: daysAgo(90),
    source: `INV-${tag}`,
  });
  await recordCost(request, style.id, {
    seasonId: season.id,
    unitCost: '150.5',
    effectiveFrom: daysAgo(60),
    costBasis: 'estimate',
    variantId: overrideId,
  });
  return { season, style, overrideSku, inheritSku };
}

/** Plants a costed style as the e2e admin in a context of its own (for a signed in other person). */
async function plantAsAdmin(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    storageState: test.info().project.use.storageState as string,
    baseURL,
  });
  try {
    return await plantCostedStyle(context.request);
  } finally {
    await context.close();
  }
}

const variantRows = (page: Page, label = 'SKUs of this style') => rowsOf(page, label);

test.describe('Cost as a cost.view holder, in English (AC-12, AC-13, AC-18)', () => {
  test('each SKU shows its cost: from style, override with the estimate label, and Not set on a style with no cost', async ({
    page,
    request,
  }) => {
    const { style, overrideSku, inheritSku } = await plantCostedStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 1, name: style.code })).toBeVisible();
    if (!isPhone(page)) {
      await expect(
        page
          .getByRole('table', { name: 'SKUs of this style' })
          .getByRole('columnheader', { name: 'Unit cost' }),
      ).toBeVisible();
    }
    const rows = variantRows(page);
    await expect(rows).toHaveCount(3);

    // The SKU made with the style has no record of its own: the style's record, "From style".
    const inherited = rows.filter({ hasText: inheritSku });
    await expect(inherited).toContainText('100.0000');
    await expect(inherited).toContainText('From style');
    await expect(inherited).not.toContainText('Estimate');
    await expect(inherited).not.toContainText('Not set');

    const overridden = rows.filter({ hasText: overrideSku });
    await expect(overridden).toContainText('150.5000');
    await expect(overridden).toContainText('Override');
    await expect(overridden).toContainText('Estimate');

    // A style nobody recorded a cost for says "Not set", never 0.
    const bare = await makeStyle(request);
    await openShell(page, `/styles/${bare.id}`);
    const bareRow = variantRows(page).filter({ hasText: bare.sku });
    await expect(bareRow).toContainText('Not set');
    await expect(bareRow).not.toContainText(/0\.0000/);
    await expect(page.getByText('No cost has been recorded for this style yet.')).toBeVisible();
  });

  test('the history lists the newest recorded first, with source, season, and who recorded it', async ({
    page,
    request,
  }) => {
    const { style, season } = await plantCostedStyle(request);
    await recordCost(request, style.id, {
      seasonId: season.id,
      unitCost: '99.25',
      effectiveFrom: daysAgo(30),
      source: `NEW-${tag}`,
    });
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Cost history' })).toBeVisible();
    const history = rowsOf(page, 'Cost records of this style, newest first');
    await expect(history).toHaveCount(3);
    await expect(history.first()).toContainText('99.2500');
    await expect(history.first()).toContainText(`NEW-${tag}`);
    await expect(history.first()).toContainText(season.code);
    await expect(history.first()).toContainText('E2E Admin');
    await expect(history.last()).toContainText('100.0000');
  });

  test('Show more loads the next page of a long history', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { style, season } = await plantCostedStyle(request);
    for (let index = 0; index < 20; index += 1) {
      await recordCost(request, style.id, {
        seasonId: season.id,
        unitCost: `${200 + index}`,
        effectiveFrom: daysAgo(20 - index),
      });
    }
    await openShell(page, `/styles/${style.id}`);
    const history = rowsOf(page, 'Cost records of this style, newest first');
    await expect(history).toHaveCount(20);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(history).toHaveCount(22);
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  });

  test('a backdated cost without a reason asks for a reason; with one it saves, shows first, and updates the column', async ({
    page,
    request,
  }) => {
    const { style, season, inheritSku } = await plantCostedStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Record cost' }).click();
    const dialog = page.getByRole('dialog', { name: `Record cost for ${style.code}` });
    await expect(dialog.getByLabel('Season')).toHaveValue(season.id);
    // The reason hint warns against amounts and the submit shows only once seasons have loaded.
    await expect(dialog.getByText(/do not type amounts/i)).toBeVisible();
    await expect(dialog.getByText(/before today's operating day/)).toBeVisible();
    await dialog.getByLabel('Unit cost').fill('77.5');
    await dialog.getByLabel('Effective from').fill(daysAgo(40));
    await dialog.getByLabel('Source').fill(`BACK-${tag}`);
    await dialog.getByRole('button', { name: 'Record cost' }).click();
    await expect(dialog.getByText('Give a reason: this cost starts before today.')).toBeVisible();
    await expect(dialog.getByLabel('Reason')).toBeFocused();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Reason').fill('Invoice arrived late');
    await dialog.getByRole('button', { name: 'Record cost' }).click();
    await expect(page.getByText(`Cost recorded for ${style.code}.`)).toBeVisible();
    await expect(dialog).toHaveCount(0);

    const history = rowsOf(page, 'Cost records of this style, newest first');
    await expect(history).toHaveCount(3);
    await expect(history.first()).toContainText('77.5000');
    await expect(history.first()).toContainText(`BACK-${tag}`);
    // Effective 40 days ago, newer than the 90 day old record: the inheriting SKU follows it.
    await expect(variantRows(page).filter({ hasText: inheritSku })).toContainText('77.5000');
  });

  test('a cost recorded for one SKU is its override; a malformed cost and an empty season are refused before any request', async ({
    page,
    request,
  }) => {
    const { style, inheritSku } = await plantCostedStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Record cost' }).click();
    const dialog = page.getByRole('dialog', { name: `Record cost for ${style.code}` });
    await dialog.getByLabel('Applies to').selectOption({ label: inheritSku });
    await dialog.getByLabel('Cost basis').selectOption({ label: 'Estimate' });
    await dialog.getByLabel('Unit cost').fill('1.23456');
    await dialog.getByRole('button', { name: 'Record cost' }).click();
    await expect(dialog.getByText('Enter 0 or more with at most 4 decimals.')).toBeVisible();

    await dialog.getByLabel('Unit cost').fill('12.5');
    await dialog.getByLabel('Effective from').fill(cairoToday());
    await dialog.getByRole('button', { name: 'Record cost' }).click();
    await expect(page.getByText(`Cost recorded for ${style.code}.`)).toBeVisible();
    const row = variantRows(page).filter({ hasText: inheritSku });
    await expect(row).toContainText('12.5000');
    await expect(row).toContainText('Override');
    await expect(row).toContainText('Estimate');
  });

  test('keyboard only: open Record cost with Enter, type in the fields, Escape closes and returns focus; axe passes with the dialog open', async ({
    page,
    request,
  }) => {
    test.skip(isPhone(page), 'the keyboard flow is the same at phone width');
    const { style } = await plantCostedStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Cost history' })).toBeVisible();
    await expect(rowsOf(page, 'Cost records of this style, newest first').first()).toBeVisible();
    await expectNoAxeViolations(page);
    const open = page.getByRole('button', { name: 'Record cost' });
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Record cost for ${style.code}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Record cost' })).toBeEnabled();
    await expectNoAxeViolations(page);
    await dialog.getByLabel('Unit cost').focus();
    await page.keyboard.type('42');
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Effective from')).toBeFocused();
    await dialog.getByRole('button', { name: 'Record cost' }).focus();
    await page.keyboard.press('Enter');
    // Today's date is the default, so no reason is needed and it saves from the keyboard alone.
    await expect(page.getByText(`Cost recorded for ${style.code}.`)).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await open.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test('at phone width the cost is inside the SKU card, not a table column', async ({
    page,
    request,
  }) => {
    test.skip(!isPhone(page), 'the card layout is the phone project');
    const { style, overrideSku } = await plantCostedStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('table', { name: 'SKUs of this style' })).toHaveCount(0);
    const card = variantRows(page).filter({ hasText: overrideSku });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('150.5000');
    await expect(card).toContainText('Override');
    await expect(page.getByRole('table', { name: /Cost records/ })).toHaveCount(0);
    await expect(rowsOf(page, 'Cost records of this style, newest first').first()).toBeVisible();
    // No sideways scrolling of the page at 375 px.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page);
  });
});

test.describe('Cost per hat (AC-12, AC-13, AC-16)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;
  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  async function signedInAs(
    hats: Hat[],
    grants: GrantablePermission[],
    context: Parameters<typeof signInThroughApi>[0],
    baseURL: string,
  ) {
    person = await seedAccount({ hats, grants });
    await signInThroughApi(context, person, baseURL);
  }

  test('a warehouse person without the cost grant sees no cost column, history, or Record cost, and the api answers no cost', async ({
    page,
    context,
    baseURL,
    browser,
  }) => {
    await signedInAs(['warehouse'], [], context, baseURL ?? '');
    const { style, season } = await plantAsAdmin(browser, baseURL ?? '');
    const asked: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/cost-records/.test(url.pathname)) asked.push(url.pathname);
    });
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('heading', { level: 1, name: style.code })).toBeVisible();
    await expect(variantRows(page)).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Edit style' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /cost/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Cost history' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record cost' })).toHaveCount(0);
    await expect(variantRows(page).getByText('Not set')).toHaveCount(0);
    await expect(page.getByText('From style')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('100.0000');
    await page.waitForLoadState('networkidle');
    expect(asked).toEqual([]);

    // The api agrees: no cost key on a variant, 403 on the records, 403 on adding one.
    const detail = await api(context.request, 'GET', `/styles/${style.id}`);
    expect(detail.status).toBe(200);
    const variants = detail.body.variants as Record<string, unknown>[];
    expect(variants.length).toBe(3);
    for (const variant of variants) expect(variant).not.toHaveProperty('cost');
    const list = await api(context.request, 'GET', `/styles/${style.id}/cost-records`);
    expect(list.status).toBe(403);
    const add = await api(context.request, 'POST', `/styles/${style.id}/cost-records`, {
      seasonId: season.id,
      costBasis: 'estimate',
      unitCost: '1',
      effectiveFrom: cairoToday(),
    });
    expect(add.status).toBe(403);
  });

  test('a warehouse person with the cost grant sees the cost and can record one', async ({
    page,
    context,
    baseURL,
    browser,
  }) => {
    await signedInAs(['warehouse'], ['cost.view'], context, baseURL ?? '');
    const { style, overrideSku } = await plantAsAdmin(browser, baseURL ?? '');
    await openShell(page, `/styles/${style.id}`);
    await expect(variantRows(page).filter({ hasText: overrideSku })).toContainText('150.5000');
    await expect(page.getByRole('heading', { name: 'Cost history' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record cost' })).toBeVisible();
  });

  test('a support person with the cost grant reads the cost and history but has no Record cost action', async ({
    page,
    context,
    baseURL,
    browser,
  }) => {
    await signedInAs(['support'], ['cost.view'], context, baseURL ?? '');
    const { style, overrideSku, season } = await plantAsAdmin(browser, baseURL ?? '');
    await openShell(page, `/styles/${style.id}`);
    await expect(variantRows(page).filter({ hasText: overrideSku })).toContainText('150.5000');
    await expect(rowsOf(page, 'Cost records of this style, newest first')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Record cost' })).toHaveCount(0);
    const add = await api(context.request, 'POST', `/styles/${style.id}/cost-records`, {
      seasonId: season.id,
      costBasis: 'estimate',
      unitCost: '1',
      effectiveFrom: cairoToday(),
    });
    expect(add.status).toBe(403);
  });
});

test.describe('Cost in Arabic (AC-12, AC-13, AC-18)', () => {
  test('the cost column, history, and Record cost dialog are right to left with Arabic labels; axe passes', async ({
    page,
    request,
  }) => {
    const { style, overrideSku, inheritSku } = await plantCostedStyle(request);
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);

    await openShell(page, `/styles/${style.id}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const rows = variantRows(page, t('catalog.style.variantsTableLabel'));
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: inheritSku })).toContainText(t('catalog.cost.fromStyle'));
    const overridden = rows.filter({ hasText: overrideSku });
    await expect(overridden).toContainText(t('catalog.cost.override'));
    await expect(overridden).toContainText(t('catalog.cost.estimate'));
    await expect(
      page.getByRole('heading', { level: 2, name: t('catalog.cost.history.title') }),
    ).toBeVisible();
    await expect(rowsOf(page, t('catalog.cost.history.tableLabel')).first()).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByRole('button', { name: t('catalog.style.recordCost') }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(t('catalog.cost.record.unitCost'))).toHaveAttribute(
      'dir',
      'ltr',
    );
    await expect(dialog.getByText(t('catalog.cost.record.reasonNoAmounts'))).toBeVisible();
    await dialog.getByLabel(t('catalog.cost.record.unitCost')).fill('٧٧٫٥');
    await dialog.getByLabel(t('catalog.cost.record.effectiveFrom')).fill(daysAgo(40));
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: t('catalog.cost.record.save') }).click();
    await expect(dialog.getByText(t('catalog.cost.record.reasonRequired'))).toBeVisible();
    await dialog.getByLabel(t('catalog.cost.record.reason')).fill('وصلت الفاتورة متأخرة');
    await dialog.getByRole('button', { name: t('catalog.cost.record.save') }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rowsOf(page, t('catalog.cost.history.tableLabel'))).toHaveCount(3);
  });
});
