import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ownAddress, seedAccount, signInThroughApi, WORKING_HATS } from './accounts';
import { createLocation, createSku, findRow, receive } from './master-data-api';
import { openStockAt, searchPicker, seedStockScene } from './stock-steps';
import {
  expectNoAxeViolations,
  openShell,
  textFor,
  useBrowserState,
  waitForFormHydration,
} from './support';

// Spec 0006, AC-16: every page feature 7 added (/stock, /stock-receipts, /stock-receipts/new,
// /stock-receipts/[id], /skus, /skus/[id], /locations) passes axe (WCAG 2.2 AA) in English and
// Arabic with one h1 in every state, and its dialogs do too. /skus, /skus/[id], /locations and
// their edit dialogs are also swept in master-data.spec.ts; this file adds the rest, the
// loading, empty, and error states, the confirm steps, and the keyboard only receipt form.
test.beforeEach(({ viewport }) => {
  test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the accessibility sweep');
});

const LANGUAGES = [
  { language: 'en', dir: 'ltr' },
  { language: 'ar', dir: 'rtl' },
] as const;

/** Axe measures contrast on what is painted, so let a dialog's fade and zoom finish first. */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // A skeleton pulses forever; only the ones that end are worth waiting for.
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );
}

async function expectOneH1(page: Page) {
  // Not by role: a modal dialog hides the page behind it from the accessibility tree.
  await expect(page.locator('h1')).toHaveCount(1);
}

/** The page is clean as it stands: one h1, no axe violations. */
async function expectClean(page: Page) {
  await expectOneH1(page);
  await settle(page);
  await expectNoAxeViolations(page);
}

/** Holds every request matching `pattern` until `release` is called. */
async function holdRequests(page: Page, pattern: RegExp) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

const skeleton = (page: Page) => page.locator('main [data-slot="skeleton"]').first();

/** Presses Tab until `target` has focus, so a test reaches a control the way a keyboard user does. */
async function tabTo(page: Page, target: Locator, direction: 'forward' | 'back' = 'forward') {
  for (let step = 0; step < 25; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab');
  }
  await expect(target).toBeFocused();
}

async function setCookie(page: Page, baseURL: string | undefined, name: string, value: string) {
  await page.context().addCookies([{ name, value, url: baseURL ?? 'http://localhost:3000' }]);
}

