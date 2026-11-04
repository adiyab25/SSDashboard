/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test, type Page } from '@playwright/test';
import {
  expectNoAxeViolations,
  languageCookie,
  openShell,
  setLanguageCookie,
  stubConfig,
} from './support';

// Spec 0004: English and Arabic, the language cookie, and client languages in the browser.
const desktopOnly = (name: string) => test.skip(name !== 'desktop', 'desktop project only');

const userMenu = (page: Page, name: RegExp) => page.getByRole('button', { name });

/** Opens the user menu's Language submenu in whichever language the page is in. */
async function openLanguageMenu(page: Page, menu: RegExp, language: string) {
  await userMenu(page, menu).click();
  await page.getByRole('menuitem', { name: language }).click();
}

const FRENCH = {
  _meta: { nativeName: 'Français', intl: 'fr-FR' },
  home: { title: 'Aperçu' },
};

test.describe('switching language (AC-1, AC-2, AC-3)', () => {
  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  test('a saved Arabic page opens right to left with no English flash and no hydration warning', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (/hydrat/i.test(message.text())) problems.push(message.text());
    });
    await setLanguageCookie(page, 'ar');

    // Before any script of the app runs, the head script has set the document up.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const root = document.documentElement;
        (window as unknown as { __early: string[] }).__early = [
          root.lang,
          root.dir,
          root.getAttribute('data-i18n') ?? '',
        ];
      });
    });
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('نظرة عامة');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).not.toHaveAttribute('data-i18n', /.*/);
    const early = await page.evaluate(() => (window as unknown as { __early: string[] }).__early);
    expect(early.slice(0, 2)).toEqual(['ar', 'rtl']);
    expect(problems).toEqual([]);
    // The sidebar is on the right.
    const box = await page.locator('[data-slot="sidebar-container"]').boundingBox();
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(page.viewportSize()?.width);
  });

  test('switching flips lang, dir, and portals without a reload, keeps typed text, and survives a reload', async ({
    page,
  }) => {
    await page.goto('/design');
    await openShell(page, '/design');
    const search = page.getByRole('textbox', { name: 'Search, right to left' });
    await search.fill('shelf 12');
    const navigation = page.evaluate(() => performance.getEntriesByType('navigation').length);

    await openLanguageMenu(page, /User menu/, 'Language');
    const arabic = page.getByRole('menuitemradio', { name: 'العربية' });
    await expect(arabic).toHaveAttribute('lang', 'ar');
    await expect(arabic).toHaveAttribute('dir', 'rtl');
    await arabic.click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('button', { name: /قائمة المستخدم/ })).toBeVisible();
    await expect(search).toHaveValue('shelf 12');
    expect(await navigation).toBe(1);
    expect(await languageCookie(page)).toBe('ar');

    // A portal (the menu) mirrors too: its submenu opens to the left of the trigger.
    await userMenu(page, /قائمة المستخدم/).click();
    await expect(page.getByRole('menu')).toHaveAttribute('dir', 'rtl');
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('button', { name: /قائمة المستخدم/ })).toBeVisible();

    await openLanguageMenu(page, /قائمة المستخدم/, 'اللغة');
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: /User menu/ })).toBeVisible();
    expect(await languageCookie(page)).toBe('en');
  });

  test('a first visit opens in the install default language and remembers it (AC-3, AC-4)', async ({
    page,
  }) => {
    await stubConfig(page, { defaultLanguage: 'ar' });

    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('نظرة عامة');
    await expect.poll(() => languageCookie(page)).toBe('ar');
  });

  test('a saved language the install no longer enables falls back to the default (AC-4)', async ({
    page,
  }) => {
    await stubConfig(page, { languages: ['en', 'ar'], defaultLanguage: 'en' });
    await setLanguageCookie(page, 'fr');

    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect.poll(() => languageCookie(page)).toBe('en');
  });

  test('keeps the saved language when the config call fails (AC-4)', async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ status: 500, body: '' }));
    await setLanguageCookie(page, 'ar');

    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('نظرة عامة');
    expect(await languageCookie(page)).toBe('ar');
  });
});

