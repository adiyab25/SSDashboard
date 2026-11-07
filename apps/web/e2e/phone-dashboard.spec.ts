import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, openShell, setLanguageCookie, type Language } from './support';

// Spec 0003 AC-20 and AC-21 (amendment): the sample phone dashboard and the in screen help on
// /design, on a 360 by 800 touch screen, in both languages. The dashboard is a development only
// page (/design/phone-dashboard) inside the real shell; the production project checks its 404.
test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first argument.
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'mobile', 'phone checks run in the mobile project');
});
test.setTimeout(90_000);

const LANGUAGES: Language[] = ['en', 'ar'];
const WIDTHS = [320, 360, 390, 430];
const PAGE = '/design/phone-dashboard';

/**
 * True when the page scrolls sideways. It compares with the width the test set, not with
 * `window.innerWidth`, which follows the overflow on an `isMobile` page (see frames.spec.ts).
 */
async function overflowsSideways(page: Page): Promise<boolean> {
  const width = page.viewportSize()?.width ?? 0;
  return page.evaluate((limit) => document.documentElement.scrollWidth > limit, width);
}

/** Opens a page in a language and waits for the sample to render in it. */
async function openIn(page: Page, language: Language, path: string) {
  await setLanguageCookie(page, language);
  await openShell(page, path);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
}

