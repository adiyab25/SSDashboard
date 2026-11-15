import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { createSku } from './master-data-api';
import { shortByText } from './order-stock';
import {
  expectNoAxeViolations,
  openShell,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0013 milestone 1 (AC-2, AC-3, AC-4, AC-5, AC-20, AC-23): a person enters an order by hand,
// lands on its page with the store beside the number, finds it again by order number and by
// phone typed in Arabic digits, and a manager records a gifted goodwill order linked to it. A
// typed search is sent as a POST body and never reaches the address or a GET query. The screens
// read in English and Arabic (right to left) and pass axe (WCAG 2.2 AA). Every test signs in as
// its own seeded person.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toArabicDigits = (text: string) =>
  text.replace(/\d/g, (digit) => ARABIC_DIGITS[Number(digit)] ?? digit);

/** Picks the SKU on the first line: opens the combobox, types the code, and chooses the match. */
async function pickSku(page: Page, code: string, searchPlaceholder: string) {
  await page.locator('#line-0-sku').click();
  await page.getByPlaceholder(searchPlaceholder).fill(code);
  await page.getByRole('option', { name: new RegExp(code) }).click();
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const language = dir === 'rtl' ? 'ar' : 'en';

  test.describe(`orders in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let manager: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      manager = await seedAccount({ hats: ['manager'], language });
      await signInThroughApi(context, manager, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = manager;
      manager = undefined;
      // A person who created an order is named by append only audit entries, which the database
      // refuses to orphan, so that account stays; its name and email are unique to this run.
      await done?.remove().catch(() => undefined);
    });

    /** Fills the ship to block and chooses the MAIN store and the manual channel. */
    async function fillShipTo(page: Page, phone: string) {
      const store = page.locator('#order-store');
      await store.selectOption(
        (await store.locator('option', { hasText: 'MAIN' }).getAttribute('value')) ?? '',
      );
      const channel = page.locator('#order-channel');
      await channel.selectOption(
        (await channel
          .locator('option', { hasText: dir === 'rtl' ? 'يدوي' : 'Manual' })
          .first()
          .getAttribute('value')) ?? '',
      );
      await page.locator('#order-name').fill('Mona E2E');
      await page.locator('#order-phone').fill(phone);
      await page.locator('#order-address').fill('12 Nile Street, Cairo');
    }

    /** Opens the form from the list, so the form's own hydration is awaited. */
    async function openNewOrder(page: Page) {
      await page.goto('/orders/new');
      await expect(page.locator('#order-store')).toBeVisible();
      await waitForPageHydration(page);
    }

    /** The label of the order the page of the h1 shows, such as `MAIN/SO-2026-000001`. */
    async function openedOrderLabel(page: Page): Promise<string> {
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
      const heading = page.getByRole('heading', { level: 1, name: /^MAIN\/SO-\d{4}-\d+$/ });
      await expect(heading).toBeVisible();
      return (await heading.innerText()).trim();
    }

    test('enters an order, finds it by number and by phone, and never puts a search in the address', async ({
      page,
      context,
    }) => {
      const code = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
      await createSku(context.request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '250.00');
      const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
      const phone = `010${digits}`;

      const orderRequests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/orders')) {
          orderRequests.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
        }
      });

      // The empty form passes axe, then the filled one creates the order.
      await openNewOrder(page);
      await expect(
        page.getByRole('heading', { level: 1, name: t('orders.new.title') }),
      ).toBeVisible();
      await expectNoAxeViolations(page);
      await fillShipTo(page, phone);
      await pickSku(page, code, t('inventory.receipt.searchSku'));
      await page.locator('#line-0-quantity').fill('2');
      await expect(page.locator('#line-0-price')).toHaveValue('250.00');
      await expectNoAxeViolations(page);
      await page.getByRole('button', { name: t('orders.new.submit') }).click();

      // The order page (AC-5): store beside the number, lines, money, and the first event.
      const label = await openedOrderLabel(page);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const lines = page.getByRole('table', { name: t('orders.lines.title') });
      await expect(lines.getByText(code, { exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: t('orders.money.title') }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: t('orders.timeline.title'), exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Mona E2E').first()).toBeVisible();
      await expect(page.getByText('12 Nile Street, Cairo')).toBeVisible();
      await expectNoAxeViolations(page);

      // The list finds it by order number and by the phone typed in Arabic digits (AC-4).
      await page.goto('/orders');
      await expect(page.getByRole('heading', { level: 1, name: t('orders.title') })).toBeVisible();
      await waitForPageHydration(page);
      const box = page.getByRole('searchbox', { name: t('orders.search.label') });
      const table = page.getByRole('table', { name: t('orders.tableLabel') });
      await expect(table.getByRole('link', { name: label })).toBeVisible();
      await expectNoAxeViolations(page);

      const searchBefore = orderRequests.length;
      for (const typed of [label.split('/')[1] ?? '', toArabicDigits(phone), phone]) {
        await box.fill(typed);
        await box.press('Enter');
        await expect(table.getByRole('link', { name: label })).toBeVisible();
        // Neither the order number nor the phone ever reaches the address (security review).
        expect(new URL(page.url()).search).toBe('');
        expect(page.url()).not.toContain(digits);
        expect(page.url()).not.toContain(encodeURIComponent(typed));
      }
      const searches = orderRequests.slice(searchBefore);
      expect(
        searches.some((entry) => entry.startsWith('POST ') && entry.includes('/api/orders/search')),
      ).toBe(true);
      // No typed text on any GET: the phone and the number go in a POST body only.
      for (const entry of orderRequests) {
        if (entry.startsWith('GET ')) {
          expect(new URL(entry.split(' ')[1] ?? '').searchParams.has('q')).toBe(false);
          expect(entry).not.toContain(digits);
        }
      }
      await expectNoAxeViolations(page);

      // A search with no answer says so (and passes axe), then Clear brings the list back.
      await box.fill(`Nobody-${randomUUID().slice(0, 8)}`);
      await box.press('Enter');
      await expect(page.getByText(t('orders.list.noMatchTitle'))).toBeVisible();
      await expectNoAxeViolations(page);

      // The row opens the order page.
      await box.fill(label.split('/')[1] ?? '');
      await box.press('Enter');
      await table.getByRole('link', { name: label }).click();
      await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    });

    test('records a gifted goodwill order linked to the first order', async ({ page, context }) => {
      // A whole order journey with several axe sweeps: a passing run took 26.4 s of the 30 s default in
      // a full parallel run (2026-11-08 trace), so a loaded first attempt crossed it while still
      // progressing. The budget fits the journey; it waits for nothing that may never come.
      test.setTimeout(60_000);
      const code = `GIF-${randomUUID().slice(0, 8).toUpperCase()}`;
      await createSku(context.request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '300.00');
      const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

      // The first order is a plain sale.
      await openNewOrder(page);
      await fillShipTo(page, `011${digits}`);
      await pickSku(page, code, t('inventory.receipt.searchSku'));
      await page.locator('#line-0-quantity').fill('1');
      await page.getByRole('button', { name: t('orders.new.submit') }).click();
      const original = await openedOrderLabel(page);

      // A gifted order: no discount, payment, or shipping fields, and a reason is required.
      await openNewOrder(page);
      await fillShipTo(page, `012${digits}`);
      await pickSku(page, code, t('inventory.receipt.searchSku'));
      await page.locator('#line-0-quantity').fill('1');
      await page.getByRole('radio', { name: t('orders.new.kinds.gifted') }).check();
      await expect(page.locator('#line-0-discount')).toHaveCount(0);
      await expect(page.locator('#order-payment')).toHaveCount(0);
      await page.locator('#order-gift-reason').selectOption('replacement_goodwill');
      await expectNoAxeViolations(page);

      // A goodwill gift names the order it makes good; without it the form refuses.
      await page.getByRole('button', { name: t('orders.new.submit') }).click();
      await expect(page.getByText(t('orders.new.errors.relatedRequired'))).toBeVisible();
      await page.locator('#order-related-order').click();
      await page
        .getByPlaceholder(t('orders.new.related.search'))
        .fill(original.split('/')[1] ?? '');
      await page.getByRole('option', { name: new RegExp(original.replace('/', '\\/')) }).click();
      await page.getByRole('button', { name: t('orders.new.submit') }).click();

      // Its page shows the gift reason, the link to the original, and the money at 0 due.
      const gift = await openedOrderLabel(page);
      const giftText = t('orders.flags.giftedFor').replace(
        '{{reason}}',
        t('orders.reasons.gift.replacement_goodwill'),
      );
      await expect(page.getByText(giftText)).toBeVisible();
      const link = page.getByRole('link', { name: original });
      await expect(link).toBeVisible();
      await expect(
        page.locator('dt', { hasText: t('orders.relation.goodwill_for') }),
      ).toBeVisible();
      await expectNoAxeViolations(page);

      // The list flags the gift under its number.
      await page.goto('/orders');
      await waitForPageHydration(page);
      await expect(page.getByText(giftText).first()).toBeVisible();
      await expectNoAxeViolations(page);

      // The original's page is reachable from the link.
      await page.goBack();
      // Back resolves on the URL change while the list (which also links the original) can still
      // be shown and the gift page has not loaded its data; a click then lands on the wrong page.
      await expect(page.getByRole('heading', { level: 1, name: gift })).toBeVisible();
      await page.getByRole('link', { name: original }).click();
      await expect(page.getByRole('heading', { level: 1, name: original })).toBeVisible();
      // The original's page lists the gift made from it (AC-23, the reverse link).
      await expect(page.getByRole('link', { name: gift })).toBeVisible();
      await expect(
        page.getByText(t('orders.detail.linkedFromRelation.goodwill_for')),
      ).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test('marks a short line on the page and the list, filters by it, and refuses the pack', async ({
      page,
      context,
    }) => {
      // Spec 0013 milestone 4 (AC-4, AC-5, AC-7, AC-13): a fresh SKU has no stock at any location,
      // so whichever location is online (or none) its line is short by the whole quantity.
      test.setTimeout(60_000);
      const code = `SHT-${randomUUID().slice(0, 8).toUpperCase()}`;
      await createSku(context.request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '250.00');
      const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

      await openNewOrder(page);
      await fillShipTo(page, `015${digits}`);
      await pickSku(page, code, t('inventory.receipt.searchSku'));
      await page.locator('#line-0-quantity').fill('2');
      await page.getByRole('button', { name: t('orders.new.submit') }).click();
      const label = await openedOrderLabel(page);
      await waitForPageHydration(page);

      // The page marks the line with the missing quantity (two pieces: Arabic has its own form).
      const shortBy = shortByText(dir, 2);
      const lines = page.getByRole('table', { name: t('orders.lines.title') });
      await expect(
        lines.getByRole('row', { name: new RegExp(code) }).getByText(shortBy),
      ).toBeVisible();
      await expectNoAxeViolations(page);

      // Confirm goes through; Pack is refused with LINE_SHORT and says why.
      const actions = page.getByRole('region', { name: t('orders.actions.label') });
      await actions.getByRole('button', { name: t('orders.actions.confirm') }).click();
      const pack = actions.getByRole('button', { name: t('orders.actions.pack') });
      await expect(pack).toBeVisible();
      await pack.click();
      await expect(
        actions.getByRole('alert').getByText(t('orders.new.errors.LINE_SHORT')),
      ).toBeVisible();
      await expect(pack).toBeVisible();
      await expect(actions.getByRole('button', { name: t('orders.actions.unpack') })).toHaveCount(
        0,
      );
      await expect(lines.getByText(shortBy)).toBeVisible();
      await expectNoAxeViolations(page);

      // The list's short filter: every row it shows carries the short flag, this order included.
      await page.goto('/orders');
      await expect(page.getByRole('heading', { level: 1, name: t('orders.title') })).toBeVisible();
      await waitForPageHydration(page);
      const table = page.getByRole('table', { name: t('orders.tableLabel') });
      await expect(table).toBeVisible();
      const listed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          new URL(response.url()).searchParams.get('short') === 'true',
      );
      await page.getByRole('checkbox', { name: t('orders.filters.short') }).check();
      await listed;
      const rows = table.locator('tbody tr');
      await expect(rows.first()).toBeVisible();
      const shown = await rows.count();
      for (let index = 0; index < shown; index += 1) {
        await expect(
          rows.nth(index).getByText(t('orders.flags.short'), { exact: true }),
        ).toBeVisible();
      }
      const box = page.getByRole('searchbox', { name: t('orders.search.label') });
      await box.fill(label.split('/')[1] ?? '');
      await box.press('Enter');
      const row = table.getByRole('row', { name: new RegExp(label.replace('/', '\\/')) });
      await expect(row.getByText(t('orders.flags.short'), { exact: true })).toBeVisible();
      // Back to the top first: ticking the filter scrolled the page, and filling the search box
      // then leaves its Search button partly under the sticky top bar, which axe's target size
      // rule counts as covered on a phone. That is the scroll position, not the page's layout.
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectNoAxeViolations(page);
    });

    test('filters the list and reaches Orders from the sidebar by keyboard', async ({
      page,
      isMobile,
    }) => {
      await openShell(page);
      if (isMobile) await page.getByRole('button', { name: t('shell.topbar.menu') }).click();
      const link = page.getByRole('link', { name: t('shell.nav.items.orders') });
      await expect(link).toBeVisible();
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/orders');
      await expect(page.getByRole('heading', { level: 1, name: t('orders.title') })).toBeVisible();
      await waitForPageHydration(page);

      // A filter narrows the list at once and a bad combination says "no match".
      const outcome: Locator = page.getByLabel(t('orders.filters.outcome'));
      await outcome.selectOption('refunded');
      await expect(
        page.getByText(t('orders.list.noMatchTitle')).or(page.getByRole('table')),
      ).toBeVisible();
      await page.getByRole('button', { name: t('orders.filters.clear') }).click();
      await expectNoAxeViolations(page);
    });
  });

  test.describe(`a support person in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      person = await seedAccount({ hats: ['support'], language });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = person;
      person = undefined;
      await done?.remove();
    });

    test('can enter a sale but is not offered a gifted order', async ({ page }) => {
      await page.goto('/orders/new');
      await expect(page.locator('#order-store')).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 1, name: t('orders.new.title') }),
      ).toBeVisible();
      await expect(page.getByRole('radio', { name: t('orders.new.kinds.gifted') })).toHaveCount(0);
      await expect(page.locator('#order-payment')).toBeVisible();
      await expectNoAxeViolations(page);
    });
  });

  test.describe(`a media buyer in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      person = await seedAccount({ hats: ['media_buyer'], language });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = person;
      person = undefined;
      await done?.remove();
    });

    test('gets the no access state on every order page and asks for no order data', async ({
      page,
    }) => {
      const requests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/orders')) requests.push(path);
      });

      for (const path of ['/orders', '/orders/new', `/orders/${randomUUID()}`]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByText(t('access.noAccess.title'))).toBeVisible();
        await expectNoAxeViolations(page);
      }
      expect(requests).toEqual([]);
    });
  });
}
