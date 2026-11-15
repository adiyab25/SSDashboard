import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownAddress, seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { ownerDatabaseUrl } from './auth';
import { api, createSku } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForElementHydration,
  type TextDirection,
} from './support';

// Spec 0016 milestone 1 (AC-5, AC-7, AC-14): an `orders.confirm` agent finds a failed Shopify
// write back on My work, sees the overdue count and the unsynced edits badge in the navigation,
// the badge opens the order list on its hold filter, and the page reads and works by keyboard in
// Arabic at 360 CSS pixels wide, with no axe violation.
//
// There is no outbound publisher that fails a command yet (spec 0015 task 13), so the task is
// inserted into the database the way the other seeds are; the page and the summary read it through
// the real api. The seeded task is assigned to the seeded agent, so it is on her list whatever
// other tasks the shared database holds, and it is removed with her. It points at a real manual
// order created through the api by a manager, so the row shows the order number with its store
// and links to the order page. Orders are append only, so the seeded order stays.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** The order a task is about, as the api made it. */
interface SeededOrder {
  id: string;
}

/**
 * Creates one manual order through the real api as the signed in manager `request`. The api
 * answers the new order's id; the number and store are read back through the task row.
 */
async function seedOrder(request: APIRequestContext): Promise<SeededOrder> {
  const tag = randomUUID().slice(0, 8);
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const store = await pool.query<{ id: string }>(`SELECT id FROM stores WHERE code = 'MAIN'`);
    const channel = await pool.query<{ id: string }>(
      `SELECT id FROM channels WHERE code = 'manual'`,
    );
    const storeId = store.rows[0]?.id;
    const channelId = channel.rows[0]?.id;
    if (!storeId || !channelId) throw new Error('The MAIN store or the manual channel is missing');
    const code = `MYW-${tag.toUpperCase()}`;
    const sku = await createSku(request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '300.00');
    const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const made = await api(request, 'POST', '/orders', {
      clientRef: randomUUID(),
      storeId,
      channelId,
      shipTo: { name: `My work ${tag}`, phone: `010${digits}`, address: '1 Task Street, Cairo' },
      lines: [{ variantId: sku.id, quantity: 1, unitPrice: '300.00' }],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return { id: String(made.body['id']) };
  } finally {
    await pool.end();
  }
}

/** Inserts one overdue `sync.write_back_failed` task on this order held by this person; returns its id. */
async function seedFailedWriteBack(agent: SeededAccount, orderId: string): Promise<string> {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (type, linked_type, linked_id, owner_user_id, owner_hat, due_at,
                          created_by_type, subject_key)
       VALUES ('sync.write_back_failed', 'order', $1::uuid, $2::uuid, 'operations',
               now() - interval '2 hours', 'system_job', 'shopify.order_edit:e2e')
       RETURNING id`,
      [orderId, agent.id],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Could not seed the e2e task');
    return id;
  } finally {
    await pool.end();
  }
}

/** Removes seeded tasks (the owner role may delete; the app role may not). */
async function removeTasks(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [ids]);
  } finally {
    await pool.end();
  }
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const language = dir === 'rtl' ? 'ar' : 'en';

  test.describe(`My work in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let agent: SeededAccount | undefined;
    let taskId: string | undefined;
    let orderId = '';
    let manager: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL, playwright }) => {
      manager = await seedAccount({ hats: ['manager'] });
      const managerApi = await playwright.request.newContext({ baseURL });
      try {
        const signIn = await managerApi.post('/api/auth/sign-in/email', {
          headers: { origin: new URL(baseURL ?? '').origin, ...ownAddress() },
          data: { email: manager.email, password: manager.password },
        });
        expect(signIn.ok()).toBe(true);
        orderId = (await seedOrder(managerApi)).id;
      } finally {
        await managerApi.dispose();
      }
      agent = await seedAccount({ hats: ['operations'], language });
      taskId = await seedFailedWriteBack(agent, orderId);
      await signInThroughApi(context, agent, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = agent;
      const task = taskId;
      agent = undefined;
      taskId = undefined;
      if (task) await removeTasks([task]).catch(() => undefined);
      await done?.remove().catch(() => undefined);
      // The manager who created the order is named by append only audit entries, so it may stay.
      await manager?.remove().catch(() => undefined);
      manager = undefined;
    });

    async function openMyWork(page: Page) {
      await page.goto('/my-work');
      await expect(page.getByRole('heading', { level: 1, name: t('tasks.title') })).toBeVisible();
      await waitForElementHydration(page, 'main section');
    }

    test('the agent sees the failed write back, marked overdue, with no Close button', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'the navigation is a sheet on a phone; the 360 test covers the page');
      await openMyWork(page);

      const main = page.getByRole('main');
      await expect(main.getByText(t('tasks.types.sync.write_back_failed'))).toBeVisible();
      // Overdue is a word and an icon, never only a color.
      await expect(main.getByText(t('tasks.row.overdue'), { exact: true })).toBeVisible();
      await expect(main.getByText(t('tasks.row.closesByItself'))).toBeVisible();
      await expect(
        main.getByRole('button', { name: new RegExp(t('tasks.row.close')) }),
      ).toHaveCount(0);
      // The row names the real order by number and store, links to its page, and shows no phone,
      // name, or address.
      const orderLink = main.getByRole('link', { name: /MAIN\/SO-\d{4}-\d+$/ });
      await expect(orderLink).toBeVisible();
      await expect(orderLink).toHaveAttribute('href', `/orders/${orderId}`);
      await expect(main.getByText(/My work [0-9a-f]{8}|Task Street/)).toHaveCount(0);

      // The navigation counts it: My work with the overdue count, and the unsynced edits badge.
      const nav = page.getByRole('navigation', { name: t('shell.nav.label') });
      await expect(nav.getByRole('link', { name: t('shell.nav.items.myWork') })).toBeVisible();
      await expect(nav.getByRole('link', { name: t('tasks.nav.unsyncedLabel') })).toBeVisible();

      // Each badge shows a digit (aria-hidden) and a full sentence for screen readers. The counts
      // are global to the database, so assert presence and at least 1, never an exact value.
      for (const label of [t('shell.nav.items.myWork'), t('tasks.nav.unsyncedLabel')]) {
        const item = nav
          .getByRole('listitem')
          .filter({ has: page.getByRole('link', { name: label, exact: true }) });
        const digit = item.locator('span[aria-hidden="true"]', { hasText: /[0-9٠-٩]+/ });
        await expect(digit).toHaveCount(1);
        const shown = (await digit.innerText()).trim();
        const count = Number(shown.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
        expect(count).toBeGreaterThanOrEqual(1);
        // The sentence is the sr-only sibling; Arabic spells a count of one in words, so only presence is asserted.
        const sentence = item.locator('.sr-only');
        await expect(sentence).toHaveCount(1);
        await expect(sentence).toHaveText(/\S/);
      }
      await expectNoAxeViolations(page);
    });

    test('the unsynced edits badge opens the order list on its hold filter', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'the navigation is a sheet on a phone; the 360 test covers the page');
      await openMyWork(page);

      const badge = page
        .getByRole('navigation', { name: t('shell.nav.label') })
        .getByRole('link', { name: t('tasks.nav.unsyncedLabel') });
      await expect(badge).toHaveAttribute('href', '/orders?hold=1');
      await badge.click();

      await expect(page).toHaveURL(/\/orders\?hold=1$/);
      await expect(page.getByRole('checkbox', { name: t('orders.filters.hold') })).toBeChecked();
    });
  });
}

