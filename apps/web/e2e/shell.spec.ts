/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test, type Page } from '@playwright/test';
import {
  expectNoAxeViolations,
  openShell,
  seedLocations,
  stubLicensedInstall,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type SeededLocations,
  type TextDirection,
  type Theme,
} from './support';

// Spec 0003: the app shell and /design in the browser.
const desktopOnly = (name: string) => test.skip(name !== 'desktop', 'desktop project only');
const mobileOnly = (name: string) => test.skip(name !== 'mobile', 'mobile project only');

const focusedName = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return '';
    return (
      element.getAttribute('aria-label') ??
      element.innerText.replace(/\s+/g, ' ').trim() ??
      element.tagName
    );
  });

test.describe('accessibility matrix (AC-2, AC-5, AC-11)', () => {
  for (const theme of ['light', 'dark'] satisfies Theme[]) {
    for (const dir of ['ltr', 'rtl'] satisfies TextDirection[]) {
      for (const path of ['/', '/design']) {
        test(`${path} has no axe violations in ${theme}, ${dir}`, async ({ page }, info) => {
          desktopOnly(info.project.name);
          await useBrowserState(page, { theme, dir });

          await openShell(page, path);
          if (path === '/') {
            // The status panel disables its button while it loads; axe runs once it has settled.
            await expect(
              page.getByRole('button', { name: textFor(dir, 'home.status.checkAgain') }),
            ).toBeEnabled();
          }
          await expect(page.locator('html')).toHaveAttribute('dir', dir);
          await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
          if (path === '/design') {
            await expect(page.getByTestId('contrast-foreground-on-background')).toHaveText(
              /:1 meets$/,
            );
          }

          await expectNoAxeViolations(page);
        });
      }
    }
  }
});

