/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test } from '@playwright/test';
import { openShell, stubConfig, useBrowserState } from './support';

// Spec 0003 AC-18, AC-21, AC-22: what the portal and partner frames leave out, what the help
// panel shows, and the visible shortcut on each queue outcome.
test.describe('what the public frames leave out (AC-18)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ['/en/returns', '/ar/returns', '/en/partner', '/ar/partner']) {
    test(`${path}: no sidebar, no command palette, no location switcher, no staff navigation`, async ({
      page,
    }) => {
      await stubConfig(page);
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByRole('main')).toBeVisible();

      await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Search pages|بحث/ })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: /Location|الموقع/ })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }
});

test.describe('the help panel content (AC-21)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'desktop project only'));

  for (const language of ['en', 'ar'] as const) {
    test(`in ${language}: four steps, a glossary with real chips, and the policy number`, async ({
      page,
    }) => {
      await useBrowserState(page, { theme: 'light', language });
      await openShell(page, '/design');

      // Retry the whole open: the gallery remounts once after the shell finishes loading.
      await expect(async () => {
        await page.keyboard.press('Escape');
        await page.locator('main').click({ position: { x: 5, y: 5 } });
        await page.keyboard.press('?');
        await expect(page.locator('[data-slot="help-panel"]')).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });

      const panel = page.locator('[data-slot="help-panel"]');
      await expect(panel.locator('ol > li')).toHaveCount(4);
      const chips = panel.locator('[data-slot="status-chip"]');
      expect(await chips.count()).toBeGreaterThanOrEqual(3);
      for (const chip of await chips.all()) {
        await expect(chip.locator('svg')).toHaveCount(1);
        expect(((await chip.innerText()) ?? '').trim().length).toBeGreaterThan(1);
      }
      // The sentence quotes the limit (3) that the sample passes in, never text of its own.
      await expect(panel).toContainText('3');
      await expect(panel).not.toContainText('{{limit}}');
    });
  }
});

test.describe('the queue outcome buttons (AC-22)', () => {
  test('each outcome button shows its shortcut, and the key records it', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop project only');
    await useBrowserState(page, { theme: 'light', language: 'en' });
    await openShell(page, '/design');

    const card = page.getByTestId('confirmation-queue-card');
    const buttons = card.getByRole('group', { name: 'Outcome' }).getByRole('button');
    await expect(buttons).toHaveCount(4);
    for (const [index, key] of ['1', '2', '3', '4'].entries()) {
      await expect(buttons.nth(index).locator('kbd')).toHaveText(key);
      await expect(buttons.nth(index)).toHaveAttribute('aria-keyshortcuts', key);
    }

    await expect(async () => {
      await buttons.first().focus();
      await page.keyboard.press('3');
      await expect(card.getByRole('status')).toContainText('Call back');
    }).toPass({ timeout: 10_000 });
  });
});
