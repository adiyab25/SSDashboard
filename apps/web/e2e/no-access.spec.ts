import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { expectNoAxeViolations, textFor, useBrowserState, waitForPageHydration } from './support';

// Spec 0008 milestone 4, item 1 (AC-11, AC-18): a page opened by its address without its
// permission shows the no access state (one h1, the way out to the overview) and asks the api for
// no business data; the state and /staff (both tabs) are axe clean and work by keyboard, in
// English and Arabic, on desktop and mobile.

const LANGUAGES = [
  { language: 'en', dir: 'ltr' },
  { language: 'ar', dir: 'rtl' },
] as const;

/** The pages gated by `stock.view`, `stock.receive` or `audit.read`, with the title each one keeps as its h1. */
const PAGES = [
  { path: '/stock', title: 'inventory.stock.title' },
  { path: '/stock-receipts', title: 'inventory.receipts.title' },
  { path: '/stock-receipts/new', title: 'inventory.receipt.newTitle' },
  { path: `/stock-receipts/${randomUUID()}`, title: 'inventory.receiptDetail.title' },
  { path: '/skus', title: 'inventory.skus.title' },
  { path: `/skus/${randomUUID()}`, title: 'inventory.skus.title' },
  { path: '/audit', title: 'audit.title' },
] as const;

/** The business data routes these pages read; `/api/locations` is the shell's, checked apart. */
const BUSINESS_DATA = /^\/api\/(stock|skus|stock-receipts|audit)(\/|$)/;

/** Records every request to a business data route and every answer of `/api/locations`. */
function watchRequests(page: Page) {
  const data: string[] = [];
  const locations: number[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (BUSINESS_DATA.test(path)) data.push(`${request.method()} ${path}`);
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/locations') locations.push(response.status());
  });
  return { data, locations };
}

