/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test, type Page } from '@playwright/test';
import { openShell, seedLocations, textFor, useBrowserState, type TextDirection } from './support';
import { shot } from './look-support';

// Spec 0025 milestone M2, batch 1 (AC-4, AC-10, AC-11, AC-13, AC-20, AC-22): the back office shell
// and the sign in screens in the Midnight look, measured by computed style in a real browser. Set
// SHOT_DIR to also save screenshots. Desktop project; the phone sheet has its own test below.

async function openAuthPage(page: Page, path: string) {
  const hydrated = page.waitForResponse((response) => response.url().endsWith('/api/config'));
  await page.goto(path);
  await hydrated;
  await page.evaluate(() => document.fonts.ready);
}

test.describe('sign in frame (AC-13, AC-22)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [theme, dir] of [
    ['dark', 'ltr'],
    ['light', 'rtl'],
  ] as const) {
    test(`glow and grid are decorative and the card has the edge in ${theme} ${dir}`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'desktop');
      await useBrowserState(page, { theme, dir });
      await openAuthPage(page, '/sign-in');

      const layers = page.locator(
        'div[aria-hidden="true"].gradient-glow, div[aria-hidden="true"].gradient-grid',
      );
      await expect(layers).toHaveCount(2);
      for (const layer of await layers.all()) {
        expect(await layer.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
        expect(await layer.evaluate((e) => e.getAttribute('tabindex'))).toBeNull();
        expect(await layer.evaluate((e) => e.textContent)).toBe('');
      }
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const card = page.locator('main > div.gradient-card-edge');
      expect(await card.evaluate((e) => getComputedStyle(e).borderRadius)).toBe('12px');
      expect(await card.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain(
        'linear-gradient',
      );
      await shot(page, theme === 'dark' ? 'signin-dark-en' : 'signin-light-ar');
    });
  }

  test('the form keeps 384px inside the card and the skip link has a boundary', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await useBrowserState(page, { theme: 'dark', dir: 'ltr' });
    await openAuthPage(page, '/sign-in');
    const formWidth = await page.locator('main > div.gradient-card-edge').evaluate((card) => {
      const style = getComputedStyle(card);
      return (
        card.getBoundingClientRect().width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        parseFloat(style.borderLeftWidth) -
        parseFloat(style.borderRightWidth)
      );
    });
    expect(formWidth).toBe(384);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: /skip/i }).first();
    await expect(skip).toBeFocused();
    expect(await skip.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('1px');
    await shot(page, 'skip-link-focus-dark-en');
  });

  test('phone: the form keeps 272px at 320px wide with no sideways scroll', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await page.setViewportSize({ width: 320, height: 700 });
    await useBrowserState(page, { theme: 'dark', dir: 'ltr' });
    await openAuthPage(page, '/sign-in');
    const measured = await page.locator('main > div.gradient-card-edge').evaluate((card) => {
      const style = getComputedStyle(card);
      return {
        width: card.getBoundingClientRect().width,
        padding: style.paddingInlineStart,
        border: style.borderInlineStartWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    console.log(`320px card: ${JSON.stringify(measured)}`);
    expect(measured).toMatchObject({ width: 272, padding: '0px', border: '0px' });
    expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth);
    await shot(page, 'signin-phone-320-dark-en');
  });

  test('two factor screen in dark Arabic', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await useBrowserState(page, { theme: 'dark', dir: 'rtl' });
    await openAuthPage(page, '/two-factor');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await shot(page, 'two-factor-dark-ar');
  });
});

async function labelLook(page: Page) {
  return page
    .locator('[data-slot="sidebar-group-label"]')
    .first()
    .evaluate((element) => {
      const computed = getComputedStyle(element);
      const before = getComputedStyle(element, '::before');
      return {
        fontFamily: computed.fontFamily,
        textTransform: computed.textTransform,
        color: computed.color,
        beforeContent: before.content,
        beforeColor: before.color,
        opacity: computed.opacity,
      };
    });
}

for (const [theme, dir, name] of [
  ['dark', 'ltr', 'shell-home-dark-en'],
  ['light', 'rtl', 'shell-home-light-ar'],
] as const satisfies readonly (readonly [string, TextDirection, string])[]) {
  test.describe(`shell home in ${theme} ${dir}`, () => {
    test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop'));

    test('group labels show // in cyan, the current page tint mirrors, one h1', async ({
      page,
    }) => {
      await useBrowserState(page, { theme, dir });
      await openShell(page, '/');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      const label = await labelLook(page);
      expect(label.beforeContent).toContain('//');
      expect(label.fontFamily.toLowerCase()).toContain('mono');
      expect(label.textTransform).toBe('lowercase');
      expect(label.beforeColor).not.toBe(label.color);

      const current = page.locator('[data-sidebar="menu-button"][data-active="true"]').first();
      await expect(current).toBeVisible();
      const look = await current.evaluate((element) => {
        const computed = getComputedStyle(element);
        const before = getComputedStyle(element, '::before');
        return {
          image: computed.backgroundImage,
          color: computed.backgroundColor,
          markerWidth: before.width,
          markerInset: before.insetInlineStart,
        };
      });
      console.log(`current page look ${theme} ${dir}: ${JSON.stringify(look)}`);
      expect(look.image).toContain(dir === 'rtl' ? '270deg' : '90deg');
      await shot(page, name);
    });
  });
}

