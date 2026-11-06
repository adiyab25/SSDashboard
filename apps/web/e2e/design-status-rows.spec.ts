import { expect, test, type Page } from '@playwright/test';
import { openShell, useBrowserState } from './support';

// Spec 0003 AC-16, AC-17, AC-20, AC-22: the order row sample, the provisional value, the freshness
// strip, and the focus ring width, read from the rendered /design page in both reading directions.
const desktopOnly = (name: string) => test.skip(name !== 'desktop', 'desktop project only');

const SAMPLES = [
  {
    dir: 'ltr',
    label: 'Sample orders, left to right',
    provisional: 'Provisional',
    fresh: /Confirmed through 4 Nov, today is provisional/,
  },
  {
    dir: 'rtl',
    label: 'Sample orders, right to left',
    provisional: 'مبدئي',
    fresh: /مؤكد حتى ٤ نوفمبر، وأرقام اليوم مبدئية/,
  },
] as const;

const sampleRoot = (page: Page, dir: 'ltr' | 'rtl') =>
  page.locator(`div[dir="${dir}"]`, { has: page.locator('[data-slot="freshness-strip"]') }).first();

for (const sample of SAMPLES) {
  test.describe(`order rows, ${sample.dir} (AC-16, AC-17)`, () => {
    test.beforeEach(async ({ page }, info) => {
      desktopOnly(info.project.name);
      await useBrowserState(page, { theme: 'light', language: 'en' });
      await openShell(page, '/design');
    });

    test('the freshness strip names the confirmed day and says today is provisional', async ({
      page,
    }) => {
      await expect(
        sampleRoot(page, sample.dir).locator('[data-slot="freshness-strip"]'),
      ).toHaveText(sample.fresh);
    });

    test('every state is an icon plus a word, and stays readable in grayscale', async ({
      page,
    }) => {
      const root = sampleRoot(page, sample.dir);
      await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });

      const chips = root.locator('[data-slot="status-chip"]');
      expect(await chips.count()).toBeGreaterThanOrEqual(5);
      for (const chip of await chips.all()) {
        await expect(chip.locator('svg')).toBeVisible();
        const box = await chip.boundingBox();
        expect(box?.width).toBeGreaterThan(24);
        expect(((await chip.innerText()) ?? '').trim().length).toBeGreaterThan(1);
      }
      // With every colour removed, the failed row still says so in words.
      await expect(root.getByRole('row').nth(3)).toContainText(
        sample.dir === 'ltr' ? 'Delivery failed' : 'فشل التسليم',
      );
    });

    test('a provisional total reads "provisional" to a screen reader and starts with the approximation sign', async ({
      page,
    }) => {
      const value = sampleRoot(page, sample.dir).locator('[data-slot="provisional-value"]');
      await expect(value).toHaveCount(1);
      // The hidden label is real text in the accessibility tree, the sign is hidden from it.
      await expect(value.locator('.sr-only')).toHaveText(sample.provisional);
      await expect(value.locator('[aria-hidden="true"]')).toHaveText('≈');
      expect(await value.evaluate((element) => getComputedStyle(element).borderStyle)).toBe(
        'dashed',
      );

      // The sign sits before the number in reading order: at the left in ltr, at the right in rtl.
      const geometry = await value.evaluate((element) => {
        const sign = element.querySelector('[aria-hidden="true"]')!.getBoundingClientRect();
        const bdi = element.querySelector('bdi')!;
        const range = document.createRange();
        range.setStart(bdi.lastChild!, 0);
        range.setEnd(bdi.lastChild!, (bdi.lastChild as Text).length);
        const number = range.getBoundingClientRect();
        return {
          signStart: sign.left,
          signEnd: sign.right,
          numberStart: number.left,
          numberEnd: number.right,
        };
      });
      if (sample.dir === 'ltr')
        expect(geometry.signEnd).toBeLessThanOrEqual(geometry.numberStart + 1);
      else expect(geometry.signStart).toBeGreaterThanOrEqual(geometry.numberEnd - 1);
    });

    test('a confirmed total is plain: no approximation sign, no dashed boundary', async ({
      page,
    }) => {
      const cells = sampleRoot(page, sample.dir).getByRole('row').nth(1).getByRole('cell');
      await expect(cells.nth(3)).not.toContainText('≈');
      await expect(cells.nth(3).locator('[data-slot="provisional-value"]')).toHaveCount(0);
    });

    test('one row shows two chips and a "+2" chip with its own accessible text', async ({
      page,
    }) => {
      const row = sampleRoot(page, sample.dir).getByRole('row').nth(3);
      await expect(row.locator('[data-slot="status-chip"]')).toHaveCount(2);
      const more = row.locator('[data-slot="status-chip-overflow"]');
      await expect(more).toHaveCount(1);
      await expect(more).toContainText('+2');
      await expect(more.locator('.sr-only')).not.toHaveText('');
    });
  });
}

test.describe('the "+2" chip opens the rest (spec 0003 design delta, AC-16)', () => {
  // The component's own TSDoc says a hidden failed or owed status must stay reachable.
  for (const sample of SAMPLES) {
    test(`is a button that reveals the hidden statuses, ${sample.dir}`, async ({ page }, info) => {
      desktopOnly(info.project.name);
      await useBrowserState(page, { theme: 'light', language: 'en' });
      await openShell(page, '/design');

      const more = sampleRoot(page, sample.dir).locator('[data-slot="status-chip-overflow"]');
      const popover = page.locator('[data-slot="popover-content"]');
      await expect(more).toHaveJSProperty('tagName', 'BUTTON');

      for (const key of ['Enter', 'Space']) {
        // The gallery remounts once after the shell loads; retry the whole step if it lands here.
        await expect(async () => {
          await more.scrollIntoViewIfNeeded({ timeout: 2_000 });
          await more.focus();
          await expect(more).toHaveAttribute('aria-expanded', 'false', { timeout: 2_000 });
          await page.keyboard.press(key);
          await expect(more).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
          await expect(popover).toBeVisible({ timeout: 2_000 });
          // The two hidden statuses are listed as chips.
          await expect(popover.locator('[data-slot="status-chip"]')).toHaveCount(2);
          await expect(popover.locator('[data-meaning="failed"]')).toHaveCount(1);
          await page.keyboard.press('Escape');
          await expect(popover).toHaveCount(0);
          await expect(more).toHaveAttribute('aria-expanded', 'false');
          await expect(more).toBeFocused();
        }).toPass({ timeout: 15_000 });
      }
    });
  }
});

test.describe('focus ring width (AC-4, AC-22)', () => {
  test('is 2px on a mouse and 3px in the floor scope on a touch screen', async ({ page }, info) => {
    await useBrowserState(page, { theme: 'light', language: 'en' });
    await openShell(page, '/design');
    const button = page
      .getByTestId('confirmation-queue-card')
      .getByRole('group', { name: 'Outcome' })
      .getByRole('button')
      .first();
    await button.scrollIntoViewIfNeeded();

    await expect(async () => {
      await button.focus();
      // The app never sets focus from a pointer here, so :focus-visible applies on keyboard.
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS('outline-style', 'solid');
      await expect(button).toHaveCSS(
        'outline-width',
        info.project.name === 'mobile' ? '3px' : '2px',
      );
    }).toPass({ timeout: 15_000 });
  });
});