test.describe('keyboard (AC-4, AC-7, AC-8)', () => {
  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  test('the page h1 is the first heading, with no hidden overlay headings in the shell', async ({
    page,
  }) => {
    await openShell(page);

    const headings = await page
      .locator('h1, h2, h3, h4, h5, h6')
      .evaluateAll((list) => list.map((heading) => `${heading.tagName} ${heading.textContent}`));

    expect(headings[0]).toBe('H1 Overview');
    expect(await page.getByRole('banner').getByText('Go to a page').count()).toBe(0);
  });

  test('the skip link comes first and moves focus to the main content', async ({ page }) => {
    await openShell(page);

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('main')).toBeFocused();
  });

  test('Tab visits every shell control in visual order, and Shift+Tab reverses it', async ({
    page,
  }) => {
    // One location, so the switcher is enabled and in the tab order.
    await page.route('**/api/locations*', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              code: 'WH-1',
              name: { en: 'Main' },
              type: 'warehouse',
            },
          ],
          nextCursor: null,
        },
      }),
    );
    // The license banner and the module notices add links to the tab order, and the real answers
    // follow whatever license state earlier specs left in the database.
    await stubLicensedInstall(page);
    await openShell(page);
    // The Staff entry joins the sidebar once /api/me has told the shell the role.
    await expect(page.getByRole('button', { name: /User menu: E2E Admin/ })).toBeVisible();
    await waitForPageHydration(page);
    // The button is disabled (so out of the tab order) while the api check runs; read the tab
    // order only once the check has settled and the button is enabled.
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
    const expected = [
      'Skip to main content',
      'Home',
      'Design system',
      // The suite signs in as an administrator, who also has the Staff page (spec 0005, AC-25).
      'Staff',
      // Audit trail is admin only too (spec 0010, AC-18).
      'Audit trail',
      // Settings needs settings.manage, which the administrator holds (spec 0009, AC-25).
      'Settings',
      // Cost rules follows Settings in the general group: cost.view, which the suite's
      // administrator holds as a grant (spec 0009, AC-25, D15).
      'Cost rules',
      // The orders group (spec 0013); the administrator's manager hat holds orders.view.
      'Orders',
      // The inventory group (spec 0006).
      'Stock on hand',
      'Stock receipts',
      'SKUs',
      // Locations is admin only (spec 0006, AC-15); the suite signs in as an administrator.
      'Locations',
      // The customers group (spec 0014); the administrator's manager hat holds customers.view.
      'Customers',
      'Toggle sidebar',
      /^Location:/,
      /Search pages/,
      /User menu/,
      'Check again',
    ];

    const forward: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await page.keyboard.press('Tab');
      forward.push(await focusedName(page));
    }
    const backward: string[] = [];
    for (let i = 0; i < expected.length - 1; i++) {
      await page.keyboard.press('Shift+Tab');
      backward.push(await focusedName(page));
    }

    expected.forEach((name, index) => expect(forward[index]).toMatch(name));
    expect(backward).toEqual(forward.slice(0, -1).reverse());
  });

  test('every focused shell control shows a visible focus ring', async ({ page }) => {
    await openShell(page);

    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      });
      expect(outline.style).not.toBe('none');
      expect(outline.width).toBeGreaterThanOrEqual(2);
    }
  });

  test('Ctrl+K opens the palette, filters, and Enter goes to the page', async ({ page }) => {
    await openShell(page);

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Go to a page' })).toBeVisible();
    await page.keyboard.type('des');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/design$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Esc closes the palette and returns focus to what opened it', async ({ page }) => {
    await openShell(page);
    const button = page.getByRole('button', { name: /Search pages/ });

    await button.click();
    await expect(page.getByRole('dialog', { name: 'Go to a page' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();

    const checkAgain = page.getByRole('button', { name: 'Check again' });
    await checkAgain.focus();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(checkAgain).toBeFocused();
  });

  test('Esc closes the user menu and returns focus to its trigger', async ({ page }) => {
    await openShell(page);
    const trigger = page.getByRole('button', { name: /User menu/ });

    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('Ctrl+B collapses the sidebar to an icon rail, and it stays collapsed after reload', async ({
    page,
  }) => {
    await openShell(page);
    const sidebar = page.locator('[data-slot="sidebar"][data-state]');

    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    await openShell(page);
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();

    await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  });
});

// Arabic is the right to left language: the cookie `ss_lang=ar` gives the mirrored page.
test.describe('right to left (AC-5)', () => {
  test('the sidebar sits on the right and directional icons are mirrored', async ({
    page,
  }, info) => {
    desktopOnly(info.project.name);
    await useBrowserState(page, { dir: 'rtl' });
    await openShell(page);

    const box = await page.locator('[data-slot="sidebar-container"]').boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(width);

    await page.getByRole('button', { name: /قائمة المستخدم/ }).click();
    const chevron = page.getByRole('menuitem', { name: 'المظهر' }).locator('svg').last();
    // Tailwind v4 mirrors with the CSS `scale` property.
    const scale = await chevron.evaluate((element) => getComputedStyle(element).scale);
    expect(scale).toBe('-1 1');
  });
});

test.describe('phones (AC-5, AC-7, AC-14)', () => {
  test.beforeEach(({}, info) => mobileOnly(info.project.name));

  test('the menu button opens the sidebar as a sheet that closes when you pick a page', async ({
    page,
  }) => {
    await openShell(page);
    await expect(page.locator('[data-slot="sidebar-container"]')).toBeHidden();

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const sheet = page.getByRole('dialog', { name: 'Navigation' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name: 'Design system' }).click();

    await expect(page).toHaveURL(/\/design$/);
    await expect(sheet).toBeHidden();
  });

  for (const dir of ['ltr', 'rtl'] satisfies TextDirection[]) {
    test(`the sheet enters from the start edge in ${dir}`, async ({ page }) => {
      await useBrowserState(page, { dir });
      await openShell(page);

      const names = dir === 'ltr' ? ['Open navigation', 'Navigation'] : ['فتح التنقل', 'التنقل'];
      await page.getByRole('button', { name: names[0] }).click();
      const sheet = page.getByRole('dialog', { name: names[1] });
      await expect(sheet).toHaveAttribute('data-side', 'start');
      await page.waitForTimeout(400); // let the slide in animation finish
      const box = await sheet.boundingBox();
      const width = page.viewportSize()?.width ?? 0;

      if (dir === 'ltr') expect(Math.round(box?.x ?? -1)).toBe(0);
      else expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(width);
    });
  }

  test('shell controls are at least 44 by 44 on a touch screen', async ({ page }) => {
    await openShell(page);
    const controls = [
      page.getByRole('button', { name: 'Open navigation' }),
      page.getByRole('button', { name: /^Location:/ }),
      page.getByRole('button', { name: /Search pages/ }),
      page.getByRole('button', { name: /User menu/ }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    await page.getByRole('button', { name: 'Open navigation' }).click();
    for (const link of await page.getByRole('dialog').getByRole('link').all()) {
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('theme (AC-6)', () => {
  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  test('a first visit follows the operating system setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });

    await openShell(page);

    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });

  test('the chosen theme survives a reload and is applied before first paint', async ({ page }) => {
    await openShell(page);
    await page.getByRole('button', { name: /User menu/ }).click();
    await page.getByRole('menuitem', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    // Record the theme class at the first point scripts can see the document.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { firstPaintDark: boolean }).firstPaintDark =
          document.documentElement.classList.contains('dark');
      });
    });
    await page.reload();

    expect(
      await page.evaluate(() => (window as unknown as { firstPaintDark: boolean }).firstPaintDark),
    ).toBe(true);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });
});

test.describe('location switcher (AC-10)', () => {
  let seeded: SeededLocations;

  test.beforeAll(async () => {
    seeded = await seedLocations();
  });

  test.afterAll(async () => {
    await seeded?.remove();
  });

  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  const switcher = (page: Page) => page.getByRole('button', { name: /^Location:/ });

  test('lists warehouses and shops after All locations and remembers the choice', async ({
    page,
  }) => {
    await openShell(page);

    await switcher(page).click();
    const options = page.getByRole('option');
    await expect(options.first()).toHaveText('All locations');
    await page.getByRole('combobox').fill(seeded.shop.code);
    await page.getByRole('option', { name: new RegExp(seeded.shop.name) }).click();
    await expect(switcher(page)).toContainText(seeded.shop.name);
    await openShell(page);

    await expect(switcher(page)).toContainText(seeded.shop.name);
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === 'ss_location')?.value).toBe(seeded.shop.id);
  });

  test('falls back to All locations and rewrites a cookie for a location that is gone', async ({
    page,
    baseURL,
  }) => {
    await page
      .context()
      .addCookies([
        { name: 'ss_location', value: '00000000-0000-4000-8000-000000000000', url: baseURL ?? '' },
      ]);

    await openShell(page);

    await expect(switcher(page)).toContainText('All locations');
    await expect
      .poll(
        async () => (await page.context().cookies()).find((c) => c.name === 'ss_location')?.value,
      )
      .toBe('all');
  });

  test('is disabled and reads No locations yet on an empty install', async ({ page }) => {
    await page.route('**/api/locations*', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );

    await openShell(page);

    await expect(switcher(page)).toBeDisabled();
    await expect(switcher(page)).toContainText('No locations yet');
  });

  test('shows the error with a retry when the locations cannot load', async ({ page }) => {
    let fail = true;
    await page.route('**/api/locations*', (route) =>
      fail ? route.fulfill({ status: 500, body: '' }) : route.continue(),
    );
    await openShell(page);
    await expect(switcher(page)).toContainText('Locations unavailable');

    await switcher(page).click();
    await expect(page.getByRole('dialog', { name: 'Location' }).getByRole('alert')).toContainText(
      'The locations could not be loaded.',
    );
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(
      page.getByRole('option', { name: new RegExp(seeded.warehouse.name) }),
    ).toBeVisible();
  });
});

test.describe('/design in development (AC-11, AC-13)', () => {
  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  test('shows live contrast, every pinned state, and an Arabic specimen in Noto Sans Arabic', async ({
    page,
  }) => {
    await openShell(page, '/design');

    await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
    await expect(page.getByTestId('contrast-muted-foreground-on-muted')).toHaveText(
      /^\d+\.\d\d:1 meets$/,
    );
    for (const state of ['default', 'hover', 'focus', 'active', 'disabled', 'loading']) {
      await expect(page.getByRole('columnheader', { name: state })).toBeVisible();
    }
    const arabic = page.locator('[lang="ar"] p').first();
    expect(await arabic.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
      /Noto Sans Arabic/,
    );
    expect(
      await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily),
    ).toMatch(/Inter/);
  });
});