test.describe('when a language will not load (AC-13)', () => {
  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  test('a blocked Arabic chunk keeps English, leaves the cookie, and shows an inline error', async ({
    page,
  }) => {
    test.setTimeout(45_000); // a chunk that never answers is given up on after 6 seconds
    await stubConfig(page);
    await openShell(page);
    await expect.poll(() => languageCookie(page)).toBe('en');
    // Everything the page asks for from now on fails, as on a dropped connection.
    await page.route('**/_next/static/**', (route) => route.abort());

    await openLanguageMenu(page, /User menu/, 'Language');
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Could not load' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await languageCookie(page)).toBe('en');
  });

  test('the last of two overlapping choices wins', async ({ page }) => {
    await stubConfig(page);
    await openShell(page);
    await expect.poll(() => languageCookie(page)).toBe('en');
    // The Arabic chunk is slow, so English can be chosen while it is still loading.
    await page.route('**/_next/static/**', async (route) => {
      if (route.request().resourceType() === 'script') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    await openLanguageMenu(page, /User menu/, 'Language');
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click({ force: true });
    await page.waitForTimeout(2500);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await languageCookie(page)).toBe('en');
  });
});

test.describe('client languages (AC-11)', () => {
  test.beforeEach(({}, info) => desktopOnly(info.project.name));

  test('a language file appears in the menu, shows where translated and English elsewhere', async ({
    page,
  }) => {
    await stubConfig(page, { languages: ['en', 'ar', 'fr'] });
    await page.route('**/locales/fr.json', (route) => route.fulfill({ json: FRENCH }));

    await openShell(page);
    await openLanguageMenu(page, /User menu/, 'Language');
    await expect(page.getByRole('menuitemradio')).toHaveText(['English', 'العربية', 'Français']);
    await page.getByRole('menuitemradio', { name: 'Français' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Aperçu');
    // Keys the file lacks fall back to English.
    await expect(page.getByRole('button', { name: /User menu/ })).toBeVisible();
  });

  test('a malformed or missing file is hidden with a console warning, and the shell works', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await stubConfig(page, { languages: ['en', 'ar', 'fr', 'de'] });
    await page.route('**/locales/fr.json', (route) =>
      route.fulfill({ body: '{ not json', contentType: 'application/json' }),
    );
    await page.route('**/locales/de.json', (route) => route.fulfill({ json: { home: {} } }));

    await openShell(page);
    await openLanguageMenu(page, /User menu/, 'Language');

    await expect(page.getByRole('menuitemradio')).toHaveText(['English', 'العربية']);
    await expect.poll(() => warnings.filter((text) => /"(fr|de)"/.test(text)).length).toBe(2);
  });
});

test.describe('layout and accessibility (AC-10, AC-12)', () => {
  test('a code stays left to right inside right to left text (AC-10)', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await setLanguageCookie(page, 'ar');

    await page.goto('/');

    const version = page.locator('bdi[data-slot="ltr-text"]').first();
    await expect(version).toBeVisible();
    expect(await version.evaluate((element) => getComputedStyle(element).direction)).toBe('ltr');
  });

  test('Arabic text uses IBM Plex Sans Arabic (AC-12)', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await setLanguageCookie(page, 'ar');

    await page.goto('/');

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('نظرة عامة');
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.status === 'loaded').map((f) => f.family);
    });
    expect(loaded.some((family) => /Plex Sans Arabic/i.test(family))).toBe(true);
  });

  test('at 375px in Arabic nothing in the shell is clipped or overlapping (AC-12)', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'mobile', 'mobile project only');
    await setLanguageCookie(page, 'ar');
    await openShell(page);

    // No sideways scroll, and the four header controls sit side by side without overlap.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const controls = [
      page.getByRole('button', { name: 'فتح التنقل' }),
      page.getByRole('button', { name: /^الموقع:/ }),
      page.getByRole('button', { name: /البحث في الصفحات/ }),
      page.getByRole('button', { name: /قائمة المستخدم/ }),
    ];
    const boxes = [];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box!);
    }
    const width = page.viewportSize()?.width ?? 0;
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5;
        expect(apart).toBe(true);
      }
    }
    await expectNoAxeViolations(page);
  });
});
