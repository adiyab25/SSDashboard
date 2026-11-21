import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
import type { APIRequestContext } from '@playwright/test';

// QA gap (spec 0013 milestone 5 verify, 2026-11-21): the stock out block's two actions, "Received on
// the shelf" and the close form, reached with the keyboard only (Tab, Enter, Escape, arrow keys), in
// both languages. The order is planted the way `orders-awaiting-restock.spec.ts` plants it.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** Presses Tab until the locator holds focus (at most `limit` presses), failing when it never does. */
async function tabTo(page: Page, target: Locator, limit = 120) {
  for (let pressed = 0; pressed < limit; pressed += 1) {
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

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

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const labelPrefix = (key: Parameters<typeof textFor>[1]) =>
    new RegExp(`^${escaped(t(key).split('{{item}}')[0] ?? '')}`);
  const language = dir === 'rtl' ? 'ar' : 'en';

  test.describe(`awaiting restock, keyboard only, in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    const accounts: SeededAccount[] = [];

    test.afterEach(async () => {
      for (const account of accounts.splice(0)) await account.remove().catch(() => undefined);
    });

    test('puts a line back on the shelf and closes part of another without a mouse', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const person = await seedAccount({ hats: ['manager'], language });
      accounts.push(person);
      const context = page.context();
      const baseURL = String(test.info().project.use.baseURL);
      const seeder = await context.browser()?.newContext({ baseURL });
      if (!seeder) throw new Error('No browser to seed with');
      let order: PlantedOrder;
      try {
        await signInThroughApi(seeder, person, baseURL);
        order = await plantAwaitingOrder(seeder.request);
        await signInThroughApi(context, person, baseURL);
      } finally {
        await seeder.close();
      }
      await useBrowserState(page, { dir });

      await page.goto(`/orders/${order.id}`);
      await waitForPageHydration(page);
      const block = page.getByRole('region', { name: t('orders.stockOut.title') });
      const lineA = block.getByRole('listitem').filter({ hasText: order.codes[0] });
      const lineB = block.getByRole('listitem').filter({ hasText: order.codes[1] });
      await expect(lineA).toBeVisible();

      // Tab to "Received on the shelf" on line A and press Enter.
      const restockA = lineA.getByRole('button', {
        name: labelPrefix('orders.stockOut.restockLabel'),
      });
      await tabTo(page, restockA);
      await expect(restockA).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(lineA).toHaveCount(0);

      // Tab to the close button of line B, open the form, and leave it with Escape: focus returns.
      const closeB = lineB.getByRole('button', { name: labelPrefix('orders.stockOut.closeLabel') });
      await tabTo(page, closeB);
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: t('orders.stockOut.closeTitle') });
      await expect(dialog).toBeVisible();
      await expectNoAxeViolations(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(closeB).toBeFocused();

      // Open it again and fill it with the keyboard: quantity 1, the first reason, submit.
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      const quantity = dialog.getByLabel(t('orders.stockOut.quantity'));
      await tabTo(page, quantity);
      await page.keyboard.press('Control+A');
      await page.keyboard.type('1');
      const reason = dialog.getByLabel(t('orders.stockOut.reason'));
      await tabTo(page, reason);
      await page.keyboard.press('ArrowDown');
      await expect(reason).not.toHaveValue('');
      const submit = dialog.getByRole('button', { name: t('orders.stockOut.submitClose') });
      await tabTo(page, submit);
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(lineB).toBeVisible();
    });
  });
}
