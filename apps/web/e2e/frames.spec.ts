import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, stubConfig } from './support';

// Spec 0003 AC-18, AC-19, AC-20: the portal and partner frames on a phone (360 by 800, touch),
// on the real pages and on the development only previews shown in /design. Public pages are
// anonymous; the /design checks keep the signed in staff session of the project.
test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });

const REAL_PAGES = ['/en/returns', '/ar/returns', '/en/partner', '/ar/partner'];
const PREVIEWS = [
  '/en/returns/preview/brand',
  '/ar/returns/preview/brand',
  '/en/returns/preview/rejected',
  '/ar/returns/preview/rejected',
  '/en/partner/preview',
  '/ar/partner/preview',
];
const WIDTHS = [320, 360, 430];

/**
 * True when the page scrolls sideways. It compares with the width the test set, not with
 * `window.innerWidth`: on an `isMobile` page a too wide page grows the layout viewport, so
 * `innerWidth` follows the overflow and the comparison can never fail.
 */
async function overflowsSideways(page: Page): Promise<boolean> {
  const width = page.viewportSize()?.width ?? 0;
  return page.evaluate((limit) => document.documentElement.scrollWidth > limit, width);
}

test.describe('the frames on a phone', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of [...REAL_PAGES, ...PREVIEWS]) {
    test(`${path}: one main, one h1, no sideways scroll from 320 to 430px, no axe violations`, async ({
      page,
    }) => {
      await stubConfig(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.locator('main#main-content')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        expect(await overflowsSideways(page), `${path} at ${width}px`).toBe(false);
      }
      await page.setViewportSize({ width: 360, height: 800 });
      await expectNoAxeViolations(page);
    });
  }

  test('the skip link on a real page jumps to the frame main', async ({ page }) => {
    await page.goto('/en/returns');
    await page.keyboard.press('Tab');

    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main-content')).toBeFocused();
  });

  test('the real pages carry no brand override: the neutral primary shows', async ({ page }) => {
    await page.goto('/en/returns');

    await expect(page.locator('[data-slot="portal-frame"]')).not.toHaveAttribute('style', /brand/);
  });

  test('the sample brand colours the tile and the main button, never the focus ring', async ({
    page,
  }) => {
    await page.goto('/en/returns/preview/brand');
    const green = 'rgb(10, 124, 57)';

    const tile = page.locator('[data-slot="brand-mark"] img');
    await expect(tile).toHaveCSS('background-color', green);
    await expect(page.getByTestId('brand-button')).toHaveCSS('background-color', green);
    await expect(page.getByTestId('brand-button')).toHaveCSS('color', 'rgb(255, 255, 255)');

    // Reach the button with the keyboard, so :focus-visible draws the ring.
    await page.getByRole('textbox').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('brand-button')).toBeFocused();
    const system = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ring)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    // The button transitions `all` for 150ms, so the outline fades in from the text colour:
    // poll until it settles instead of reading one frame (a mid fade read gave a near white).
    await expect(page.getByTestId('brand-button')).toHaveCSS('outline-color', system);
    expect(system).not.toBe(green);
  });

  test('a rejected accent falls back to the neutral primary and says why', async ({ page }) => {
    await page.goto('/en/returns/preview/rejected');

    await expect(page.locator('[data-slot="portal-frame"]')).not.toHaveAttribute('style', /brand/);
    await expect(page.getByTestId('brand-refusal')).toContainText('#997311 was refused');
    await expect(page.getByTestId('brand-refusal')).toContainText('#9B7511');
    const primary = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--primary)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(page.getByTestId('brand-button')).toHaveCSS('background-color', primary);
  });

  for (const path of ['/en/returns', '/ar/returns', '/en/partner', '/ar/partner']) {
    test(`${path}: the language link is at least 44 by 44px`, async ({ page }) => {
      await page.goto(path);
      const box = await page.locator('a[hreflang]').boundingBox();

      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    });
  }

  test('the partner preview logs no console error (distinct tab keys)', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/en/partner/preview');
    await page.waitForLoadState('networkidle');

    expect(errors.filter((text) => /same key/i.test(text))).toEqual([]);
  });

  test('the preview pages mirror in Arabic', async ({ page }) => {
    await page.goto('/ar/partner/preview');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('navigation', { name: 'أقسام الشريك' }).getByRole('link'),
    ).toHaveCount(3);
  });
});

test.describe('/design shows the frames', () => {
  test('every frame sample is a titled iframe in both directions, and the page does not scroll sideways', async ({
    page,
  }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/design', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      expect(await overflowsSideways(page), `/design at ${width}px`).toBe(false);
    }

    const frames = page.locator('#frames').locator('xpath=ancestor::section').locator('iframe');
    await expect(frames).toHaveCount(6);
    for (const frame of await frames.all()) {
      expect(((await frame.getAttribute('title')) ?? '').length).toBeGreaterThan(0);
    }
    await expect(page.getByRole('region', { name: 'Button variants by state' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });
});
