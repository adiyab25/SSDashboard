import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { ownerDatabaseUrl } from './auth';
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
// other tasks the shared database holds, and it is removed with her.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** The order the failed write back is about; it need not exist, the row only links to it. */
const ORDER_ID = randomUUID();

/** Inserts one overdue `sync.write_back_failed` task held by this person; returns its id. */
async function seedFailedWriteBack(agent: SeededAccount): Promise<string> {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (type, linked_type, linked_id, owner_user_id, owner_hat, due_at,
                          created_by_type, subject_key)
       VALUES ('sync.write_back_failed', 'order', $1::uuid, $2::uuid, 'operations',
               now() - interval '2 hours', 'system_job', 'shopify.order_edit:e2e')
       RETURNING id`,
      [ORDER_ID, agent.id],
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

    test.beforeEach(async ({ page, context, baseURL }) => {
      agent = await seedAccount({ hats: ['operations'], language });
      taskId = await seedFailedWriteBack(agent);
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
      // The seeded order does not exist, so the api gives no path: the kind shows as plain text.
      await expect(main.getByText(t('tasks.linkKinds.order'), { exact: true })).toBeVisible();

      // The navigation counts it: My work with the overdue count, and the unsynced edits badge.
      const nav = page.getByRole('navigation', { name: t('shell.nav.label') });
      await expect(nav.getByRole('link', { name: t('shell.nav.items.myWork') })).toBeVisible();
      await expect(nav.getByRole('link', { name: t('tasks.nav.unsyncedLabel') })).toBeVisible();
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

    test.beforeEach(async ({ page, context, baseURL }) => {
      agent = await seedAccount({ hats: ['operations'], language: 'ar' });
      taskId = await seedFailedWriteBack(agent);
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
