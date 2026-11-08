import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { createSku } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0013 milestone 2 (AC-7 to AC-12, AC-20): a manager enters an order by hand, edits its
// address and replaces a line, confirms, packs, takes it back to confirmed, and cancels it with a
// reason; every step toasts the order number with its store, the edit history panel shows the
// edit, and the dialogs pass axe (WCAG 2.2 AA) in English and Arabic (right to left). Each test
// signs in as its own seeded person.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** Picks a SKU on the first line of the new order form: open the combobox, type the code, choose. */
async function pickSku(page: Page, trigger: string, code: string, searchPlaceholder: string) {
  await page.locator(trigger).click();
  await page.getByPlaceholder(searchPlaceholder).fill(code);
  await page.getByRole('option', { name: new RegExp(code) }).click();
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const language = dir === 'rtl' ? 'ar' : 'en';
  /** A catalog sentence with its `{{number}}` filled. */
  const numbered = (key: Parameters<typeof textFor>[1], number: number) =>
    t(key).replace('{{number}}', String(number));

  test.describe(`editing and moving an order in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let manager: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      // The manager hat reads the audit trail and edits orders; the warehouse hat packs.
      manager = await seedAccount({ hats: ['manager', 'warehouse'], language });
      await signInThroughApi(context, manager, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = manager;
      manager = undefined;
      // A person who changed an order is named by append only audit entries, so that account stays.
      await done?.remove().catch(() => undefined);
    });

    test('edits the address and replaces a line, confirms, packs, goes back, and cancels', async ({
      page,
      context,
    }) => {
      const first = `EDT-${randomUUID().slice(0, 8).toUpperCase()}`;
      const second = `EDT-${randomUUID().slice(0, 8).toUpperCase()}`;
      await createSku(
        context.request,
        first,
        { en: `Tee ${first}`, ar: `قميص ${first}` },
        '250.00',
      );
      await createSku(
        context.request,
        second,
        { en: `Tee ${second}`, ar: `قميص ${second}` },
        '270.00',
      );
      const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

      // Enter the order by hand.
      await page.goto('/orders/new');
      await expect(page.locator('#order-store')).toBeVisible();
      await waitForPageHydration(page);
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
      await page.locator('#order-phone').fill(`010${digits}`);
      await page.locator('#order-address').fill('12 Nile Street, Cairo');
      await pickSku(page, '#line-0-sku', first, t('inventory.receipt.searchSku'));
      await page.locator('#line-0-quantity').fill('1');
      await page.getByRole('button', { name: t('orders.new.submit') }).click();

      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
      const heading = page.getByRole('heading', { level: 1, name: /^MAIN\/SO-\d{4}-\d+$/ });
      await expect(heading).toBeVisible();
      const label = (await heading.innerText()).trim();
      await waitForPageHydration(page);
      const toast = page.locator('[data-sonner-toast]');

      // A new order offers Confirm, Edit, and Cancel (a manager also wears the warehouse hat,
      // but Pack waits for a confirmed order).
      const actions = page.getByRole('region', { name: t('orders.actions.label') });
      await expect(
        actions.getByRole('button', { name: t('orders.actions.confirm') }),
      ).toBeVisible();
      await expect(actions.getByRole('button', { name: t('orders.actions.pack') })).toHaveCount(0);

      // Edit: a new address and the line replaced by another SKU.
      await actions.getByRole('button', { name: t('orders.actions.edit') }).click();
      const edit = page.getByRole('dialog');
      await expect(edit).toBeVisible();
      await edit.getByLabel(t('orders.shipTo.address')).fill('14 Garden City, Cairo');
      await edit.getByLabel(numbered('orders.edit.lineAction', 1)).selectOption('replace');
      await pickSku(page, '#edit-line-0-sku', second, t('inventory.receipt.searchSku'));
      await edit.getByLabel(t('orders.edit.reason')).selectOption('size_change');
      await expectNoAxeViolations(page);
      await edit.getByRole('button', { name: t('orders.edit.save') }).click();

      await expect(edit).toHaveCount(0);
      // The newest toast is the first one in the list.
      await expect(toast.filter({ hasText: label }).first()).toBeVisible();
      await expect(page.getByText('14 Garden City, Cairo')).toBeVisible();
      const lines = page.getByRole('table', { name: t('orders.lines.title') });
      await expect(lines.getByText(second, { exact: true })).toBeVisible();
      await expect(lines.getByText(t('orders.lineState.cancelled'))).toBeVisible();
      // Focus came back to the button that opened the dialog.
      await expect(actions.getByRole('button', { name: t('orders.actions.edit') })).toBeFocused();

      // The manager reads the edit in the history panel (AC-11).
      const history = page.getByRole('heading', { level: 2, name: t('audit.history.title') });
      await expect(history).toBeVisible();
      await expect(
        page
          .getByRole('table', { name: t('audit.history.title') })
          .getByText(t('audit.actions.orderEdited')),
      ).toBeVisible();
      await expectNoAxeViolations(page);

      // Confirm, pack, back to confirmed.
      await actions.getByRole('button', { name: t('orders.actions.confirm') }).click();
      await expect(toast.filter({ hasText: label }).first()).toBeVisible();
      await expect(actions.getByRole('button', { name: t('orders.actions.pack') })).toBeVisible();
      await actions.getByRole('button', { name: t('orders.actions.pack') }).click();
      await expect(actions.getByRole('button', { name: t('orders.actions.unpack') })).toBeVisible();
      await expect(
        page.getByText(t('orders.fulfillment.packed'), { exact: true }).first(),
      ).toBeVisible();
      await actions.getByRole('button', { name: t('orders.actions.unpack') }).click();
      await expect(actions.getByRole('button', { name: t('orders.actions.pack') })).toBeVisible();

      // Cancel with a reason; the reason is required first.
      await actions.getByRole('button', { name: t('orders.actions.cancel') }).click();
      const cancel = page.getByRole('dialog');
      await cancel.getByRole('button', { name: t('orders.cancel.confirm') }).click();
      await expect(cancel.getByText(t('orders.cancel.reasonRequired'))).toBeVisible();
      await cancel.getByLabel(t('orders.cancel.reason')).selectOption('duplicate');
      await expect(
        cancel.getByRole('combobox', { name: t('orders.cancel.duplicateOf') }),
      ).toBeVisible();
      await expectNoAxeViolations(page);
      await cancel.getByLabel(t('orders.cancel.reason')).selectOption('customer_cancelled');
      await cancel.getByRole('button', { name: t('orders.cancel.confirm') }).click();

      await expect(cancel).toHaveCount(0);
      await expect(
        page.getByText(t('orders.fulfillment.cancelled'), { exact: true }).first(),
      ).toBeVisible();
      await expect(actions).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);
    });

    test('lets support fix a gifted order address but not its lines', async ({
      page,
      context,
      baseURL,
    }) => {
      const code = `GFT-${randomUUID().slice(0, 8).toUpperCase()}`;
      await createSku(context.request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '300.00');
      const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

      // A manager gives away one piece.
      await page.goto('/orders/new');
      await expect(page.locator('#order-store')).toBeVisible();
      await waitForPageHydration(page);
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
      await page.getByRole('radio', { name: t('orders.new.kinds.gifted') }).check();
      await page.locator('#order-gift-reason').selectOption('influencer');
      await page.locator('#order-name').fill('Influencer E2E');
      await page.locator('#order-phone').fill(`011${digits}`);
      await page.locator('#order-address').fill('1 Old Road, Cairo');
      await pickSku(page, '#line-0-sku', code, t('inventory.receipt.searchSku'));
      await page.locator('#line-0-quantity').fill('1');
      await page.getByRole('button', { name: t('orders.new.submit') }).click();
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
      const orderUrl = page.url();

      // Support signs in on the same browser and opens the order.
      const support = await seedAccount({ hats: ['support'], language });
      try {
        await signInThroughApi(context, support, baseURL ?? '');
        await page.goto(orderUrl);
        const actions = page.getByRole('region', { name: t('orders.actions.label') });
        await expect(actions).toBeVisible();
        await waitForPageHydration(page);
        await actions.getByRole('button', { name: t('orders.actions.edit') }).click();
        const edit = page.getByRole('dialog');
        await expect(edit.getByText(t('orders.edit.giftLinesNeedPermission'))).toBeVisible();
        await expect(edit.getByLabel(numbered('orders.edit.lineAction', 1))).toHaveCount(0);
        await edit.getByLabel(t('orders.shipTo.address')).fill('2 New Road, Giza');
        await expectNoAxeViolations(page);
        await edit.getByRole('button', { name: t('orders.edit.save') }).click();
        await expect(edit).toHaveCount(0);
        await expect(page.getByText('2 New Road, Giza')).toBeVisible();
      } finally {
        await support.remove().catch(() => undefined);
      }
    });
  });
}