for (const { language, dir } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`accessibility sweep in ${language} (AC-16)`, () => {
    test.beforeEach(async ({ page }) => {
      await useBrowserState(page, { language });
    });

    test('/stock: loaded, and the New SKU and New location dialogs with their errors', async ({
      page,
    }) => {
      const scene = await seedStockScene(page.request);
      await openStockAt(page, dir, scene.location);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.getByRole('row', { name: new RegExp(scene.stocked.code) })).toBeVisible();
      await expectClean(page);

      // With the SKU filter picker open.
      await page.locator('#stock-sku-filter').click();
      await expect(page.getByPlaceholder(t('inventory.receipt.searchSku'))).toBeVisible();
      await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible();
      await expectClean(page);
      await page.keyboard.press('Escape');

      for (const [button, title, create] of [
        ['inventory.stock.newSku', 'inventory.sku.createTitle', 'inventory.sku.create'],
        [
          'inventory.stock.newLocation',
          'inventory.location.createTitle',
          'inventory.location.create',
        ],
      ] as const) {
        await page.getByRole('button', { name: t(button) }).click();
        const dialog = page.getByRole('dialog', { name: t(title) });
        await expect(dialog).toBeVisible();
        await expectClean(page);
        // Submitting empty shows the field errors; the dialog stays clean.
        await dialog.getByRole('button', { name: t(create) }).click();
        await expect(dialog.locator('[aria-invalid="true"]').first()).toBeFocused();
        await expectClean(page);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
    });

    test('/stock states: loading skeleton, empty, filtered empty, and error', async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      const release = await holdRequests(page, /\/api\/stock\?/);
      await page.goto('/stock');
      await expect(skeleton(page)).toBeVisible();
      await expect(
        page.getByRole('table', { name: t('inventory.stock.tableLabel') }),
      ).toHaveAttribute('aria-busy', 'true');
      await expectClean(page);
      await page.unroute(/\/api\/stock\?/);
      release();

      await page.route(/\/api\/stock\?/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      await page.reload();
      await expect(page.getByText(t('inventory.stock.emptyTitle'))).toBeVisible();
      await expectClean(page);
      await page.getByLabel(t('inventory.stock.showZero')).check();
      await expect(page.getByText(t('inventory.stock.filteredEmptyTitle'))).toBeVisible();
      await expectClean(page);

      await page.unroute(/\/api\/stock\?/);
      await page.route(/\/api\/stock\?/, (route) => route.fulfill({ status: 500, json: {} }));
      await setCookie(page, baseURL, 'ss_location', 'all');
      await page.reload();
      await expect(page.getByText(t('inventory.stock.loadError'))).toBeVisible({ timeout: 20_000 });
      await expectClean(page);
    });

    test('/stock-receipts: loaded, searched to nothing, loading, empty, and error', async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      const scene = await seedStockScene(page.request);
      await setCookie(page, baseURL, 'ss_location', scene.location.id);
      // The first request is for all locations (the switcher has not loaded yet); wait for the
      // one that is scoped to the saved place.
      const scoped = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/stock-receipts' &&
          url.searchParams.get('locationId') === scene.location.id
        );
      });
      await openShell(page, '/stock-receipts');
      await scoped;
      const table = page.getByRole('table', { name: t('inventory.receipts.tableLabel') });
      await expect(table.getByRole('row', { name: /SR-/ }).first()).toBeVisible();
      await expect(
        table.getByText(t('inventory.receiptDetail.status.voided'), { exact: true }),
      ).toHaveCount(1);
      await expectClean(page);

      const none = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/stock-receipts' && url.searchParams.get('q') === 'nope-none';
      });
      await page.getByLabel(t('inventory.receipts.search')).fill('nope-none');
      await none;
      await expect(page.getByText(t('inventory.receipts.noMatch'))).toBeVisible();
      await expectClean(page);

      const release = await holdRequests(page, /\/api\/stock-receipts\?/);
      await page.reload();
      await expect(skeleton(page)).toBeVisible();
      await expectClean(page);
      await page.unroute(/\/api\/stock-receipts\?/);
      release();

      await page.route(/\/api\/stock-receipts\?/, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      await page.reload();
      await expect(page.getByText(t('inventory.receipts.emptyTitle'))).toBeVisible();
      await expectClean(page);

      await page.unroute(/\/api\/stock-receipts\?/);
      await page.route(/\/api\/stock-receipts\?/, (route) =>
        route.fulfill({ status: 500, json: {} }),
      );
      await page.reload();
      await expect(page.getByText(t('inventory.receipts.loadError'))).toBeVisible({
        timeout: 20_000,
      });
      await expectClean(page);
    });

    test('/stock-receipts/new: empty, with line errors, with the picker open, and with two lines', async ({
      page,
    }) => {
      await openShell(page, '/stock-receipts/new');
      await waitForFormHydration(page);
      await expect(
        page.getByRole('heading', { level: 1, name: t('inventory.receipt.newTitle') }),
      ).toBeVisible();
      await expectClean(page);

      // Posting empty shows every error at once.
      await page.getByRole('button', { name: t('inventory.receipt.post') }).click();
      await expect(page.getByText(t('inventory.receipt.errors.locationRequired'))).toBeVisible();
      await expect(page.getByText(t('inventory.receipt.errors.skuRequired'))).toBeVisible();
      await expectClean(page);

      // The picker open with results, then two filled lines.
      await page.locator('#line-0-sku').click();
      await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible();
      await expectClean(page);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: t('inventory.receipt.addLine') }).click();
      await expect(page.locator('#line-1-sku')).toBeVisible();
      await page.getByLabel(t('inventory.receipt.location')).selectOption({ index: 1 });
      await page.locator('#line-0-quantity').fill('0');
      await page.locator('#line-0-cost').fill('abc');
      await page.getByRole('button', { name: t('inventory.receipt.post') }).click();
      await expect(
        page.getByText(t('inventory.receipt.errors.quantityInvalid')).first(),
      ).toBeVisible();
      await expect(
        page.getByText(t('inventory.receipt.errors.unitCostInvalid')).first(),
      ).toBeVisible();
      await expectClean(page);
    });

    test('/stock-receipts/[id]: posted, the Void dialog and its error, then voided', async ({
      page,
    }) => {
      const scene = await seedStockScene(page.request);
      const posted = await receive(page.request, scene.location.id, scene.stocked.id, 2);
      await openShell(page, `/stock-receipts/${posted.id}`);
      await expect(page.getByRole('heading', { level: 1, name: posted.number })).toBeVisible();
      await expect(
        page.getByText(t('inventory.receiptDetail.status.posted'), { exact: true }),
      ).toBeVisible();
      await expectClean(page);

      await page.getByRole('button', { name: t('inventory.void.open') }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expectClean(page);
      await dialog.getByRole('button', { name: t('inventory.void.confirm') }).click();
      await expect(dialog.getByText(t('inventory.void.errors.reasonRequired'))).toBeVisible();
      await expect(dialog.getByLabel(t('inventory.void.reason'))).toBeFocused();
      await expectClean(page);
      await dialog.getByLabel(t('inventory.void.reason')).fill('Entered twice');
      await dialog.getByRole('button', { name: t('inventory.void.confirm') }).click();
      await expect(
        page.getByText(t('inventory.receiptDetail.status.voided'), { exact: true }),
      ).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expectClean(page);
    });

    for (const kind of ['receipt', 'sku'] as const) {
      const entry: {
        path: string;
        api: RegExp;
        notFound: Parameters<typeof textFor>[1];
        failed: Parameters<typeof textFor>[1];
      } =
        kind === 'receipt'
          ? {
              path: `/stock-receipts/${randomUUID()}`,
              api: /\/api\/stock-receipts\/[0-9a-f-]{36}$/,
              notFound: 'inventory.receiptDetail.notFound',
              failed: 'inventory.receiptDetail.loadError',
            }
          : {
              path: `/skus/${randomUUID()}`,
              api: /\/api\/skus\/[0-9a-f-]{36}$/,
              notFound: 'inventory.skuDetail.notFound',
              failed: 'inventory.skuDetail.loadError',
            };

      test(`${kind} detail page: the loading skeleton keeps the page's one h1`, async ({
        page,
      }) => {
        const release = await holdRequests(page, entry.api);
        await page.goto(entry.path);
        await expect(skeleton(page)).toBeVisible();
        // WCAG 2.4.6 and AC-16: exactly one h1 on every page, whatever state it is in.
        await expectClean(page);
        await page.unroute(entry.api);
        release();
      });

      test(`${kind} detail page: not found and error states`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.goto(entry.path);
        await expect(page.getByText(t(entry.notFound))).toBeVisible();
        await expectClean(page);

        await page.route(entry.api, (route) => route.fulfill({ status: 500, json: {} }));
        await page.reload();
        await expect(page.getByText(t(entry.failed))).toBeVisible({ timeout: 20_000 });
        await expectClean(page);
      });
    }

    test('/skus and /locations states: loading, empty, and error', async ({ page }) => {
      test.setTimeout(90_000);
      const lists = [
        {
          path: '/skus',
          api: /\/api\/skus\?/,
          empty: 'inventory.skus.emptyTitle',
          failed: 'inventory.skus.loadError',
        },
        {
          path: '/locations',
          api: /\/api\/locations\?.*status=/,
          empty: 'inventory.locations.emptyTitle',
          failed: 'inventory.locations.loadError',
        },
      ] as const;
      for (const entry of lists) {
        const release = await holdRequests(page, entry.api);
        await page.goto(entry.path);
        await expect(skeleton(page)).toBeVisible();
        await expectClean(page);
        await page.unroute(entry.api);
        release();

        await page.route(entry.api, (route) =>
          route.fulfill({ json: { items: [], nextCursor: null } }),
        );
        await page.reload();
        await expect(page.getByText(t(entry.empty))).toBeVisible();
        await expectClean(page);
        await page.unroute(entry.api);

        await page.route(entry.api, (route) => route.fulfill({ status: 500, json: {} }));
        await page.reload();
        await expect(page.getByText(t(entry.failed))).toBeVisible({ timeout: 20_000 });
        await expectClean(page);
        await page.unroute(entry.api);
      }
    });

    test('New SKU and New location dialogs on /skus and /locations, and the confirm steps', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const sku = await createSku(page.request, `CF-${tag}`, {
        en: `Confirm ${tag}`,
        ar: `تأكيد ${tag}`,
      });
      const location = await createLocation(page.request, `CF-${tag}`, {
        en: `Confirm place ${tag}`,
        ar: `مكان ${tag}`,
      });

      // /skus: the New SKU dialog, then the edit dialog's Archive and Delete confirm steps.
      await openShell(page, '/skus');
      await page.getByRole('button', { name: t('inventory.stock.newSku') }).click();
      await expect(
        page.getByRole('dialog', { name: t('inventory.sku.createTitle') }),
      ).toBeVisible();
      await expectClean(page);
      await page.keyboard.press('Escape');
      await page.getByLabel(t('inventory.skus.search')).fill(sku.code);
      await page
        .getByRole('button', { name: new RegExp(sku.code) })
        .first()
        .click();
      const edit = page.getByRole('dialog').first();
      await expect(
        edit.getByRole('button', { name: t('inventory.skuEdit.archive') }),
      ).toBeVisible();
      for (const [action, title] of [
        ['inventory.skuEdit.archive', 'inventory.skuEdit.archiveTitle'],
        ['inventory.skuEdit.delete', 'inventory.skuEdit.deleteTitle'],
      ] as const) {
        await edit.getByRole('button', { name: t(action) }).click();
        const confirm = page.getByRole('dialog', {
          name: new RegExp(t(title).replace('{{code}}', sku.code).replace('?', '\\?')),
        });
        await expect(confirm).toBeVisible();
        await expectClean(page);
        await confirm.getByRole('button', { name: t('inventory.cancel') }).click();
        await expect(confirm).toHaveCount(0);
      }
      await page.keyboard.press('Escape');

      // /locations: the New location dialog and the archive confirm step on a row.
      await openShell(page, '/locations');
      await page.getByRole('button', { name: t('inventory.locations.newLocation') }).click();
      await expect(
        page.getByRole('dialog', { name: t('inventory.location.createTitle') }),
      ).toBeVisible();
      await expectClean(page);
      await page.keyboard.press('Escape');
      // A shared database can hold more than a page of locations: page until this one shows.
      await findRow(
        page,
        t('inventory.locations.tableLabel'),
        new RegExp(location.code),
        t('inventory.loadMore'),
      );
      await page
        .getByRole('button', {
          name: t('inventory.locations.archiveLabel').replace('{{code}}', location.code),
        })
        .click();
      const archive = page.getByRole('dialog');
      await expect(archive).toBeVisible();
      await expectClean(page);
    });

    test('a person without cost access: /stock, the receipt form, and a receipt stay clean', async ({
      page,
      browser,
      baseURL,
    }) => {
      const scene = await seedStockScene(page.request);
      const posted = await receive(page.request, scene.location.id, scene.stocked.id, 2);
      const account = await seedAccount({ hats: WORKING_HATS, language });
      const clerk = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
      try {
        await signInThroughApi(clerk, account, baseURL ?? '');
        await clerk.addCookies([
          { name: 'ss_lang', value: language, url: baseURL ?? 'http://localhost:3000' },
          {
            name: 'ss_location',
            value: scene.location.id,
            url: baseURL ?? 'http://localhost:3000',
          },
        ]);
        const staff = await clerk.newPage();
        await openShell(staff, '/stock');
        await expect(
          staff.getByRole('row', { name: new RegExp(scene.stocked.code) }),
        ).toBeVisible();
        await expectClean(staff);
        await openShell(staff, '/stock-receipts/new');
        await waitForFormHydration(staff);
        await expectClean(staff);
        await openShell(staff, `/stock-receipts/${posted.id}`);
        await expect(staff.getByRole('heading', { level: 1, name: posted.number })).toBeVisible();
        await expectClean(staff);
      } finally {
        await clerk.close();
        await account.remove().catch(() => undefined);
      }
    });
  });
}

