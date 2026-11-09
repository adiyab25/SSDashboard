import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLocation, createSku, receive } from './master-data-api';
import { expectNoAxeViolations, textFor, useBrowserState, waitForPageHydration } from './support';

// Spec 0011, milestone 1, task 5 (AC-12, AC-16, AC-19, AC-20): the online gate and the Online
// stock badge on the Locations page, as an admin, in English and Arabic. The gate moves the one
// online flag of the install, so the two languages run one after the other, never in parallel.
test.describe.configure({ mode: 'serial' });

test.beforeEach(({ viewport }) => {
  test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the online gate flow');
});

const LANGUAGES = [
  { language: 'en', dir: 'ltr' },
  { language: 'ar', dir: 'rtl' },
] as const;

/** Opens the Locations page and waits until its list and controls are live. */
async function openLocations(page: Page) {
  const list = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/locations' && url.searchParams.get('status') === 'active';
  });
  await page.goto('/locations');
  await list;
  await waitForPageHydration(page);
}

for (const { language, dir } of LANGUAGES) {
  test.describe(`Online gate in ${language} (AC-16, AC-19)`, () => {
    test.beforeEach(async ({ page }) => {
      await useBrowserState(page, { language });
    });

    test('opens the gate from a warehouse, confirms the stock counted, moves online, and stops it', async ({
      page,
    }) => {
      const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
      // A code that sorts first, so the row is on the first page of a shared database.
      const code = `0G${randomUUID().slice(0, 6).toUpperCase()}`;
      const location = await createLocation(page.request, code);
      const sku = await createSku(page.request, `E2E-ON-${randomUUID().slice(0, 8)}`);
      await receive(page.request, location.id, sku.id, 4);

      await openLocations(page);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      // Open the gate by keyboard: focus the row's button and press Enter.
      const open = page.getByRole('button', {
        name: t('inventory.onlineGate.openLabel').replace('{{code}}', code),
      });
      await open.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // The built in check fails until the stock is confirmed counted; the move is blocked.
      await expect(dialog.getByText(t('inventory.onlineGate.failed'))).toBeVisible();
      const move = dialog.getByRole('button', { name: t('inventory.onlineGate.confirmMove') });
      await expect(move).toBeDisabled();
      await expectNoAxeViolations(page);

      await dialog.getByRole('button', { name: t('inventory.onlineGate.confirmStock') }).click();
      await expect(dialog.getByText(t('inventory.onlineGate.passed'))).toBeVisible();
      await expect(move).toBeEnabled();

      // A blank reason is refused before anything is sent, with the helper text beside it.
      await expect(dialog.getByText(t('inventory.onlineGate.reasonHint'))).toBeVisible();
      await move.click();
      await expect(dialog.getByText(t('inventory.onlineGate.reasonRequired'))).toBeVisible();
      await dialog.getByLabel(new RegExp(t('inventory.onlineGate.reason'))).fill('Counted by hand');
      await expectNoAxeViolations(page);
      await move.click();

      // The row now carries the Online stock badge and offers Stop online stock.
      await expect(dialog).toBeHidden();
      const row = page.getByRole('row', { name: new RegExp(code) });
      await expect(row.getByText(t('inventory.onlineGate.badge'), { exact: true })).toBeVisible();
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toHaveCount(0);

      await row
        .getByRole('button', {
          name: t('inventory.onlineGate.stopLabel').replace('{{code}}', code),
        })
        .click();
      const stop = page.getByRole('dialog');
      await stop.getByRole('button', { name: t('inventory.onlineGate.stopConfirm') }).click();
      await expect(stop.getByText(t('inventory.onlineGate.reasonRequired'))).toBeVisible();
      await stop.getByLabel(new RegExp(t('inventory.onlineGate.reason'))).fill('Recount');
      await stop.getByRole('button', { name: t('inventory.onlineGate.stopConfirm') }).click();

      // Nothing feeds online stock now: the Locations page and the Stock page say so.
      await expect(stop).toBeHidden();
      await expect(row.getByText(t('inventory.onlineGate.badge'), { exact: true })).toHaveCount(0);
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expectNoAxeViolations(page);

      await page.goto('/stock');
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expect(
        page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') }),
      ).toHaveAttribute('href', '/locations');
    });
  });
}