/** Presses Tab until the locator has focus (at most 40 presses), as a person without a mouse does. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

for (const { dir, name: languageName } of LANGUAGES.filter((entry) => entry.dir === 'rtl')) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`My work at 360 pixels in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 740 } });
    let agent: SeededAccount | undefined;
    let taskId: string | undefined;
    let orderId = '';
    let manager: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL, playwright }) => {
      manager = await seedAccount({ hats: ['manager'] });
      const managerApi = await playwright.request.newContext({ baseURL });
      try {
        const signIn = await managerApi.post('/api/auth/sign-in/email', {
          headers: { origin: new URL(baseURL ?? '').origin, ...ownAddress() },
          data: { email: manager.email, password: manager.password },
        });
        expect(signIn.ok()).toBe(true);
        orderId = (await seedOrder(managerApi)).id;
      } finally {
        await managerApi.dispose();
      }
      agent = await seedAccount({ hats: ['operations'], language: 'ar' });
      taskId = await seedFailedWriteBack(agent, orderId);
      await signInThroughApi(context, agent, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = agent;
      const task = taskId;
      agent = undefined;
      taskId = undefined;
      if (task) await removeTasks([task]).catch(() => undefined);
      await done?.remove().catch(() => undefined);
      // The manager who created the order is named by append only audit entries, so it may stay.
      await manager?.remove().catch(() => undefined);
      manager = undefined;
    });

    test('the card stacks, the unsynced link works by keyboard, and axe is clean', async ({
      page,
    }) => {
      await page.goto('/my-work');
      await expect(page.getByRole('heading', { level: 1, name: t('tasks.title') })).toBeVisible();
      await waitForElementHydration(page, 'main section');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const main = page.getByRole('main');
      await expect(main.getByText(t('tasks.types.sync.write_back_failed'))).toBeVisible();
      await expect(main.getByText(t('tasks.row.overdue'), { exact: true })).toBeVisible();
      await expect(main.getByText(t('tasks.row.closesByItself'))).toBeVisible();

      // The card stacks: nothing is wider than the 360 pixel screen.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // By keyboard alone: Tab to the menu button, open the navigation, Tab to the unsynced edits
      // link, press Enter, and land on the order list with its hold filter on.
      const menu = page.getByRole('button', { name: t('shell.topbar.menu') });
      await tabTo(page, menu);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('link', { name: t('shell.nav.items.myWork') })).toBeVisible();
      const unsynced = page.getByRole('link', { name: t('tasks.nav.unsyncedLabel') });
      await expect(unsynced).toBeVisible();
      const box = await unsynced.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
      await expectNoAxeViolations(page);
      await tabTo(page, unsynced);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/orders\?hold=1$/);
    });
  });
}