for (const language of LANGUAGES) {
  test.describe(`the phone dashboard in ${language}`, () => {
    test('has one h1 and no sideways scroll from 320 to 430px', async ({ page }) => {
      await openIn(page, language, PAGE);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('[data-slot="metric-card"]')).toHaveCount(4);

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        expect(await overflowsSideways(page), `${PAGE} (${language}) at ${width}px`).toBe(false);
      }
    });

    test('every tap target is at least 44 by 44px', async ({ page }) => {
      await openIn(page, language, PAGE);
      const targets = page.locator(
        '[data-slot="metric-card"], [data-slot="needs-you-list"] a, [data-slot="bottom-tabs"] a',
      );
      // 4 cards, 5 rows and the more link, 4 tabs.
      await expect(targets).toHaveCount(14);

      await expect(async () => {
        for (let index = 0; index < 14; index += 1) {
          const target = targets.nth(index);
          await target.scrollIntoViewIfNeeded({ timeout: 2_000 });
          const box = await target.boundingBox();
          expect(box?.width, `target ${index} width`).toBeGreaterThanOrEqual(44);
          expect(box?.height, `target ${index} height`).toBeGreaterThanOrEqual(44);
        }
      }).toPass({ timeout: 15_000 });
    });

    test('the bottom tabs are 56px tall, at most four, with the current one marked', async ({
      page,
    }) => {
      await openIn(page, language, PAGE);
      const tabs = page.locator('[data-slot="bottom-tabs"] a');

      expect(await tabs.count()).toBeLessThanOrEqual(4);
      await expect(page.locator('[data-slot="bottom-tabs"] a[aria-current="page"]')).toHaveCount(1);
      // Locators, not handles: the shell remounts the page once after it loads.
      await expect(async () => {
        for (let index = 0; index < 4; index += 1) {
          expect((await tabs.nth(index).boundingBox())?.height).toBe(56);
        }
      }).toPass({ timeout: 15_000 });
    });

    test('the collapsing table shows cards at 360px and a table at 1024px', async ({ page }) => {
      await openIn(page, language, PAGE);
      const root = page.locator('[data-slot="collapsing-table"]');

      await expect(root.locator('ul')).toBeVisible();
      await expect(root.locator('table')).toBeHidden();

      await page.setViewportSize({ width: 1024, height: 800 });
      await expect(root.locator('table')).toBeVisible();
      await expect(root.locator('ul')).toBeHidden();
    });

    test('has no axe violations at the top and at the bottom of the page', async ({ page }) => {
      await openIn(page, language, PAGE);
      await expect(page.locator('[data-slot="bottom-tabs"]')).toBeVisible();

      await expectNoAxeViolations(page);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expectNoAxeViolations(page);
    });

    test('scrolled to the bottom, the tab bar spans the page and covers no Needs you row', async ({
      page,
    }) => {
      await openIn(page, language, PAGE);
      await expect(page.locator('[data-slot="bottom-tabs"]')).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

      await expect(async () => {
        const bar = await page.locator('[data-slot="bottom-tabs"]').boundingBox();
        expect(bar?.x).toBe(0);
        expect(bar?.width).toBe(360);
        const rows = page.locator('[data-slot="needs-you-list"] a');
        const last = await rows.last().boundingBox();
        const barTop = bar?.y ?? 0;
        expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(barTop);
        // The last row is the "N more" link.
        await expect(rows.last()).toContainText(/\d/);
      }).toPass({ timeout: 10_000 });
    });
  });

  test.describe(`in screen help on /design in ${language}`, () => {
    test('? opens the panel from the page, and Esc closes it with focus on the opener', async ({
      page,
    }) => {
      await openIn(page, language, '/design');
      const opener = page.locator('button[aria-keyshortcuts="?"]');
      await expect(opener).toHaveCount(1);

      await page.locator('body').click({ position: { x: 2, y: 2 } });
      const panel = page.locator('[data-slot="help-panel"]');
      // The shortcut listener starts after hydration, so press until it answers.
      await expect(async () => {
        await page.keyboard.press('?');
        await expect(panel).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await expect(panel.locator('[data-slot="status-chip"]')).toHaveCount(4);

      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(opener).toBeFocused();
    });

    test('the Help button opens the panel, Esc closes it and focus returns to the button', async ({
      page,
    }) => {
      await openIn(page, language, '/design');
      const opener = page.locator('button[aria-keyshortcuts="?"]');
      // The gallery remounts once after the shell loads; retry the whole step if it lands here.
      await expect(async () => {
        await opener.scrollIntoViewIfNeeded({ timeout: 2_000 });
        await opener.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('[data-slot="help-panel"]')).toBeVisible({ timeout: 2_000 });
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-slot="help-panel"]')).toBeHidden();
        await expect(opener).toBeFocused();
      }).toPass({ timeout: 15_000 });
    });

    test('typing ? in an input does not open the panel', async ({ page }) => {
      await openIn(page, language, '/design');
      const input = page.getByRole('textbox').first();

      // The gallery remounts once after the shell loads; retry the whole step if it lands here.
      await expect(async () => {
        await input.scrollIntoViewIfNeeded({ timeout: 2_000 });
        await input.focus();
        await input.fill('');
        await page.keyboard.type('?');
        await expect(input).toHaveValue('?', { timeout: 2_000 });
        await expect(page.locator('[data-slot="help-panel"]')).toHaveCount(0);
      }).toPass({ timeout: 15_000 });
    });

    test('a help hint opens by Enter and by Space, and Esc brings focus back', async ({ page }) => {
      await openIn(page, language, '/design');
      const hint = page.getByTestId('confirmation-queue-card').locator('[data-slot="help-hint"]');
      await expect(hint).toHaveCount(2);

      for (const key of ['Enter', 'Space']) {
        // The gallery remounts once after the shell loads; retry the whole step if it lands here.
        await expect(async () => {
          const first = hint.first();
          await first.scrollIntoViewIfNeeded({ timeout: 2_000 });
          await first.focus();
          await page.keyboard.press(key);
          await expect(page.locator('[data-slot="popover-content"]')).toBeVisible({
            timeout: 2_000,
          });
          await page.keyboard.press('Escape');
          await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
          await expect(first).toBeFocused();
        }).toPass({ timeout: 15_000 });
      }
    });

    test('the first run checklist is dismissed and brought back from the panel', async ({
      page,
    }) => {
      await openIn(page, language, '/design');
      const checklist = page.locator('[data-slot="first-run-checklist"]');
      await expect(checklist).toBeVisible();

      await checklist.getByRole('button').click();
      await expect(checklist).toHaveCount(0);

      await page.locator('button[aria-keyshortcuts="?"]').click();
      await page
        .locator('[data-slot="help-panel"]')
        .getByRole('button', { name: /checklist|first steps|الخطوات الأولى/i })
        .click();
      await expect(checklist).toBeVisible();
    });

    test('/design has no axe violations with the help panel closed', async ({ page }) => {
      await openIn(page, language, '/design');

      await expectNoAxeViolations(page);
    });

    test('/design has no axe violations with the help panel open', async ({ page }) => {
      await openIn(page, language, '/design');
      await page.locator('button[aria-keyshortcuts="?"]').click();
      await expect(page.locator('[data-slot="help-panel"]')).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });
}
