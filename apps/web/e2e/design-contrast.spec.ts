/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test, type Page } from '@playwright/test';
import { openShell, useBrowserState, type Theme } from './support';

// Spec 0003 AC-2, AC-15, AC-16, AC-19, AC-23: the colour and type promises of the Daftar
// direction, measured in a real browser. The numbers come from the table "Measured contrast" in
// packages/ui/DESIGN.md, which was derived outside the browser, so a drift in a token shows here
// even when the live list on /design still says "meets".
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'desktop project only'));

/** Every pair the DESIGN.md table lists, with its published light and dark ratio and minimum. */
const PUBLISHED: ReadonlyArray<{
  fg: string;
  bg: string;
  light: number;
  dark: number;
  min: number;
}> = [
  { fg: 'foreground', bg: 'background', light: 16.61, dark: 16.45, min: 4.5 },
  { fg: 'foreground', bg: 'card', light: 17.2, dark: 15.06, min: 4.5 },
  { fg: 'foreground', bg: 'muted', light: 15.22, dark: 13.01, min: 4.5 },
  { fg: 'foreground', bg: 'accent', light: 14.33, dark: 11.32, min: 4.5 },
  { fg: 'muted-foreground', bg: 'background', light: 6.85, dark: 8.3, min: 4.5 },
  { fg: 'muted-foreground', bg: 'card', light: 7.09, dark: 7.59, min: 4.5 },
  { fg: 'muted-foreground', bg: 'muted', light: 6.27, dark: 6.56, min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', light: 10.05, dark: 8.82, min: 4.5 },
  { fg: 'primary', bg: 'background', light: 9.91, dark: 8.99, min: 4.5 },
  { fg: 'primary', bg: 'card', light: 10.26, dark: 8.22, min: 4.5 },
  { fg: 'success', bg: 'background', light: 6.77, dark: 9.78, min: 4.5 },
  { fg: 'warning', bg: 'background', light: 6.45, dark: 10.45, min: 4.5 },
  { fg: 'destructive', bg: 'background', light: 6.34, dark: 7.46, min: 4.5 },
  { fg: 'info', bg: 'background', light: 7.02, dark: 9.37, min: 4.5 },
  { fg: 'confirmed', bg: 'confirmed-surface', light: 5.8, dark: 7.27, min: 4.5 },
  { fg: 'owed', bg: 'owed-surface', light: 5.55, dark: 7.71, min: 4.5 },
  { fg: 'failed', bg: 'failed-surface', light: 5.47, dark: 5.73, min: 4.5 },
  { fg: 'info', bg: 'info-surface', light: 6.0, dark: 7.01, min: 4.5 },
  { fg: 'provisional', bg: 'card', light: 7.09, dark: 7.59, min: 4.5 },
  { fg: 'input', bg: 'background', light: 4.11, dark: 4.67, min: 3 },
  { fg: 'input', bg: 'card', light: 4.26, dark: 4.28, min: 3 },
  { fg: 'input', bg: 'muted', light: 3.77, dark: 3.7, min: 3 },
  { fg: 'ring', bg: 'background', light: 9.91, dark: 8.99, min: 3 },
  { fg: 'ring', bg: 'card', light: 10.26, dark: 8.22, min: 3 },
  { fg: 'ring', bg: 'muted', light: 9.08, dark: 7.11, min: 3 },
];

/**
 * WCAG 2 contrast of two tokens, measured here and not by the app's own helper: each colour is
 * resolved by the browser (so `oklch()` and `color-mix()` come out as real sRGB), painted on a
 * canvas over the page background, and read back as 8 bit channels.
 */
async function measure(page: Page, fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([foreground, background]) => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const resolve = (name: string) => {
        probe.style.color = `var(--${name})`;
        return getComputedStyle(probe).color;
      };
      const paint = (front: string, back: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('no canvas');
        context.fillStyle = back;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = front;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)] as number[];
      };
      const page = resolve('background');
      const back = paint(resolve(background), page);
      const front = paint(resolve(foreground), resolve(background));
      probe.remove();
      const luminance = (rgb: number[]) => {
        const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [hi = 0, lo = 0] = [luminance(front), luminance(back)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    },
    [fg, bg] as const,
  );
}

