import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ownAddress, seedAccount, signInThroughApi } from './accounts';
import { createLocation, createSku, findRow, receive } from './master-data-api';
import {
  chooseLocation,
  openStockAt,
  receiveMany,
  searchPicker,
  seedStockScene,
  waitForStock,
} from './stock-helpers';
import { openShell, textFor, useBrowserState, type TextDirection } from './support';

// Spec 0006, Milestone 4, AC-9: the Stock page in a real browser, as an admin and as staff, in
// English and Arabic. Every test builds its own location, so a shared database that keeps rows
// between runs cannot change what a test sees.
test.beforeEach(({ viewport }) => {
  test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the Stock page flows');
});

const LANGUAGES = [
  { language: 'en', dir: 'ltr' },
  { language: 'ar', dir: 'rtl' },
] as const;

const grid = (page: Page, dir: TextDirection) =>
  page.getByRole('table', { name: textFor(dir, 'inventory.stock.tableLabel') });

for (const { language, dir } of LANGUAGES) {
  test.describe(`Stock page in ${language} (AC-9)`, () => {
    test.beforeEach(async ({ page }) => {
      await useBrowserState(page, { language });
    });

    test('hides rows at zero by default, shows them with the toggle, and flags a negative row', async ({
      page,
    }) => {
      const scene = await seedStockScene(page.request);
      await openStockAt(page, dir, scene.location);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      const table = grid(page, dir);

      // The default list: the stocked row and the negative one, no row at zero.
      await expect(table.getByRole('row', { name: new RegExp(scene.stocked.code) })).toBeVisible();
      const negativeRow = table.getByRole('row', { name: new RegExp(scene.negative.code) });
      await expect(negativeRow).toBeVisible();
      await expect(negativeRow.getByText(textFor(dir, 'inventory.stock.negative'))).toBeVisible();
      await expect(negativeRow).toContainText('3');
      await expect(table.getByRole('row', { name: new RegExp(scene.zero.code) })).toHaveCount(0);
      // Only the negative row carries the flag.
      await expect(table.getByText(textFor(dir, 'inventory.stock.negative'))).toHaveCount(1);
      await expect(table.getByRole('row')).toHaveCount(3);

      // Show rows at zero adds the voided one, with 0 on hand.
      const withZero = waitForStock(page, { locationId: scene.location.id, includeZero: true });
      await page.getByLabel(textFor(dir, 'inventory.stock.showZero')).check();
      await withZero;
      const zeroRow = table.getByRole('row', { name: new RegExp(scene.zero.code) });
      await expect(zeroRow).toBeVisible();
      await expect(zeroRow).toContainText('0');
      await expect(table.getByRole('row')).toHaveCount(4);

      // Off again, and it goes away (the first answer is cached, so no new request is needed).
      await page.getByLabel(textFor(dir, 'inventory.stock.showZero')).uncheck();
      await expect(table.getByRole('row', { name: new RegExp(scene.zero.code) })).toHaveCount(0);
      await expect(table.getByRole('row')).toHaveCount(3);
    });

    test('filters by SKU from the keyboard and clears the filter', async ({ page }) => {
      const scene = await seedStockScene(page.request);
      await openStockAt(page, dir, scene.location);
      const table = grid(page, dir);
      await expect(table.getByRole('row')).toHaveCount(3);

      const trigger = page.locator('#stock-sku-filter');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await searchPicker(page, scene.stocked.code);
      await expect(
        page.getByRole('option', { name: new RegExp(scene.stocked.code) }),
      ).toBeVisible();
      const filtered = waitForStock(page, {
        locationId: scene.location.id,
        skuId: scene.stocked.id,
      });
      await page.keyboard.press('Enter');
      await filtered;
      await expect(trigger).toContainText(scene.stocked.code);
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table.getByRole('row', { name: new RegExp(scene.stocked.code) })).toBeVisible();

      // Focus returns to the trigger; one Tab reaches Clear, and Enter clears the filter.
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Tab');
      const clear = page.getByRole('button', { name: textFor(dir, 'inventory.stock.clearSku') });
      await expect(clear).toBeFocused();
      // The unfiltered list is still cached, so clearing may not send a request at all.
      await page.keyboard.press('Enter');
      await expect(clear).toHaveCount(0);
      await expect(trigger).not.toContainText(scene.stocked.code);
      await expect(table.getByRole('row')).toHaveCount(3);

      // The next Tab stop is the Show rows at zero checkbox, and Space toggles it.
      await trigger.focus();
      await page.keyboard.press('Tab');
      const zeroBox = page.getByLabel(textFor(dir, 'inventory.stock.showZero'));
      await expect(zeroBox).toBeFocused();
      const withZero = waitForStock(page, { locationId: scene.location.id, includeZero: true });
      await page.keyboard.press('Space');
      await withZero;
      await expect(zeroBox).toBeChecked();
      await expect(table.getByRole('row')).toHaveCount(4);
    });

    test('follows the shell location switcher: one location, another, then all', async ({
      page,
    }) => {
      const one = await seedStockScene(page.request);
      const two = await seedStockScene(page.request);
      await openStockAt(page, dir, one.location);
      const table = grid(page, dir);
      const scope = page.locator('main p', {
        hasText: textFor(dir, 'inventory.stock.scope').split('{{location}}')[1] ?? '',
      });
      await expect(scope).toContainText(language === 'ar' ? `مشهد ${one.tag}` : one.location.name);
      await expect(table.getByRole('row', { name: new RegExp(one.stocked.code) })).toBeVisible();
      await expect(table.getByRole('row', { name: new RegExp(two.stocked.code) })).toHaveCount(0);

      const second = waitForStock(page, { locationId: two.location.id });
      await chooseLocation(page, dir, two.location.code);
      await second;
      await expect(table.getByRole('row', { name: new RegExp(two.stocked.code) })).toBeVisible();
      await expect(table.getByRole('row', { name: new RegExp(one.stocked.code) })).toHaveCount(0);

      // All locations: both locations' rows are reachable
      // (a shared database may hold more than a page of rows, so page until each is found).
      // (The all locations list from the first load is cached, so it may not be asked again.)
      await chooseLocation(page, dir, 'all');
      await expect(scope).toContainText(textFor(dir, 'shell.locations.all'));
      const label = textFor(dir, 'inventory.stock.tableLabel');
      const loadMore = textFor(dir, 'inventory.loadMore');
      await expect(
        await findRow(page, label, new RegExp(one.stocked.code), loadMore),
      ).toBeVisible();
      await expect(
        await findRow(page, label, new RegExp(two.stocked.code), loadMore),
      ).toBeVisible();
    });

    test('lists the most recent movement first', async ({ page }) => {
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const location = await createLocation(page.request, `OR-${tag}`, { en: `Order ${tag}` });
      const first = await createSku(page.request, `ONE-${tag}`);
      const second = await createSku(page.request, `TWO-${tag}`);
      await receive(page.request, location.id, first.id, 1);
      await receive(page.request, location.id, second.id, 1);
      await openStockAt(page, dir, location);
      const rows = grid(page, dir).getByRole('row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(1)).toContainText(second.code);
      await expect(rows.nth(2)).toContainText(first.code);
    });

    test('pages 50 rows at a time with Load more', async ({ page }) => {
      test.setTimeout(120_000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const location = await createLocation(page.request, `LM-${tag}`, { en: `Many ${tag}` });
      const skus = await Promise.all(
        Array.from({ length: 55 }, (_, index) =>
          createSku(page.request, `MANY-${tag}-${String(index).padStart(2, '0')}`),
        ),
      );
      await receiveMany(
        page.request,
        location.id,
        skus.map((sku) => sku.id),
      );
      await openStockAt(page, dir, location);
      const table = grid(page, dir);
      await expect(table.getByRole('row')).toHaveCount(51);
      const more = page.getByRole('button', { name: textFor(dir, 'inventory.loadMore') });
      await expect(more).toBeVisible();

      const next = waitForStock(page, { locationId: location.id, cursor: true });
      await more.click();
      await next;
      await expect(table.getByRole('row')).toHaveCount(56);
      await expect(more).toHaveCount(0);
    });

    test('says so when there is no stock, and when a filter matches nothing', async ({ page }) => {
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const location = await createLocation(page.request, `EM-${tag}`, { en: `Empty ${tag}` });
      const idle = await createSku(page.request, `IDLE-${tag}`);
      await openStockAt(page, dir, location);

      await expect(page.getByText(textFor(dir, 'inventory.stock.emptyTitle'))).toBeVisible();
      await expect(page.getByText(textFor(dir, 'inventory.stock.emptyBody'))).toBeVisible();
      await expect(
        grid(page, dir).getByRole('link', { name: textFor(dir, 'inventory.stock.receive') }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      // Any filter turns it into the "no match" wording, with no Receive stock shortcut.
      const withZero = waitForStock(page, { locationId: location.id, includeZero: true });
      await page.getByLabel(textFor(dir, 'inventory.stock.showZero')).check();
      await withZero;
      await expect(
        page.getByText(textFor(dir, 'inventory.stock.filteredEmptyTitle')),
      ).toBeVisible();
      await expect(page.getByText(textFor(dir, 'inventory.stock.emptyTitle'))).toHaveCount(0);
      await page.getByLabel(textFor(dir, 'inventory.stock.showZero')).uncheck();
      await expect(page.getByText(textFor(dir, 'inventory.stock.emptyTitle'))).toBeVisible();

      const trigger = page.locator('#stock-sku-filter');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await searchPicker(page, idle.code);
      const filtered = waitForStock(page, { locationId: location.id, skuId: idle.id });
      await page.keyboard.press('Enter');
      await filtered;
      await expect(
        page.getByText(textFor(dir, 'inventory.stock.filteredEmptyTitle')),
      ).toBeVisible();
      await expect(page.getByText(textFor(dir, 'inventory.stock.filteredEmptyBody'))).toBeVisible();
    });

    test('shows an error with Try again, and recovers', async ({ page }) => {
      test.setTimeout(60_000);
      await page.route(/\/api\/stock\?/, (route) => route.fulfill({ status: 500, json: {} }));
      await openShell(page, '/stock');
      // A server error is retried twice before the page gives up.
      await expect(page.getByText(textFor(dir, 'inventory.stock.loadError'))).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(grid(page, dir)).toHaveCount(0);

      await page.unroute(/\/api\/stock\?/);
      const again = waitForStock(page);
      await page.getByRole('button', { name: textFor(dir, 'inventory.retry') }).click();
      await again;
      await expect(grid(page, dir)).toBeVisible();
      await expect(page.getByText(textFor(dir, 'inventory.stock.loadError'))).toHaveCount(0);
    });
  });
}

test.describe('staff see no cost columns on the Stock page (AC-9, AC-11)', () => {
  for (const { language, dir } of LANGUAGES) {
    test(`in ${language}: no Average cost or Stock value, and no cost in the answer`, async ({
      page,
      browser,
      baseURL,
    }) => {
      const scene = await seedStockScene(page.request);
      const clerkAccount = await seedAccount({ role: 'staff', language });
      const clerk = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
      try {
        // The admin (the saved session) sees both cost columns, with 10 at 5.0000 worth 50.00.
        await useBrowserState(page, { language });
        await openStockAt(page, dir, scene.location);
        const adminTable = grid(page, dir);
        await expect(
          adminTable.getByRole('columnheader', {
            name: textFor(dir, 'inventory.stock.columns.avgCost'),
          }),
        ).toBeVisible();
        await expect(
          adminTable.getByRole('columnheader', {
            name: textFor(dir, 'inventory.stock.columns.value'),
          }),
        ).toBeVisible();
        await expect(
          adminTable.getByRole('row', { name: new RegExp(scene.stocked.code) }),
        ).toContainText('50.00');

        await signInThroughApi(clerk, clerkAccount, baseURL ?? '');
        await clerk.addCookies([
          { name: 'ss_lang', value: language, url: baseURL ?? 'http://localhost:3000' },
        ]);
        const clerkPage = await clerk.newPage();
        const answer = clerkPage.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/stock',
        );
        await openShell(clerkPage, '/stock');
        const body = await (await answer).text();
        expect(body).not.toMatch(/avgUnitCost|totalValue|unitCost/);
        const table = grid(clerkPage, dir);
        await expect(
          table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.onHand') }),
        ).toBeVisible();
        await expect(table.getByRole('columnheader')).toHaveCount(5);
        await expect(
          table.getByRole('columnheader', {
            name: textFor(dir, 'inventory.stock.columns.avgCost'),
          }),
        ).toHaveCount(0);
        await expect(
          table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.value') }),
        ).toHaveCount(0);
        await expect(
          clerkPage.getByRole('button', { name: textFor(dir, 'inventory.stock.newLocation') }),
        ).toHaveCount(0);
      } finally {
        await clerk.close();
        await clerkAccount.remove().catch(() => undefined);
      }
    });
  }
});