test.describe('shell overlays and states', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop'));

  test('command palette, dark English', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', dir: 'ltr' });
    await openShell(page, '/');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Go to a page' })).toBeVisible();
    await shot(page, 'command-palette-dark-en');
  });

  test('user menu, light English', async ({ page }) => {
    await useBrowserState(page, { theme: 'light', dir: 'ltr' });
    await openShell(page, '/');
    await page.getByRole('button', { name: /User menu/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await shot(page, 'user-menu-light-en');
  });

  test('location switcher, dark Arabic', async ({ page }) => {
    const seeded = await seedLocations();
    try {
      await useBrowserState(page, { theme: 'dark', dir: 'rtl' });
      await openShell(page, '/');
      await page.getByRole('button', { name: /^(Location|الموقع)/ }).click();
      await expect(page.getByRole('option').first()).toBeVisible();
      await shot(page, 'location-switcher-dark-ar');
    } finally {
      await seeded.remove();
    }
  });

  test('a license notice banner, dark English', async ({ page }) => {
    const notice = {
      bundle: 'operations',
      phase: 'grace',
      level: 'warning',
      expiresOn: '2026-12-01',
      daysLeft: 10,
      lapsesOn: '2026-12-16',
      lapsesAt: '2026-12-15T22:00:00.000Z',
      windDownEndsOn: '2027-02-14',
    };
    await page.route('**/api/platform/license', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              bundles: [
                {
                  bundle: 'warehouse',
                  phase: 'active',
                  perpetual: true,
                  expiresOn: null,
                  daysLeft: null,
                  lapsesAt: null,
                },
                {
                  bundle: 'operations',
                  phase: notice.phase,
                  perpetual: false,
                  expiresOn: notice.expiresOn,
                  daysLeft: notice.daysLeft,
                  lapsesAt: notice.lapsesAt,
                },
              ],
              lastCheck: null,
              licenses: [],
              notices: [notice],
            },
          })
        : route.continue(),
    );
    await useBrowserState(page, { theme: 'dark', dir: 'ltr' });
    await page.goto('/');
    await expect(
      page.getByRole('region', { name: textFor('ltr', 'settings.license.banner.label') }),
    ).toBeVisible();
    await shot(page, 'notice-license-dark-en');
  });

  test('the collapsed icon rail hides labels, dark English', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', dir: 'ltr' });
    await openShell(page, '/');
    await page.keyboard.press('Control+b');
    const sidebar = page.locator('[data-slot="sidebar"][data-state]');
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    const label = page.locator('[data-slot="sidebar-group-label"]').first();
    await expect.poll(() => label.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    const width = await page
      .locator('[data-slot="sidebar-container"]')
      .evaluate((e) => e.getBoundingClientRect().width);
    expect(width).toBeLessThan(80);
    await shot(page, 'rail-dark-en');
    await page.keyboard.press('Control+b');
  });
});

test.describe('density is unchanged (AC-20)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop'));
  test('top bar 56, nav item 32, body 15', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', dir: 'ltr' });
    await openShell(page, '/');
    const heights = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontSize,
      top: document.querySelector('header')?.getBoundingClientRect().height,
      item: document.querySelector('[data-sidebar="menu-button"]')?.getBoundingClientRect().height,
    }));
    expect(heights).toEqual({ body: '15px', top: 56, item: 32 });
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`Tab through the shell in ${theme}: each focused control shows a ring (AC-22)`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    test.setTimeout(120_000);
    await useBrowserState(page, { theme, dir: 'ltr' });
    await openShell(page, '/');
    const failures: string[] = [];
    const seen = new Set<string>();
    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press('Tab');
      const found = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body || element.tagName === 'NEXTJS-PORTAL')
          return null;
        const computed = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          id: `${element.tagName}:${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 24)}:${Math.round(rect.x)}:${Math.round(rect.y)}`,
          width: computed.outlineWidth,
          style: computed.outlineStyle,
          shadow: computed.boxShadow,
        };
      });
      if (!found) continue;
      if (seen.has(found.id)) break;
      seen.add(found.id);
      const ring =
        (found.style !== 'none' && parseFloat(found.width) >= 2) || found.shadow !== 'none';
      if (!ring) failures.push(found.id);
    }
    console.log(`focus stops ${theme}: ${seen.size}`);
    expect(seen.size).toBeGreaterThan(8);
    expect(failures).toEqual([]);
  });
}

test('phone: the sidebar opens as a sheet in dark Arabic', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile');
  await useBrowserState(page, { theme: 'dark', dir: 'rtl' });
  await openShell(page, '/');
  await page.getByRole('button', { name: 'فتح التنقل' }).click();
  await expect(page.getByRole('dialog', { name: 'التنقل' })).toBeVisible();
  await shot(page, 'shell-mobile-dark-ar');
});
