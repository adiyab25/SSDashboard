import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { expectNoAxeViolations, openShell, textFor, useBrowserState } from './support';

// Spec 0008, AC-11 (milestone 1, build plan item 7): the web hides what a person's hats do not
// allow. A warehouse person sees no Staff entry and no cost columns, and /staff by its address
// shows the no access state without asking the api for staff; a manager with the cost grant (the
// seeded admin) sees both. English and Arabic, desktop and mobile.

const LANGUAGES = [
  { language: 'en', dir: 'ltr' },
  { language: 'ar', dir: 'rtl' },
] as const;

/** Opens the command palette and returns its listbox of pages. */
async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+K');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  return list;
}

/** Waits until `/api/me` has answered on this page: the user menu then carries the name. */
async function waitForPerson(page: Page, name: string) {
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
}

for (const { language, dir } of LANGUAGES) {
  test.describe(`a warehouse person in ${language}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount;
    let toRemove: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      person = await seedAccount({ hats: ['warehouse'], language });
      toRemove = person;
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { language });
    });
    test.afterEach(async () => {
      const seeded = toRemove;
      toRemove = undefined;
      await seeded?.remove();
    });

    test('has no Staff entry, and the user menu names the warehouse hat', async ({
      page,
      isMobile,
    }) => {
      await openShell(page, '/');
      await waitForPerson(page, person.name);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);

      if (!isMobile) {
        const nav = page.getByRole('navigation', { name: textFor(dir, 'shell.nav.label') });
        await expect(
          nav.getByRole('link', { name: textFor(dir, 'shell.nav.items.stock') }),
        ).toBeVisible();
        await expect(
          nav.getByRole('link', { name: textFor(dir, 'shell.nav.items.staff') }),
        ).toHaveCount(0);
        await expect(
          nav.getByRole('link', { name: textFor(dir, 'shell.nav.items.locations') }),
        ).toHaveCount(0);
      }

      const palette = await openPalette(page);
      await expect(
        palette.getByRole('option', { name: textFor(dir, 'shell.nav.items.stock') }),
      ).toBeVisible();
      await expect(
        palette.getByRole('option', { name: textFor(dir, 'shell.nav.items.staff') }),
      ).toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: new RegExp(person.name) }).click();
      await expect(
        page.getByRole('menu').getByText(textFor(dir, 'access.hats.warehouse.name'), {
          exact: true,
        }),
      ).toBeVisible();
    });

    test('sees stock without the cost columns, and the answer carries no cost', async ({
      page,
    }) => {
      const answer = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/stock',
      );
      await openShell(page, '/stock');
      const body = await (await answer).text();
      expect(body).not.toMatch(/avgUnitCost|totalValue|unitCost/);
      await waitForPerson(page, person.name);

      const table = page.getByRole('table', { name: textFor(dir, 'inventory.stock.tableLabel') });
      await expect(
        table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.onHand') }),
      ).toBeVisible();
      await expect(
        table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.avgCost') }),
      ).toHaveCount(0);
      await expect(
        table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.value') }),
      ).toHaveCount(0);
    });

    test('opening /staff by its address shows the no access state and asks for no staff', async ({
      page,
    }) => {
      const staffCalls: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/staff' || path.startsWith('/api/staff/')) staffCalls.push(path);
      });

      await openShell(page, '/staff');
      await waitForPerson(page, person.name);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);

      const main = page.getByRole('main');
      await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(
        main.getByRole('heading', { level: 1, name: textFor(dir, 'staff.title') }),
      ).toBeVisible();
      await expect(main.getByText(textFor(dir, 'access.noAccess.title'))).toBeVisible();
      await expect(main.getByRole('table')).toHaveCount(0);
      await expect(main.getByRole('button', { name: textFor(dir, 'staff.add') })).toHaveCount(0);

      // The way out works from the keyboard.
      const home = main.getByRole('link', { name: textFor(dir, 'access.noAccess.home') });
      await home.focus();
      await expect(home).toBeFocused();

      await expectNoAxeViolations(page);
      expect(staffCalls).toEqual([]);

      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/$/);
    });
  });
}

test.describe('a manager with the cost grant (the seeded admin)', () => {
  for (const { language, dir } of LANGUAGES) {
    test(`in ${language}: sees the Staff entry and the cost columns`, async ({
      page,
      isMobile,
    }) => {
      await useBrowserState(page, { language });
      await openShell(page, '/stock');
      await waitForPerson(page, E2E_ADMIN.name);

      const table = page.getByRole('table', { name: textFor(dir, 'inventory.stock.tableLabel') });
      await expect(
        table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.avgCost') }),
      ).toBeVisible();
      await expect(
        table.getByRole('columnheader', { name: textFor(dir, 'inventory.stock.columns.value') }),
      ).toBeVisible();

      if (!isMobile) {
        const nav = page.getByRole('navigation', { name: textFor(dir, 'shell.nav.label') });
        await expect(
          nav.getByRole('link', { name: textFor(dir, 'shell.nav.items.staff') }),
        ).toBeVisible();
      }
      const palette = await openPalette(page);
      await expect(
        palette.getByRole('option', { name: textFor(dir, 'shell.nav.items.staff') }),
      ).toBeVisible();
    });
  }
});

test.describe('a manager without the cost grant', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('manages staff but sees no cost columns: cost is its own grant (AC-6)', async ({
    page,
    context,
    baseURL,
  }) => {
    const person = await seedAccount({ hats: ['manager'] });
    try {
      await signInThroughApi(context, person, baseURL ?? '');
      await openShell(page, '/stock');
      await waitForPerson(page, person.name);
      const table = page.getByRole('table', { name: textFor('ltr', 'inventory.stock.tableLabel') });
      await expect(
        table.getByRole('columnheader', { name: textFor('ltr', 'inventory.stock.columns.onHand') }),
      ).toBeVisible();
      await expect(
        table.getByRole('columnheader', {
          name: textFor('ltr', 'inventory.stock.columns.avgCost'),
        }),
      ).toHaveCount(0);

      await openShell(page, '/staff');
      await expect(page.getByRole('button', { name: textFor('ltr', 'staff.add') })).toBeVisible();
      await expect(page.getByText(textFor('ltr', 'access.noAccess.title'))).toHaveCount(0);
    } finally {
      await person.remove();
    }
  });
});