test.describe('dialog close controls (WCAG 2.5.3, AC-16)', () => {
  test('each stock dialog has exactly one control named Cancel, the corner icon being Close', async ({
    page,
  }) => {
    const scene = await seedStockScene(page.request);
    const posted = await receive(page.request, scene.location.id, scene.stocked.id, 1);
    await openShell(page, '/stock');
    for (const [button, title] of [
      ['New SKU', 'New SKU'],
      ['New location', 'New location'],
    ] as const) {
      await page.getByRole('button', { name: button }).click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
      await page.keyboard.press('Escape');
    }
    await openShell(page, `/stock-receipts/${posted.id}`);
    await page.getByRole('button', { name: 'Void receipt' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
  });
});

test.describe('the receipt form by keyboard alone (AC-16)', () => {
  for (const { language, dir } of LANGUAGES) {
    test(`in ${language}: picks a place and SKUs, adds and removes lines, posts, and the Stock page follows`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(120_000);
      const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      // English only name, so the option text is the same in both languages and can be typed.
      const location = await createLocation(page.request, `KB-${tag}`, { en: `Keys ${tag}` });
      const first = await createSku(page.request, `KBA-${tag}`, { en: `Alpha ${tag}` });
      const second = await createSku(page.request, `KBB-${tag}`, { en: `Beta ${tag}` });
      await useBrowserState(page, { language });
      await setCookie(page, baseURL, 'ss_location', location.id);

      // The Stock page first: it caches an empty list the post must refresh.
      await openShell(page, '/stock');
      await expect(page.getByText(t('inventory.stock.emptyTitle'))).toBeVisible();
      await page
        .getByRole('link', { name: t('inventory.stock.receive') })
        .first()
        .click();
      await expect(page).toHaveURL(/\/stock-receipts\/new$/);
      await waitForFormHydration(page);

      // The place: a select, picked by typing its text.
      const select = page.getByLabel(t('inventory.receipt.location'));
      await select.focus();
      await page.keyboard.type(`Keys ${tag} · KB-${tag}`);
      await expect(select).toHaveValue(location.id);

      // Line 1: SKU through the combobox, then quantity and cost.
      const pick = async (
        index: number,
        sku: { code: string },
        direction: 'forward' | 'back' = 'forward',
      ) => {
        const trigger = page.locator(`#line-${index}-sku`);
        await tabTo(page, trigger, direction);
        await page.keyboard.press('Enter');
        await searchPicker(page, sku.code);
        await expect(page.getByRole('option', { name: new RegExp(sku.code) })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(trigger).toContainText(sku.code);
        await expect(trigger).toBeFocused();
      };
      await pick(0, first);
      await tabTo(page, page.locator('#line-0-quantity'));
      await page.keyboard.type('3');
      await page.keyboard.press('Tab');
      await expect(page.locator('#line-0-cost')).toBeFocused();
      await page.keyboard.type('1.5');

      // Add a line, fill it, add a third, and remove the third.
      const add = page.getByRole('button', { name: t('inventory.receipt.addLine') });
      await tabTo(page, add);
      await page.keyboard.press('Enter');
      await expect(page.locator('#line-1-sku')).toBeVisible();
      // Adding a line puts focus in the new line's quantity (RHF), after its SKU: Shift+Tab goes back.
      await pick(1, second, 'back');
      await tabTo(page, page.locator('#line-1-quantity'));
      await page.keyboard.type('4');
      await page.keyboard.press('Tab');
      await page.keyboard.type('2');

      await tabTo(page, add);
      await page.keyboard.press('Enter');
      await expect(page.locator('#line-2-sku')).toBeVisible();
      const removeThird = page.getByRole('button', {
        name: t('inventory.receipt.removeLine').replace('{{number}}', '3'),
      });
      await tabTo(page, removeThird);
      await page.keyboard.press('Enter');
      await expect(page.locator('#line-2-sku')).toHaveCount(0);
      await expect(page.locator('#line-1-sku')).toContainText(second.code);
      // Removing a line must not drop focus on the page body (WCAG 2.4.3).
      await expect.soft(page.locator('body')).not.toBeFocused();
      await expect.soft(page.locator('main').locator(':focus')).toHaveCount(1);

      // Post with Enter on the button.
      await tabTo(page, page.getByRole('button', { name: t('inventory.receipt.post') }));
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/stock-receipts\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(/SR-\d{4}-\d{6}/);
      // The header, the two lines, and the total row.
      await expect(
        page.getByRole('table', { name: t('inventory.receiptDetail.tableLabel') }).getByRole('row'),
      ).toHaveCount(4);

      // Back to Stock through the side navigation, no reload: the new rows are there.
      await page.getByRole('link', { name: t('shell.nav.items.stock'), exact: true }).click();
      const table = page.getByRole('table', { name: t('inventory.stock.tableLabel') });
      await expect(table.getByRole('row', { name: new RegExp(first.code) })).toBeVisible();
      await expect(table.getByRole('row', { name: new RegExp(second.code) })).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(3);
    });
  }

  test('the SKU picker: Escape closes it and returns focus, and Enter before results picks nothing', async ({
    page,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const sku = await createSku(page.request, `KBC-${tag}`);
    await openShell(page, '/stock-receipts/new');
    await waitForFormHydration(page);
    const trigger = page.locator('#line-0-sku');
    await trigger.focus();
    await page.keyboard.press('Space');
    await expect(page.getByPlaceholder('Search by code or name…')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await searchPicker(page, sku.code);
    await expect(page.getByRole('option', { name: new RegExp(sku.code) })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(trigger).toContainText(sku.code);
  });
});

// BUG-8: the shared table scrolls sideways at a phone width, so axe reports
// `scrollable-region-focusable` unless the scroll container can take focus. The mobile project
// skips these flows, so this sweep sets a 375 px viewport inside the desktop project's test.
for (const { language, dir } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`phone width (375 px) axe sweep in ${language} (AC-16, BUG-8)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 740 });
      await useBrowserState(page, { language });
    });

    for (const [path, tableKey] of [
      ['/stock', 'inventory.stock.tableLabel'],
      ['/stock-receipts', 'inventory.receipts.tableLabel'],
      ['/skus', 'inventory.skus.tableLabel'],
    ] as const) {
      test(`${path} with rows has no axe violations and a keyboard reachable table`, async ({
        page,
        baseURL,
      }) => {
        test.setTimeout(90_000);
        const scene = await seedStockScene(page.request);
        // Scope /stock and /stock-receipts to the seeded place so rows are certain.
        await setCookie(page, baseURL, 'ss_location', scene.location.id);
        await openShell(page, path);
        await expect(page.getByRole('main')).toBeVisible();
        const table = page.getByRole('table', { name: t(tableKey) });
        await expect(table.getByRole('row')).not.toHaveCount(1);
        await expect(table.getByRole('row').nth(1)).toBeVisible();
        await expect(table).not.toHaveAttribute('aria-busy', 'true');

        // The table's scroll container is a named, focusable region.
        const region = page.getByRole('region', { name: t(tableKey) });
        await expect(region).toHaveAttribute('tabindex', '0');
        await region.focus();
        await expect(region).toBeFocused();
        if (path === '/stock') {
          // The case that failed before the fix: the stock table is wider than the phone.
          expect(
            await region.evaluate((element) => element.scrollWidth > element.clientWidth),
          ).toBe(true);
        }

        await expectClean(page);
      });
    }
  });
}
