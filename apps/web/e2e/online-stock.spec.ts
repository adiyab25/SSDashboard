import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createLocation, createSku, receive } from './master-data-api';
import { firstSortingCode, pressEnterOn, typeInto, useOnlineFlag } from './online-flag';
import { holdOpenOrdersIfAsked, moveOnlineHoldingOrders } from './order-stock';
import { expectNoAxeViolations, textFor, useBrowserState, waitForPageHydration } from './support';

// Spec 0011, milestone 1, task 5 (AC-12, AC-16, AC-19, AC-20): the online gate and the Online
// stock badge on the Locations page, as an admin, in English and Arabic, with the keyboard only.
// The gate moves the one online flag of the install: the tests of a file run one after the other,
// and `useOnlineFlag` holds a lock across workers (this file and online-stock-states.spec.ts run
// in parallel workers) and stops online stock after each test, pass or fail.
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
    useOnlineFlag();

    test.beforeEach(async ({ page }) => {
      await useBrowserState(page, { language });
    });

    test('opens the gate from a warehouse, confirms the stock counted, moves online, and stops it, by keyboard', async ({
      page,
    }) => {
      const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
      // A code that sorts first, so the row is on the first page and a few Tab presses away.
      const code = firstSortingCode();
      const location = await createLocation(page.request, code);
      const sku = await createSku(page.request, `E2E-ON-${randomUUID().slice(0, 8)}`);
      await receive(page.request, location.id, sku.id, 4);

      await openLocations(page);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      // Open the gate: Tab to the row's button, Enter.
      await pressEnterOn(
        page,
        page.getByRole('button', {
          name: t('inventory.onlineGate.openLabel').replace('{{code}}', code),
        }),
      );
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // The built in check fails until the stock is confirmed counted; the move is blocked.
      // (Open orders other specs left in the shared database may fail the orders check too.)
      await expect(dialog.getByText(t('inventory.onlineGate.failed')).first()).toBeVisible();
      const move = dialog.getByRole('button', { name: t('inventory.onlineGate.confirmMove') });
      await expect(move).toBeDisabled();
      await expectNoAxeViolations(page);

      await pressEnterOn(
        page,
        dialog.getByRole('button', { name: t('inventory.onlineGate.confirmStock') }),
      );
      await expect(dialog.getByText(t('inventory.onlineGate.passed')).first()).toBeVisible();
      // The helper text shows beside the untouched reason; tabbing past the field to reach the
      // orders check's button below marks it touched, and the required message takes its place.
      await expect(dialog.getByText(t('inventory.onlineGate.reasonHint'))).toBeVisible();
      // Hold the open orders here when the orders check asks (spec 0013 AC-26), by keyboard.
      const holdWords = {
        hold: t('orders.onlineGate.holdOpenOrders'),
        heldTitle: t('orders.onlineGate.heldTitle'),
      };
      const byKeyboard = (button: Locator) => pressEnterOn(page, button);
      await holdOpenOrdersIfAsked(dialog, holdWords, byKeyboard);
      await expect(dialog.getByText(t('inventory.onlineGate.failed'))).toHaveCount(0);
      await expect(move).toBeEnabled();

      // A blank reason is refused before anything is sent.
      await pressEnterOn(page, move);
      await expect(dialog.getByText(t('inventory.onlineGate.reasonRequired'))).toBeVisible();
      await typeInto(
        page,
        dialog.getByLabel(new RegExp(t('inventory.onlineGate.reason'))),
        'Counted by hand',
      );
      await expectNoAxeViolations(page);
      // An order a parallel spec placed meanwhile fails the check again: hold, then move again.
      await moveOnlineHoldingOrders(dialog, move, holdWords, byKeyboard);

      // The row now carries the Online stock badge and offers Stop online stock.
      const row = page.getByRole('row', { name: new RegExp(code) });
      await expect(row.getByText(t('inventory.onlineGate.badge'), { exact: true })).toBeVisible();
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toHaveCount(0);

      await pressEnterOn(
        page,
        row.getByRole('button', {
          name: t('inventory.onlineGate.stopLabel').replace('{{code}}', code),
        }),
      );
      const stop = page.getByRole('dialog');
      const stopConfirm = stop.getByRole('button', { name: t('inventory.onlineGate.stopConfirm') });
      await pressEnterOn(page, stopConfirm);
      await expect(stop.getByText(t('inventory.onlineGate.reasonRequired'))).toBeVisible();
      await typeInto(
        page,
        stop.getByLabel(new RegExp(t('inventory.onlineGate.reason'))),
        'Recount',
      );
      await pressEnterOn(page, stopConfirm);

      // Nothing feeds online stock now: the Locations page and the Stock page say so.
      await expect(stop).toBeHidden();
      await expect(row.getByText(t('inventory.onlineGate.badge'), { exact: true })).toHaveCount(0);
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      // The dialog's overlay fades out after the content hides; until it is gone it covers the
      // row's buttons, which axe's target size rule counts as too small.
      await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
      await expectNoAxeViolations(page);

      await page.goto('/stock');
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expect(
        page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') }),
      ).toHaveAttribute('href', '/locations');
    });
  });
}