for (const { language, dir } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`a media buyer in ${language}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      person = await seedAccount({ hats: ['media_buyer'], language });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { language });
    });
    test.afterEach(async () => {
      const seeded = person;
      person = undefined;
      await seeded?.remove();
    });

    for (const { path, title } of PAGES) {
      test(`${path.replace(/[0-9a-f-]{36}/, ':id')}: no access state, one h1, no business data asked`, async ({
        page,
      }) => {
        const seen = watchRequests(page);
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        const main = page.getByRole('main');
        await expect(main.getByText(t('access.noAccess.title'))).toBeVisible();
        await expect(page.locator('h1')).toHaveCount(1);
        await expect(main.getByRole('heading', { level: 1, name: t(title) })).toBeVisible();
        await expect(main.getByRole('table')).toHaveCount(0);

        // The way out goes to the overview. Give any late request time to show up first.
        await page.waitForLoadState('networkidle');
        expect(seen.data).toEqual([]);
        // Finding, not a failure: what the shell's location call answers a person with no stock access.
        test.info().annotations.push({ type: 'locations', description: seen.locations.join(',') });
        test.info().annotations.push({
          type: 'shell text',
          description: (await page.locator('header').first().innerText()).replace(/\s+/g, ' '),
        });
      });
    }

    test('the no access state is axe clean and the way out is reached by Tab with a visible focus', async ({
      page,
    }) => {
      await page.goto('/stock');
      const main = page.getByRole('main');
      await expect(main.getByText(t('access.noAccess.title'))).toBeVisible();
      await expectNoAxeViolations(page);

      const home = main.getByRole('link', { name: t('access.noAccess.home') });
      for (let step = 0; step < 40; step += 1) {
        if (await home.evaluate((element) => element === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(home).toBeFocused();
      // A visible focus: Radix and shadcn draw a ring (box-shadow or outline) on :focus-visible.
      const ring = await home.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
          shadow: style.boxShadow !== 'none',
        };
      });
      expect(ring.outline || ring.shadow).toBe(true);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/(\?.*)?$/);
    });
  });
}

test.describe('a support person on the receipt form', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sees the no access state: support holds stock.view but not stock.receive', async ({
    page,
    context,
    baseURL,
  }) => {
    const person = await seedAccount({ hats: ['support'] });
    try {
      await signInThroughApi(context, person, baseURL ?? '');
      await page.goto('/stock-receipts/new');
      const main = page.getByRole('main');
      await expect(main.getByText(textFor('ltr', 'access.noAccess.title'))).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(
        main.getByRole('heading', { level: 1, name: textFor('ltr', 'inventory.receipt.newTitle') }),
      ).toBeVisible();
      await expect(
        main.getByRole('button', { name: textFor('ltr', 'inventory.receipt.post') }),
      ).toHaveCount(0);
    } finally {
      await person.remove();
    }
  });
});

// /staff, both tabs: axe clean and operable by keyboard, as the seeded manager (the suite's sign in).
for (const { language, dir } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test(`/staff tabs in ${language}: axe clean on both, arrows switch, Tab enters the panel`, async ({
    page,
  }) => {
    await useBrowserState(page, { language });
    await page.goto('/staff');
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await expect(page.getByRole('heading', { level: 1, name: t('staff.title') })).toBeVisible();
    await waitForPageHydration(page);

    const staff = page.getByRole('tab', { name: t('staff.tabs.staff') });
    const partners = page.getByRole('tab', { name: t('staff.tabs.partners') });
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoAxeViolations(page);

    // The next tab lies at the end side: ArrowLeft in Arabic, ArrowRight in English.
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    await staff.focus();
    await page.keyboard.press(forward);
    await expect(partners).toBeFocused();
    await expect(partners).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: t('staff.tabs.partners') })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: t('staff.partners.search') })).toBeVisible();
    await expectNoAxeViolations(page);

    // Tab leaves the tab list and lands inside the panel it controls.
    await page.keyboard.press('Tab');
    const panel = page.getByRole('tabpanel', { name: t('staff.tabs.partners') });
    await expect(panel.locator(':focus')).toHaveCount(1);

    await partners.focus();
    await page.keyboard.press(back);
    await expect(staff).toBeFocused();
    await expect(staff).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: t('staff.tabs.staff') })).toBeVisible();
  });
}

test.describe('a person without audit.read', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sees the no access state on /audit, with no request to the audit entries', async ({
    page,
    context,
    baseURL,
  }) => {
    const person = await seedAccount({ hats: ['support', 'operations', 'warehouse'] });
    try {
      await signInThroughApi(context, person, baseURL ?? '');
      const seen = watchRequests(page);
      await page.goto('/audit');
      const main = page.getByRole('main');
      await expect(main.getByText(textFor('ltr', 'access.noAccess.title'))).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      expect(seen.data).toEqual([]);
    } finally {
      await person.remove();
    }
  });
});

for (const { language, dir } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test(`a gated page whose /api/me fails shows an error with Try again, in ${language}`, async ({
    page,
  }) => {
    // The suite's saved sign in is a manager with cost: once /api/me answers again, /stock opens.
    await useBrowserState(page, { language });
    await page.route('**/api/me', (route) => route.fulfill({ status: 500, json: {} }));
    const seen = watchRequests(page);
    await page.goto('/stock');
    const main = page.getByRole('main');
    await expect(main.getByText(t('access.loadError.message'))).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(
      main.getByRole('heading', { level: 1, name: t('inventory.stock.title') }),
    ).toBeVisible();
    expect(seen.data).toEqual([]);
    await expectNoAxeViolations(page);

    await page.unroute('**/api/me');
    await main.getByRole('button', { name: t('access.loadError.retry') }).click();
    await expect(main.getByRole('table', { name: t('inventory.stock.tableLabel') })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByText(t('access.loadError.message'))).toHaveCount(0);
  });
}

test('the receipt form keeps its one h1 and shows a skeleton while access loads', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/me', async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto('/stock-receipts/new');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { level: 1, name: textFor('ltr', 'inventory.receipt.newTitle') }),
  ).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(main.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expectNoAxeViolations(page);
  await page.unroute('**/api/me');
  release();
  await expect(
    main.getByRole('button', { name: textFor('ltr', 'inventory.receipt.post') }),
  ).toBeVisible();
});
