import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Hat } from '@ssdashboard/contracts';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { api, createLocation, createSku, receive } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0013 task 15, the web half (AC-5, AC-20, AC-27 e, f, g): an order whose Shopify fulfillment
// took two lines out of stock and expects them back shows its stock out block, appears in the
// "Awaiting restock" filter (found by order number), and lets a manager put one line back on the
// shelf with one tap and close part of the other with a reason. A warehouse hat sees the close as
// a request, and the line stays as it is. Both languages, axe clean. The order's shipment posting
// and awaiting columns are planted as the owner (no screen or route makes a Shopify fulfillment
// yet; spec 0015 task 9a does); the two actions then run through the real api and ledger.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

interface PlantedOrder {
  id: string;
  number: string;
  /** The two SKU codes, one per line. */
  codes: [string, string];
}

/**
 * Makes a manual order of two lines (2 pieces each) through the real api as the given manager
 * session, then plants what a Shopify fulfillment leaves: the order's stock out request, a
 * shipment posting that took both lines out of a stocked warehouse, and 2 pieces awaiting on each
 * line since yesterday.
 */
async function plantAwaitingOrder(request: APIRequestContext): Promise<PlantedOrder> {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const codes: [string, string] = [`AWT-${tag}-A`, `AWT-${tag}-B`];
  const first = await createSku(request, codes[0], { en: `Tee ${codes[0]}` }, '300.00');
  const second = await createSku(request, codes[1], { en: `Tee ${codes[1]}` }, '300.00');
  const location = await createLocation(request, `ZAW${tag}`);
  await receive(request, location.id, first.id, 5);
  await receive(request, location.id, second.id, 5);

  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const store = await pool.query<{ id: string }>(`SELECT id FROM stores WHERE code = 'MAIN'`);
    const channel = await pool.query<{ id: string }>(
      `SELECT id FROM channels WHERE code = 'manual'`,
    );
    const storeId = store.rows[0]?.id;
    const channelId = channel.rows[0]?.id;
    if (!storeId || !channelId) throw new Error('The MAIN store or the manual channel is missing');
    const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const made = await api(request, 'POST', '/orders', {
      clientRef: randomUUID(),
      storeId,
      channelId,
      shipTo: { name: `Awaiting ${tag}`, phone: `010${digits}`, address: '1 Shelf Street, Cairo' },
      lines: [
        { variantId: first.id, quantity: 2, unitPrice: '300.00' },
        { variantId: second.id, quantity: 2, unitPrice: '300.00' },
      ],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const orderId = String(made.body['id']);
    const number = String(made.body['orderNumber']);

    const lines = await pool.query<{ id: string; variant_id: string }>(
      `SELECT id, variant_id FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
      [orderId],
    );
    const group = await pool.query<{ id: string }>(
      `INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id, effective_at)
       VALUES ($1, 'e2e', 'order_shipment', $2::uuid, now()) RETURNING id`,
      [`order_shipment:${orderId}`, orderId],
    );
    for (const line of lines.rows) {
      await pool.query(
        `INSERT INTO stock_movements (group_id, variant_id, location_id, quantity, unit_cost, total_cost,
                                      source_line_id, effective_at, recorded_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, -2, 5, -10, $4::uuid, now(), now())`,
        [group.rows[0]?.id, line.variant_id, location.id, line.id],
      );
    }
    await pool.query(
      `UPDATE order_lines SET stock_out_quantity = 2, awaiting_restock_quantity = 2,
                              awaiting_restock_since = now() - interval '1 day'
       WHERE order_id = $1::uuid`,
      [orderId],
    );
    await pool.query(
      `UPDATE orders SET stock_out_source = 'shopify_fulfillment',
                         stock_out_requested_at = now() - interval '1 day'
       WHERE id = $1::uuid`,
      [orderId],
    );
    return { id: orderId, number, codes };
  } finally {
    await pool.end();
  }
}

/** Escapes text for a regular expression. */
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  /** The words of a catalog sentence before its `{{item}}` slot, to match an aria-label by prefix. */
  const labelPrefix = (key: Parameters<typeof textFor>[1]) =>
    new RegExp(`^${escaped(t(key).split('{{item}}')[0] ?? '')}`);
  const language = dir === 'rtl' ? 'ar' : 'en';

  test.describe(`awaiting restock in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    const accounts: SeededAccount[] = [];

    test.afterEach(async () => {
      for (const account of accounts.splice(0)) await account.remove().catch(() => undefined);
    });

    /** Signs a new person with these hats in, and a manager to plant the order with. */
    async function seedPeople(page: Page, hats: readonly Hat[]) {
      const person = await seedAccount({ hats, language });
      accounts.push(person);
      const manager = await seedAccount({ hats: ['manager'], language });
      accounts.push(manager);
      const context = page.context();
      const baseURL = String(test.info().project.use.baseURL);
      const seeder = await context.browser()?.newContext({ baseURL });
      if (!seeder) throw new Error('No browser to seed with');
      try {
        await signInThroughApi(seeder, manager, baseURL);
        const planted = await plantAwaitingOrder(seeder.request);
        await signInThroughApi(context, person, baseURL);
        return planted;
      } finally {
        await seeder.close();
      }
    }

    test('finds the order in the filter, puts one line back on the shelf, and closes part of the other', async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const order = await seedPeople(page, ['manager']);
      await useBrowserState(page, { dir });

      // The list: the filter narrows to orders awaiting restock, the search finds this one.
      await page.goto('/orders');
      await waitForPageHydration(page);
      await page.getByRole('checkbox', { name: t('orders.filters.awaitingRestock') }).check();
      await page.getByRole('searchbox', { name: t('orders.search.label') }).fill(order.number);
      await page.getByRole('button', { name: t('orders.search.submit'), exact: true }).click();
      const table = page.getByRole('table', { name: t('orders.tableLabel') });
      const row = table.getByRole('row').filter({ hasText: order.number });
      await expect(row).toBeVisible();
      await expect(row.getByText(t('orders.stockOut.sources.shopify_fulfillment'))).toBeVisible();
      await expect(row.getByText(/: 4/)).toBeVisible();
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: testInfo.outputPath(`awaiting-restock-list-${language}.png`),
        fullPage: true,
      });

      // The page: the block names the source, and both lines await 2 pieces.
      await row.getByRole('link').first().click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const block = page.getByRole('region', { name: t('orders.stockOut.title') });
      await expect(block).toBeVisible();
      await expect(block.getByText(t('orders.stockOut.sources.shopify_fulfillment'))).toBeVisible();
      const lineA = block.getByRole('listitem').filter({ hasText: order.codes[0] });
      const lineB = block.getByRole('listitem').filter({ hasText: order.codes[1] });
      await expect(lineA).toBeVisible();
      await expect(lineB).toBeVisible();
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: testInfo.outputPath(`awaiting-restock-order-${language}.png`),
        fullPage: true,
      });

      // One tap: line A is back on the shelf and leaves the awaiting list; focus stays on the page.
      await lineA
        .getByRole('button', { name: labelPrefix('orders.stockOut.restockLabel') })
        .click();
      await expect(lineA).toHaveCount(0);
      await expect(lineB).toBeVisible();
      await expect(block.getByRole('heading', { level: 2 })).toBeFocused();

      // Close one of line B's two pieces for a reason; the other still awaits.
      await lineB.getByRole('button', { name: labelPrefix('orders.stockOut.closeLabel') }).click();
      const dialog = page.getByRole('dialog', { name: t('orders.stockOut.closeTitle') });
      await expect(dialog).toBeVisible();
      await expectNoAxeViolations(page);
      await dialog.getByLabel(t('orders.stockOut.quantity')).fill('1');
      await dialog.getByLabel(t('orders.stockOut.reason')).selectOption('lost_by_carrier');
      await dialog.getByRole('button', { name: t('orders.stockOut.submitClose') }).click();
      await expect(dialog).toHaveCount(0);
      await expect(lineB).toBeVisible();
      await expect(lineB.getByText(/\b1\b|١/).first()).toBeVisible();
    });

    test('shows a warehouse hat the close as a request and leaves the line as it is', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const order = await seedPeople(page, ['warehouse']);
      await useBrowserState(page, { dir });

      await page.goto(`/orders/${order.id}`);
      await waitForPageHydration(page);
      const block = page.getByRole('region', { name: t('orders.stockOut.title') });
      const lineA = block.getByRole('listitem').filter({ hasText: order.codes[0] });
      await expect(lineA).toBeVisible();
      await expect(
        lineA.getByRole('button', { name: labelPrefix('orders.stockOut.closeLabel') }),
      ).toHaveCount(0);

      await lineA
        .getByRole('button', { name: labelPrefix('orders.stockOut.requestCloseLabel') })
        .click();
      const dialog = page.getByRole('dialog', { name: t('orders.stockOut.requestTitle') });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(t('orders.stockOut.reason')).selectOption('damaged_not_resold');
      await dialog.getByRole('button', { name: t('orders.stockOut.submitRequest') }).click();
      await expect(dialog).toHaveCount(0);
      // Nothing changed on the line: both pieces still await.
      await expect(lineA).toBeVisible();
      await expect(
        lineA.getByRole('button', { name: labelPrefix('orders.stockOut.restockLabel') }),
      ).toBeVisible();
    });

    test('offers no Pack on an order Shopify fulfilled, while Confirm still works', async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const order = await seedPeople(page, ['manager']);
      await useBrowserState(page, { dir });

      await page.goto(`/orders/${order.id}`);
      await waitForPageHydration(page);
      const actions = page.getByRole('region', { name: t('orders.actions.label') });
      const confirm = actions.getByRole('button', { name: t('orders.actions.confirm') });
      await expect(confirm).toBeVisible();
      await expect(actions.getByRole('button', { name: t('orders.actions.pack') })).toHaveCount(0);

      // Confirm still works; the order is then Confirmed, and Pack is still not offered.
      await confirm.click();
      await expect(confirm).toHaveCount(0);
      await expect(actions.getByRole('button', { name: t('orders.actions.pack') })).toHaveCount(0);
      await expect(actions.getByRole('button', { name: t('orders.actions.unpack') })).toHaveCount(
        0,
      );
      await page.screenshot({
        path: testInfo.outputPath(`awaiting-restock-no-pack-${language}.png`),
        fullPage: true,
      });
    });

    test('says a close request is already open on the second request, axe clean', async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const order = await seedPeople(page, ['warehouse']);
      await useBrowserState(page, { dir });

      await page.goto(`/orders/${order.id}`);
      await waitForPageHydration(page);
      const block = page.getByRole('region', { name: t('orders.stockOut.title') });
      const lineA = block.getByRole('listitem').filter({ hasText: order.codes[0] });
      await expect(lineA).toBeVisible();
      const requestButton = lineA.getByRole('button', {
        name: labelPrefix('orders.stockOut.requestCloseLabel'),
      });

      // The first request is accepted and the dialog closes.
      await requestButton.click();
      const dialog = page.getByRole('dialog', { name: t('orders.stockOut.requestTitle') });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(t('orders.stockOut.reason')).selectOption('damaged_not_resold');
      await dialog.getByRole('button', { name: t('orders.stockOut.submitRequest') }).click();
      await expect(dialog).toHaveCount(0);

      // The second one for the same line: the dialog stays open with the catalog sentence.
      await requestButton.click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(t('orders.stockOut.reason')).selectOption('damaged_not_resold');
      await dialog.getByRole('button', { name: t('orders.stockOut.submitRequest') }).click();
      const message = t('orders.stockOut.errors.CLOSE_ALREADY_REQUESTED');
      await expect(dialog.getByText(message)).toBeVisible();
      await expect(dialog.getByText(t('orders.actions.generic'))).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: testInfo.outputPath(`awaiting-restock-close-already-requested-${language}.png`),
        fullPage: true,
      });
    });
  });
}
