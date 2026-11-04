import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownAddress, seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { ownerDatabaseUrl } from './auth';
import { expectNoAxeViolations, openShell, useBrowserState, waitForFormHydration } from './support';

// Spec 0006, AC-17 (Milestone 1 part): a staff member creates a SKU, an admin creates a
// warehouse, the staff member receives 10 at 5.0000, and on hand 10 shows on the Stock page in
// both languages, with cost for the admin only. Codes carry a per run tag: the dev database
// keeps rows between runs. The void half of AC-17 comes with Milestone 2.
test.describe('core stock loop', () => {
  test.describe.configure({ mode: 'serial' });
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const skuCode = `TEE-BLK-M-${tag}`;
  const locationCode = `WH-${tag}`;
  let staff: SeededAccount;

  test.beforeAll(async () => {
    staff = await seedAccount({ role: 'staff', name: `Stock clerk ${tag}` });
  });

  test.afterAll(async () => {
    // Receipts, movements, and the SKU stay: the ledger is append only and they reference it.
    await staff?.remove().catch(() => undefined);
  });

  test.beforeEach(({ viewport }) => {
    test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the thread');
  });

  test('runs the thread from a new SKU to stock on hand (AC-1, AC-4, AC-5, AC-9, AC-11, AC-16)', async ({
    page,
    browser,
    baseURL,
  }) => {
    // One long thread through four screens, two people, and two languages.
    test.setTimeout(150_000);
    // The admin (the saved session) creates the warehouse.
    await openShell(page, '/stock');
    await expect(page.getByRole('heading', { level: 1, name: 'Stock on hand' })).toBeVisible();
    await page.getByRole('button', { name: 'New location' }).click();
    const locationDialog = page.getByRole('dialog', { name: 'New location' });
    await locationDialog.getByLabel('Location code').fill(locationCode.toLowerCase());
    await locationDialog.getByLabel('Name in English').fill(`Cairo ${tag}`);
    await locationDialog.getByLabel('Name in Arabic').fill(`مخزن القاهرة ${tag}`);
    await locationDialog.getByRole('button', { name: 'Create location' }).click();
    await expect(page.getByText(`Location ${locationCode} created.`)).toBeVisible();

    // The staff member: no New location button, and no cost columns.
    const clerk = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
    await signInThroughApi(clerk, staff, baseURL ?? '');
    const clerkPage = await clerk.newPage();
    await openShell(clerkPage, '/stock');
    await expect(clerkPage.getByRole('button', { name: 'New location' })).toHaveCount(0);
    await expect(clerkPage.getByRole('columnheader', { name: 'Stock value' })).toHaveCount(0);

    await clerkPage.getByRole('button', { name: 'New SKU' }).click();
    const skuDialog = clerkPage.getByRole('dialog', { name: 'New SKU' });
    await skuDialog.getByLabel('SKU code').fill(skuCode.toLowerCase());
    await skuDialog.getByLabel('Name in English').fill('Black tee, medium');
    await skuDialog.getByLabel('Name in Arabic').fill('تيشيرت أسود مقاس وسط');
    await skuDialog.getByRole('button', { name: 'Create SKU' }).click();
    await expect(clerkPage.getByText(`SKU ${skuCode} created.`)).toBeVisible();

    // Receive 10 at 5.0000, choosing the SKU from the keyboard.
    await openShell(clerkPage, '/stock-receipts/new');
    await waitForFormHydration(clerkPage);
    await expect(clerkPage.getByRole('heading', { level: 1, name: 'Receive stock' })).toBeVisible();
    await clerkPage
      .getByLabel('Receive into')
      .selectOption({ label: `Cairo ${tag} · ${locationCode}` });
    await clerkPage.getByRole('combobox', { name: 'SKU' }).focus();
    await clerkPage.keyboard.press('Enter');
    await clerkPage.getByPlaceholder('Search by code or name…').fill(skuCode);
    const option = clerkPage.getByRole('option', { name: new RegExp(skuCode) });
    await expect(option).toBeVisible();
    await clerkPage.keyboard.press('Enter');
    await expect(clerkPage.getByRole('combobox', { name: 'SKU' })).toContainText(skuCode);
    await clerkPage.getByLabel('Quantity').fill('10');
    await clerkPage.getByLabel('Unit cost').fill('5.0000');
    // Staff enter cost but never see totals in money (AC-11).
    await expect(clerkPage.getByText('Reference value')).toHaveCount(0);
    await expectNoAxeViolations(clerkPage);
    await clerkPage.getByRole('button', { name: 'Post receipt' }).click();

    await expect(clerkPage).toHaveURL(/\/stock-receipts\/[0-9a-f-]{36}$/);
    const number = clerkPage.getByRole('heading', { level: 1 });
    await expect(number).toHaveText(/^SR-\d{4}-\d{6}$/);
    await expect(clerkPage.getByRole('columnheader', { name: 'Unit cost' })).toHaveCount(0);
    await expectNoAxeViolations(clerkPage);

    await openShell(clerkPage, '/stock');
    const clerkRow = clerkPage.getByRole('row', { name: new RegExp(skuCode) });
    await expect(clerkRow).toContainText('10');
    await expect(clerkRow).toContainText(`Cairo ${tag}`);
    await expectNoAxeViolations(clerkPage);
    await clerk.close();

    // The admin sees the value, in English and in Arabic.
    await openShell(page, '/stock');
    const adminRow = page.getByRole('row', { name: new RegExp(skuCode) });
    await expect(adminRow).toContainText('10');
    await expect(adminRow).toContainText('50.00');

    await useBrowserState(page, { language: 'ar' });
    await openShell(page, '/stock');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'المخزون المتاح' })).toBeVisible();
    const arabicRow = page.getByRole('row', { name: new RegExp(skuCode) });
    await expect(arabicRow).toContainText('تيشيرت أسود مقاس وسط');
    await expect(arabicRow).toContainText(`مخزن القاهرة ${tag}`);
    await expect(arabicRow).toContainText('50.00');
    await expectNoAxeViolations(page);
  });

  test('keeps the ledger balanced: the balance equals its movements (AC-17)', async () => {
    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    try {
      const { rows } = await pool.query<{ on_hand: number; total_value: string; moved: string }>(
        `SELECT sl.on_hand, sl.total_value::text,
                (SELECT coalesce(sum(m.quantity), 0)::text FROM stock_movements m
                  WHERE m.variant_id = sl.variant_id AND m.location_id = sl.location_id) AS moved
         FROM stock_levels sl
         JOIN product_variants v ON v.id = sl.variant_id
         WHERE v.sku = $1`,
        [skuCode],
      );
      expect(rows).toEqual([{ on_hand: 10, total_value: '50.00', moved: '10' }]);
    } finally {
      await pool.end();
    }
  });
});
