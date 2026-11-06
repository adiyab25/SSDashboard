import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { createLocation, createSku } from './master-data-api';
import { openShell, waitForFormHydration } from './support';

// Spec 0004, AC-18: a quantity and a unit cost typed with Arabic digits and Arabic separators
// are accepted at the form edge and stored as Western numbers. The saved admin session posts the
// receipt through the real form; the codes carry a per run tag because the dev database keeps rows.
test.describe('receipt typed with Arabic digits', () => {
  test.beforeEach(({ viewport }) => {
    test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the thread');
  });

  test('saves quantity ٣ and unit cost ١٢٫٥٠ as 3 at 12.5000 (AC-18)', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const skuCode = `DIG-${tag}`;
    const locationCode = `WD-${tag}`;
    const location = await createLocation(request, locationCode, {
      en: `Digits ${tag}`,
      ar: `أرقام ${tag}`,
    });
    const sku = await createSku(request, skuCode, { en: `Digit tee ${tag}` });

    await openShell(page, '/stock-receipts/new');
    await waitForFormHydration(page);
    await page
      .getByLabel('Receive into')
      .selectOption({ label: `Digits ${tag} · ${locationCode}` });
    await page.getByRole('combobox', { name: 'SKU' }).click();
    await page.getByPlaceholder('Search by code or name…').fill(skuCode);
    await page.getByRole('option', { name: new RegExp(skuCode) }).click();
    await page.getByLabel('Quantity').fill('٣');
    await page.getByLabel('Unit cost').fill('١٢٫٥٠');

    const sent = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().endsWith('/api/stock-receipts'),
    );
    await page.getByRole('button', { name: 'Post receipt' }).click();

    // What left the browser is already Western.
    const line = (
      (await sent).postDataJSON() as { lines: { quantity: unknown; unitCost: unknown }[] }
    ).lines[0];
    expect(line?.quantity).toBe(3);
    expect(String(line?.unitCost)).toMatch(/^12\.50?(00)?$/);

    // Saved: the receipt page opens with its number, no field error was shown.
    await expect(page).toHaveURL(/\/stock-receipts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^SR-\d{4}-\d{6}$/);

    // And the ledger holds 3 on hand worth 37.50 at 12.5000 each.
    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    try {
      const { rows } = await pool.query<{ on_hand: number; total_value: string; avg: string }>(
        `SELECT on_hand, total_value::text, avg_unit_cost::text AS avg
         FROM stock_levels WHERE variant_id = $1::uuid AND location_id = $2::uuid`,
        [sku.id, location.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.on_hand).toBe(3);
      expect(Number(rows[0]?.total_value)).toBe(37.5);
      expect(Number(rows[0]?.avg)).toBe(12.5);
    } finally {
      await pool.end();
    }
  });
});
