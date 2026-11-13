/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test, type Page } from '@playwright/test';
import { openShell, useBrowserState, type Theme } from './support';

// Spec 0025 AC-2, AC-3, AC-5, AC-12, AC-17 (and spec 0003 AC-16, AC-19, AC-23): the colour and
// type promises of Midnight, Silver and Cyan, measured in a real browser. The numbers come from
// the tables "Measured contrast" in spec 0025 and packages/ui/DESIGN.md, which were derived
// outside the browser, so a drift in a token shows here even when the live list on /design
// still says "meets".
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'desktop project only'));

/**
 * One published figure per live pair on /design: the `data-testid` suffix, the dark and light
 * ratio of spec 0025 "Measured contrast" (null when the spec has no figure for that theme), and,
 * for an opaque token pair, the two tokens so the figure is also measured independently.
 */
const PUBLISHED: ReadonlyArray<{
  id: string;
  dark: number | null;
  light: number | null;
  fg?: string;
  bg?: string;
}> = [
  { id: 'foreground-on-background', dark: 15.75, light: 17.99, fg: 'foreground', bg: 'background' },
  { id: 'foreground-on-card', dark: 14.63, light: 19.34, fg: 'foreground', bg: 'card' },
  { id: 'foreground-on-muted', dark: 13.35, light: 17.19, fg: 'foreground', bg: 'muted' },
  { id: 'foreground-on-accent', dark: 10.82, light: 16.58, fg: 'foreground', bg: 'accent' },
  { id: 'foreground-on-sidebar', dark: 15.41, light: 16.87, fg: 'foreground', bg: 'sidebar' },
  { id: 'foreground-on-popover', dark: 13.35, light: 19.34, fg: 'foreground', bg: 'popover' },
  {
    id: 'muted-foreground-on-background',
    dark: 7.85,
    light: 7.0,
    fg: 'muted-foreground',
    bg: 'background',
  },
  { id: 'muted-foreground-on-card', dark: 7.29, light: 7.53, fg: 'muted-foreground', bg: 'card' },
  { id: 'muted-foreground-on-muted', dark: 6.65, light: 6.69, fg: 'muted-foreground', bg: 'muted' },
  {
    id: 'muted-foreground-on-accent',
    dark: 5.39,
    light: 6.45,
    fg: 'muted-foreground',
    bg: 'accent',
  },
  {
    id: 'muted-foreground-on-sidebar',
    dark: 7.68,
    light: 6.56,
    fg: 'muted-foreground',
    bg: 'sidebar',
  },
  { id: 'primary-on-background', dark: 11.6, light: 4.98, fg: 'primary', bg: 'background' },
  { id: 'primary-on-accent', dark: 7.97, light: 4.59, fg: 'primary', bg: 'accent' },
  { id: 'primary-on-card', dark: 10.77, light: 5.36, fg: 'primary', bg: 'card' },
  {
    id: 'primary-foreground-on-primary',
    dark: 11.6,
    light: 5.36,
    fg: 'primary-foreground',
    bg: 'primary',
  },
  { id: 'confirmed-on-background', dark: 12.13, light: 5.1, fg: 'confirmed', bg: 'background' },
  { id: 'confirmed-on-accent', dark: 8.33, light: 4.7, fg: 'confirmed', bg: 'accent' },
  { id: 'confirmed-on-card', dark: 11.27, light: 5.48, fg: 'confirmed', bg: 'card' },
  {
    id: 'confirmed-on-confirmed-surface',
    dark: 10.28,
    light: 4.87,
    fg: 'confirmed',
    bg: 'confirmed-surface',
  },
  { id: 'owed-on-background', dark: 10.6, light: 5.04, fg: 'owed', bg: 'background' },
  { id: 'owed-on-accent', dark: 7.28, light: 4.65, fg: 'owed', bg: 'accent' },
  { id: 'owed-on-card', dark: 9.84, light: 5.42, fg: 'owed', bg: 'card' },
  { id: 'owed-on-owed-surface', dark: 8.98, light: 4.82, fg: 'owed', bg: 'owed-surface' },
  { id: 'failed-on-background', dark: 8.52, light: 5.42, fg: 'failed', bg: 'background' },
  { id: 'failed-on-accent', dark: 5.85, light: 4.99, fg: 'failed', bg: 'accent' },
  { id: 'failed-on-card', dark: 7.91, light: 5.82, fg: 'failed', bg: 'card' },
  { id: 'failed-on-failed-surface', dark: 7.22, light: 5.18, fg: 'failed', bg: 'failed-surface' },
  {
    id: 'destructive-on-destructive-surface',
    dark: 7.33,
    light: 5.1,
    fg: 'destructive',
    bg: 'destructive-surface',
  },
  {
    id: 'foreground-on-destructive-surface',
    dark: 13.54,
    light: 16.93,
    fg: 'foreground',
    bg: 'destructive-surface',
  },
  { id: 'destructive-on-accent', dark: 5.85, light: 4.99, fg: 'destructive', bg: 'accent' },
  {
    id: 'success-foreground-on-success',
    dark: 12.13,
    light: 5.48,
    fg: 'success-foreground',
    bg: 'success',
  },
  {
    id: 'warning-foreground-on-warning',
    dark: 10.6,
    light: 5.42,
    fg: 'warning-foreground',
    bg: 'warning',
  },
  {
    id: 'destructive-foreground-on-destructive',
    dark: 8.52,
    light: 5.82,
    fg: 'destructive-foreground',
    bg: 'destructive',
  },
  { id: 'toast-text', dark: 15.75, light: 17.99, fg: 'background', bg: 'foreground' },
  { id: 'ring-on-background', dark: 11.6, light: 4.98, fg: 'ring', bg: 'background' },
  { id: 'ring-on-muted', dark: 9.83, light: 4.76, fg: 'ring', bg: 'muted' },
  { id: 'ring-on-sidebar', dark: 11.35, light: 4.67, fg: 'ring', bg: 'sidebar' },
  { id: 'ring-on-accent', dark: 7.97, light: 4.59, fg: 'ring', bg: 'accent' },
  { id: 'input-on-background', dark: 3.83, light: 4.06, fg: 'input', bg: 'background' },
  { id: 'input-on-card', dark: 3.56, light: 4.36, fg: 'input', bg: 'card' },
  { id: 'input-on-muted', dark: 3.25, light: 3.88, fg: 'input', bg: 'muted' },
  { id: 'input-on-sidebar', dark: 3.75, light: 3.81, fg: 'input', bg: 'sidebar' },
  { id: 'segmented-border', dark: 3.56, light: 4.36, fg: 'input', bg: 'card' },
  { id: 'error-boundary', dark: 8.52, light: 5.42, fg: 'destructive', bg: 'background' },
  {
    id: 'error-toast-border',
    dark: 7.33,
    light: 5.1,
    fg: 'destructive',
    bg: 'destructive-surface',
  },
  {
    id: 'primary-edge-on-background',
    dark: 14.67,
    light: 7.77,
    fg: 'primary-edge',
    bg: 'background',
  },
  { id: 'primary-edge-on-card', dark: null, light: 8.35, fg: 'primary-edge', bg: 'card' },
  // Gradient stops (AC-3): the main button blend, then the hero and heading blends. The white 48% stop of the dark main blend has no published figure.
  { id: 'primary-stop-0', dark: 17.99, light: 14.63 },
  { id: 'primary-stop-1', dark: 12.76, light: 10.35 },
  { id: 'primary-stop-2', dark: null, light: 5.36 },
  { id: 'primary-stop-3', dark: 13.25, light: null },
  { id: 'primary-stop-4', dark: 11.6, light: null },
  { id: 'hero-stop-0', dark: null, light: 14.63 },
  { id: 'hero-stop-1', dark: null, light: 10.35 },
  { id: 'hero-stop-2', dark: null, light: 7.27 },
  { id: 'hero-stop-3', dark: null, light: 5.36 },
  { id: 'heading-stop-0-on-card', dark: 17.96, light: null },
  { id: 'heading-stop-1-on-card', dark: 11.85, light: null },
  { id: 'heading-stop-2-on-background', dark: 11.6, light: 4.98 },
  { id: 'heading-stop-0-on-background', dark: null, light: 17.99 },
  { id: 'heading-stop-1-on-background', dark: null, light: 9.63 },
  // Tints, painted over the card or the sidebar.
  { id: 'selected-row-foreground', dark: 10.85, light: 16.81 },
  { id: 'selected-row-link', dark: 7.99, light: 4.66 },
  { id: 'selected-row-owed', dark: 7.3, light: 4.71 },
  { id: 'selected-row-muted', dark: 5.4, light: 6.54 },
  { id: 'current-page-foreground', dark: 11.07, light: 13.93 },
  { id: 'marker-end', dark: null, light: 4.67 },
  { id: 'nav-hover-muted', dark: 7.08, light: 6.04 },
  { id: 'row-hover-muted', dark: 6.79, light: 6.78 },
  { id: 'row-hover-owed', dark: 9.17, light: 4.88 },
  { id: 'row-hover-foreground', dark: 13.63, light: 17.43 },
];