for (const theme of ['light', 'dark'] satisfies Theme[]) {
  test.describe(`/design contrast in ${theme}`, () => {
    test('every live pair on the page meets its own minimum', async ({ page }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));

      const pairs = page.locator('[data-testid^="contrast-"]');
      await expect(pairs).toHaveCount(39);
      // No "…" placeholder is left once every pair has been measured.
      await expect(page.locator('[data-testid^="contrast-"]', { hasText: '…' })).toHaveCount(0);
      for (const pair of await pairs.all()) {
        const id = await pair.getAttribute('data-testid');
        const text = ((await pair.textContent()) ?? '').trim();
        expect(text, id ?? '').toMatch(/^\d+\.\d\d:1 meets$/);
      }
    });

    test('an independent measure matches the figures published in DESIGN.md', async ({ page }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));

      for (const pair of PUBLISHED) {
        const ratio = await measure(page, pair.fg, pair.bg);
        const published = pair[theme];
        expect(ratio, `${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(pair.min);
        // 8 bit rounding moves a ratio by a few hundredths at most.
        expect(
          Math.abs(ratio - published),
          `${pair.fg} on ${pair.bg}: ${ratio.toFixed(2)}`,
        ).toBeLessThan(0.12);
      }
    });

    test('the four meaning roles are aliases of the success, destructive, warning, and muted hues', async ({
      page,
    }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      const resolved = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const read = (name: string) => {
          probe.style.color = `var(--${name})`;
          return getComputedStyle(probe).color;
        };
        const values = Object.fromEntries(
          [
            'confirmed',
            'success',
            'failed',
            'destructive',
            'owed',
            'warning',
            'provisional',
            'muted-foreground',
          ].map((name) => [name, read(name)]),
        );
        probe.remove();
        return values;
      });
      expect(resolved.confirmed).toBe(resolved.success);
      expect(resolved.failed).toBe(resolved.destructive);
      expect(resolved.owed).toBe(resolved.warning);
      expect(resolved.provisional).toBe(resolved['muted-foreground']);
      expect(
        new Set([resolved.confirmed, resolved.failed, resolved.owed, resolved.provisional]).size,
      ).toBe(4);
    });
  });
}

test.describe('/design lists the Daftar pairs the amendment names (AC-15)', () => {
  // The amendment (spec 0003, 2026-11-06) says the live list covers `primary` on `background`
  // and `card` (text) and the `ring` on `background` and `card` (non text).
  test('has primary on background and card, and ring on card', async ({ page }) => {
    await useBrowserState(page, { theme: 'light', language: 'en' });
    await openShell(page, '/design');

    await expect(page.getByTestId('contrast-primary-on-background')).toHaveText(/:1 meets$/);
    await expect(page.getByTestId('contrast-primary-on-card')).toHaveText(/:1 meets$/);
    await expect(page.getByTestId('contrast-ring-on-card')).toHaveText(/:1 meets$/);
  });
});

test.describe('status chips and the brand accent (AC-16, AC-19)', () => {
  test('a brand accent set on the page leaves every chip on the system colours', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'light', language: 'en' });
    await openShell(page, '/design');

    const chipColours = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-slot="status-chip"]')].map((chip) => {
          const style = getComputedStyle(chip);
          return `${style.color}|${style.backgroundColor}|${style.borderColor}`;
        }),
      );
    const before = await chipColours();
    expect(before.length).toBeGreaterThan(0);

    await page.evaluate(() => {
      document.documentElement.style.setProperty('--brand', 'rgb(10, 124, 57)');
      document.documentElement.style.setProperty('--brand-foreground', 'rgb(255, 255, 255)');
    });

    expect(await chipColours()).toEqual(before);
  });
});

test.describe('Arabic type (AC-23)', () => {
  test('a real Arabic page is one pixel larger than English, in Noto Sans Arabic, with line height of at least 1.7', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'light', language: 'en' });
    await openShell(page, '/design');
    const latin = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));

    await useBrowserState(page, { theme: 'light', language: 'ar' });
    await openShell(page, '/design');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    const arabic = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const heading = getComputedStyle(document.querySelector('h1') as Element);
      return {
        size: parseFloat(body.fontSize),
        lineHeight: parseFloat(body.lineHeight),
        family: body.fontFamily,
        headingRatio: parseFloat(heading.lineHeight) / parseFloat(heading.fontSize),
      };
    });

    expect(arabic.size).toBeGreaterThanOrEqual(latin + 1);
    expect(arabic.lineHeight / arabic.size).toBeGreaterThanOrEqual(1.7);
    expect(arabic.headingRatio).toBeGreaterThanOrEqual(1.7);
    expect(arabic.family).toMatch(/Noto Sans Arabic/);
  });

  test('the Arabic specimen on /design shows the real 16px against 15px Latin', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'light', language: 'en' });
    await openShell(page, '/design');
    const specimen = page.locator('[lang="ar"] p', { hasText: 'Noto Sans Arabic' });
    await expect(async () => {
      const size = await specimen.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      expect(size).toBe(16);
    }).toPass({ timeout: 15_000 });
  });

  test('a code inside Arabic text keeps its order and the monospace face', async ({ page }) => {
    await useBrowserState(page, { theme: 'light', language: 'ar' });
    await openShell(page, '/design');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const codes = page.locator('[data-slot="ltr-text"]');
    expect(await codes.count()).toBeGreaterThan(0);
    for (const code of await codes.all()) {
      const style = await code.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          direction: computed.direction,
          family: computed.fontFamily,
          bidi: computed.unicodeBidi,
        };
      });
      expect(style.direction).toBe('ltr');
      expect(style.family).toMatch(/JetBrains Mono/);
      expect(style.bidi).toMatch(/isolate/);
    }
  });
});
