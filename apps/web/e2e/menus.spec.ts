import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ownAddress, seedAccount, type SeededAccount } from './accounts';
import { waitForPageHydration } from './support';

// The dropdown menu is not modal (packages/ui), so these touch tests pin how it behaves with real
// taps: it opens, it closes three ways, one tap away from it still reaches the other control, and
// its own trigger reopens it straight after it closed. They run on the mobile project only.
test.beforeEach(async ({ context }, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch taps: the mobile project only.');
  await context.setExtraHTTPHeaders(ownAddress());
});

let people: SeededAccount[] = [];
test.afterEach(async () => {
  const seeded = people;
  people = [];
  for (const person of seeded) await person.remove();
});

interface Rows {
  first: Locator;
  second: Locator;
  menus: Locator;
}

/** Seeds two people, lists only them, and returns each one's actions button. */
async function openTwoRows(page: Page): Promise<Rows> {
  const tag = randomUUID().slice(0, 8);
  const first = await seedAccount({ role: 'staff', name: `Menu Test A ${tag}` });
  people.push(first);
  const second = await seedAccount({ role: 'staff', name: `Menu Test B ${tag}` });
  people.push(second);

  await page.goto('/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  await waitForPageHydration(page);
  await page.getByRole('searchbox', { name: /Search staff/ }).fill(tag);
  // Header row plus the two seeded people.
  await expect(page.getByRole('row')).toHaveCount(3);
  return {
    first: page.getByRole('button', { name: `Actions for ${first.name}` }),
    second: page.getByRole('button', { name: `Actions for ${second.name}` }),
    menus: page.getByRole('menu'),
  };
}

test('a row menu opens on tap and closes on Escape, on an outside tap, and on choosing an item', async ({
  page,
}) => {
  const { first, menus } = await openTwoRows(page);
  const heading = page.getByRole('heading', { level: 1, name: 'Staff' });

  await first.tap();
  await expect(menus).toHaveCount(1);
  await expect(first).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Escape');
  await expect(menus).toHaveCount(0);
  await expect(first).toBeFocused();

  await first.tap();
  await expect(menus).toHaveCount(1);
  await heading.tap();
  await expect(menus).toHaveCount(0);

  await first.tap();
  await page.getByRole('menuitem', { name: 'Disable' }).tap();
  await expect(menus).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /^Disable / })).toBeVisible();
});

test('opening menu B while menu A is open leaves exactly one menu open', async ({ page }) => {
  const { first, second, menus } = await openTwoRows(page);

  // A menu opens below its row only when there is room below it; otherwise Radix flips it above
  // the row, where it covers the row over it. The row heights and type size set how much room a
  // 740px screen leaves, so give this test a tall screen (same 375px width, still touch) and
  // check that the lower row's menu really opened downward. Then the upper trigger stays free.
  await page.setViewportSize({ width: 375, height: 1200 });
  await second.tap();
  await expect(second).toHaveAttribute('aria-expanded', 'true');
  await expect(menus).toHaveAttribute('data-side', 'bottom');
  await first.tap();

  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(second).toHaveAttribute('aria-expanded', 'false');
  await expect(menus).toHaveCount(1);
});

test('one outside tap on another control closes the menu and activates that control once', async ({
  page,
}) => {
  const { first, menus } = await openTwoRows(page);

  await first.tap();
  await expect(menus).toHaveCount(1);
  await page.getByRole('button', { name: 'Add staff' }).tap();

  await expect(menus).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Add staff' })).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Add staff' })).toBeVisible();
});

test('a menu that just closed reopens on its own trigger tap', async ({ page }) => {
  const { first, menus } = await openTwoRows(page);

  await first.tap();
  await expect(menus).toHaveCount(1);
  await page.keyboard.press('Escape');
  // No wait for the close animation to end: the next tap lands while the menu is leaving.
  await first.tap();

  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(menus).toHaveCount(1);
  await expect(menus).toBeVisible();
});