/** The pairs measured over a translucent tint. */
const TINT_ID = /^(selected-row|current-page|marker|nav-hover|row-hover)/;

/** How many live `contrast-*` pairs /design shows: 45 text and control, 11 tints, and the gradient stops of the theme. */
const LIVE_PAIR_COUNT = { dark: 75, light: 73 } as const;

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
      await expect(pairs).toHaveCount(LIVE_PAIR_COUNT[theme]);
      // No "…" placeholder is left once every pair has been measured.
      await expect(page.locator('[data-testid^="contrast-"]', { hasText: '…' })).toHaveCount(0);
      for (const pair of await pairs.all()) {
        const id = await pair.getAttribute('data-testid');
        const text = ((await pair.textContent()) ?? '').trim();
        // A figure and the word "meets"; the check mark beside it is a separate element.
        expect(text, id ?? '').toMatch(/^\d+\.\d\d:1 meets$/);
      }
    });

    test('the live figures match the published ones to within 0.02 (AC-2, AC-3)', async ({
      page,
    }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await expect(page.locator('[data-testid^="contrast-"]', { hasText: '…' })).toHaveCount(0);

      for (const pair of PUBLISHED) {
        const published = pair[theme];
        if (published === null) continue;
        const text = (await page.getByTestId(`contrast-${pair.id}`).textContent()) ?? '';
        const live = Number.parseFloat(text);
        // Tints are translucent: the spec's script and the browser round the composited
        // pixel differently, so a tint figure may differ by a few hundredths more (at most 0.1).
        const tolerance = TINT_ID.test(pair.id) ? 0.1 : 0.02;
        expect(
          Math.abs(live - published),
          `${pair.id}: live ${live}, published ${published}`,
        ).toBeLessThanOrEqual(tolerance);
      }
    });

    test('an independent measure of the token pairs matches the published figures', async ({
      page,
    }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));

      for (const pair of PUBLISHED) {
        const published = pair[theme];
        if (published === null || !pair.fg || !pair.bg) continue;
        const ratio = await measure(page, pair.fg, pair.bg);
        expect(
          Math.abs(ratio - published),
          `${pair.fg} on ${pair.bg}: ${ratio.toFixed(2)}`,
        ).toBeLessThanOrEqual(0.02);
      }
    });

    test('the palette shows every role with its live hex', async ({ page }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      const expected = {
        light: { background: '#F4F7FA', primary: '#0E7490', card: '#FFFFFF', border: '#0A0E1414' },
        dark: { background: '#0A0E14', primary: '#7DD3FC', card: '#111722', border: '#FFFFFF14' },
      }[theme];
      for (const [role, hex] of Object.entries(expected)) {
        await expect(page.getByTestId(`hex-${role}`)).toHaveText(hex);
      }
    });

    test('the four named radii are 6, 8, 10 and 12px (AC-12)', async ({ page }) => {
      await useBrowserState(page, { theme, language: 'en' });
      await openShell(page, '/design');
      const radii = {
        'rounded-chip': 6,
        'rounded-control': 8,
        'rounded-popover': 10,
        'rounded-card': 12,
      };
      for (const [name, px] of Object.entries(radii)) {
        const radius = await page
          .getByTestId(`radius-${name}`)
          .evaluate((node) => getComputedStyle(node).borderTopLeftRadius);
        expect(radius, name).toBe(`${px}px`);
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

test.describe('/design lists the pairs spec 0025 names (AC-2)', () => {
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
      expect(style.family).toMatch(/Geist Mono/);
      expect(style.bidi).toMatch(/isolate/);
    }
  });
});
