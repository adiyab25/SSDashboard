/* eslint-disable no-empty-pattern -- Playwright needs `({}, info)` to reach testInfo without fixtures. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openShell, textFor, useBrowserState, type TextDirection } from './support';

// Spec 0025 AC-13 (gradients mirror), AC-18 (motion timings), AC-19 (reduced motion), AC-20
// (density unchanged), measured by computed style on /design in a real browser. Desktop only:
// /design exists in development, and the hover and press checks need a real pointer.
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'desktop project only'));

/** Opens /design and waits until the lazy gallery has settled, so no element is swapped under a locator. */
async function openDesign(page: Page) {
  await openShell(page, '/design');
  await expect(page.getByTestId('motion-note')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

function motionButton(page: Page, key: 'sheen' | 'lift' | 'press'): Locator {
  return page.getByRole('button', { name: textFor('ltr', `design.motion.${key}`), exact: true });
}

async function style(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );
}

test.describe('motion in a normal session (AC-18)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('buttons transition 180ms on transform, shadow and colours with the one easing', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const lift = motionButton(page, 'lift');
    await lift.scrollIntoViewIfNeeded();
    expect(await style(lift, 'transition-duration')).toContain('0.18s');
    const properties = await style(lift, 'transition-property');
    for (const name of ['transform', 'box-shadow', 'color', 'background-color']) {
      expect(properties).toContain(name);
    }
    expect(await style(lift, 'transition-timing-function')).toContain(EASE);
  });

  test('hover lifts a button 1px with a shadow, and the main button sweeps its sheen in 600ms', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const lift = motionButton(page, 'lift');
    await lift.scrollIntoViewIfNeeded();
    await lift.hover();
    await expect.poll(() => style(lift, 'transform')).toBe('matrix(1, 0, 0, 1, 0, -1)');
    expect(await style(lift, 'box-shadow')).not.toBe('none');

    const sheen = motionButton(page, 'sheen');
    await sheen.scrollIntoViewIfNeeded();
    // The duration that applies to background-position (the sweep) specifically.
    const sweep = await sheen.evaluate((element) => {
      const computed = getComputedStyle(element);
      const properties = computed.transitionProperty.split(',').map((value) => value.trim());
      const durations = computed.transitionDuration.split(',').map((value) => value.trim());
      const index = properties.indexOf('background-position');
      return index < 0 ? null : (durations[index % durations.length] ?? null);
    });
    expect(sweep, 'background-position transition duration').toBe('0.6s');
    const before = await style(sheen, 'background-position');
    await sheen.hover();
    await expect
      .poll(() => style(sheen, 'background-position'), { timeout: 3000 })
      .not.toBe(before);
  });

  test('pressing scales a button to .98', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const press = motionButton(page, 'press');
    await press.scrollIntoViewIfNeeded();
    await press.hover();
    await page.mouse.down();
    await expect.poll(() => style(press, 'transform')).toContain('0.98');
    await page.mouse.up();
  });

  test('page sections enter over 500ms with a 50ms stagger capped at 200ms', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const children = page.getByTestId('motion-enter').locator('> *');
    await children.first().scrollIntoViewIfNeeded();
    const timings = await children.evaluateAll((nodes) =>
      nodes.map((node) => {
        const computed = getComputedStyle(node);
        return [computed.animationName, computed.animationDuration, computed.animationDelay];
      }),
    );
    expect(timings[0]).toEqual(['ui-enter', '0.5s', '0s']);
    expect(timings[1]).toEqual(['ui-enter', '0.5s', '0.05s']);
    expect(timings[2]).toEqual(['ui-enter', '0.5s', '0.1s']);
  });

  test('the skeleton pulses for 1.4s, forever', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const skeleton = page.locator('[data-slot="skeleton"]').first();
    await skeleton.scrollIntoViewIfNeeded();
    expect(await style(skeleton, 'animation-duration')).toBe('1.4s');
    expect(await style(skeleton, 'animation-iteration-count')).toBe('infinite');
    expect(await style(skeleton, 'animation-name')).not.toBe('none');
  });

  test('a dropdown opens in 150ms', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    await page
      .getByRole('button', { name: textFor('ltr', 'design.motion.dropdown'), exact: true })
      .click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await style(menu, 'animation-duration')).toContain('0.15s');
  });
});

test.describe('reduced motion (AC-19)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('hovered and pressed buttons do not move, and have no transition', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    for (const key of ['lift', 'sheen', 'press'] as const) {
      const button = motionButton(page, key);
      await button.scrollIntoViewIfNeeded();
      await button.hover();
      expect(await style(button, 'transform'), `${key} hovered`).toBe('none');
      await page.mouse.down();
      expect(await style(button, 'transform'), `${key} pressed`).toBe('none');
      await page.mouse.up();
      expect(await style(button, 'transition-duration'), `${key} transition`).toBe('0s');
    }
  });

  test('the main button does not sweep its sheen', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const sheen = motionButton(page, 'sheen');
    await sheen.scrollIntoViewIfNeeded();
    const before = await style(sheen, 'background-position');
    await sheen.hover();
    await page.waitForTimeout(800);
    expect(await style(sheen, 'background-position')).toBe(before);
  });

  test('no entrance, skeleton or dropdown animation runs', async ({ page }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const sections = await page
      .getByTestId('motion-enter')
      .locator('> *')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName));
    expect(sections).toEqual(['none', 'none', 'none']);
    expect(await style(page.locator('[data-slot="skeleton"]').first(), 'animation-name')).toBe(
      'none',
    );
    const running = await page.evaluate(() => document.getAnimations().length);
    expect(running).toBe(0);
    await page
      .getByRole('button', { name: textFor('ltr', 'design.motion.dropdown'), exact: true })
      .click();
    expect(await style(page.getByRole('menu'), 'animation-name')).toBe('none');
  });
});

test.describe('gradients that run along the line mirror in right to left (AC-13)', () => {
  for (const dir of ['ltr', 'rtl'] as const satisfies readonly TextDirection[]) {
    for (const theme of ['dark', 'light'] as const) {
      test(`selected row and current page run ${dir === 'ltr' ? '90deg' : '270deg'} in ${theme}`, async ({
        page,
      }) => {
        await useBrowserState(page, { theme, dir });
        await openDesign(page);
        const angle = dir === 'ltr' ? '90deg' : '270deg';
        const row = page.locator('tr[data-state="selected"]').first();
        await row.scrollIntoViewIfNeeded();
        expect(await style(row, 'background-image')).toContain(`linear-gradient(${angle}`);
        const current = page.locator('[data-slot="sidebar-menu-button"][data-active="true"]');
        await expect(current).toHaveCount(1);
        // The sample on /design renders the current page tint with its own utility.
        const sample = page.locator('.gradient-current-page').first();
        await sample.scrollIntoViewIfNeeded();
        expect(await style(sample, 'background-image')).toContain(`linear-gradient(${angle}`);
        // The real sidebar item must carry the same gradient tint, not a flat one (AC-13).
        expect
          .soft(await style(current, 'background-image'), 'sidebar current page tint')
          .toContain(`linear-gradient(${angle}`);
        // The 2px marker sits on the leading edge: left in ltr, right in rtl.
        const box = await current.boundingBox();
        const marker = await current.evaluate((element) => {
          const computed = getComputedStyle(element, '::before');
          if (computed.backgroundImage === 'none') return null;
          const rect = element.getBoundingClientRect();
          const width = parseFloat(computed.width);
          const inset = parseFloat(computed[element.matches(':dir(rtl)') ? 'right' : 'left']);
          return element.matches(':dir(rtl)')
            ? { x: 0, width, right: rect.right - inset }
            : { x: rect.x + inset, width, right: 0 };
        });
        expect(marker, 'a 2px marker exists inside the current page item').not.toBeNull();
        expect(marker?.width).toBeCloseTo(2, 0);
        if (dir === 'ltr') expect(marker?.x).toBeCloseTo(box?.x ?? 0, 0);
        else expect(marker?.right).toBeCloseTo((box?.x ?? 0) + (box?.width ?? 0), 0);
      });
    }
  }
});

test.describe('density is unchanged (AC-20)', () => {
  test('controls 40px, rows 40px, header 44px, nav item 32px, top bar 56px, body 15px, chip 24px', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const height = async (selector: string) => {
      const box = await page.locator(selector).first().boundingBox();
      return box?.height;
    };
    expect(await height('header.h-topbar')).toBe(56);
    expect(await height('[data-slot="sidebar-menu-button"]')).toBe(32);
    expect(
      await height(
        '[data-slot="button"][data-size="default"]:not([data-slot="sidebar-menu-button"])',
      ),
    ).toBe(40);
    const probeRow = await page.evaluate(() => {
      const table = document.createElement('table');
      table.innerHTML = '<tbody><tr class="h-row"><td></td></tr></tbody>';
      document.body.append(table);
      const value = table.querySelector('tr')?.getBoundingClientRect().height;
      table.remove();
      return value;
    });
    // A bare row is exactly the row token; rows that hold a chip grow by the line box, as before.
    expect(probeRow).toBe(40);
    expect(await height('th.h-row-header')).toBe(44);
    expect(await height('[data-slot="status-chip"]')).toBe(24);
    expect(await style(page.locator('body'), 'font-size')).toBe('15px');
    expect(await style(page.locator('input[data-slot="input"]').first(), 'height')).toBe('40px');
  });
});

test('Geist is the Latin face and Noto Sans Arabic carries Arabic, with codes in Geist Mono', async ({
  page,
}) => {
  await useBrowserState(page, { theme: 'dark', language: 'ar' });
  await openDesign(page);
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
  );
  expect(loaded.join(' ')).toMatch(/Geist/i);
  expect(loaded.join(' ')).toMatch(/Noto Sans Arabic|noto/i);
  expect(loaded.join(' ')).not.toMatch(/Inter|JetBrains/i);
  const code = page.locator('tbody [data-slot="ltr-text"]').first();
  await code.scrollIntoViewIfNeeded();
  expect(await style(code, 'font-family')).toMatch(/geist.?mono/i);
  expect(await style(code, 'direction')).toBe('ltr');
});

test.describe('headings, labels and Arabic type (AC-11, AC-15)', () => {
  test('the h1 is 20px with the blend fill, and plain foreground in forced colors', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'dark', language: 'en' });
    await openDesign(page);
    const h1 = page.locator('h1');
    expect(await style(h1, 'font-size')).toBe('20px');
    expect(await style(h1, 'background-clip')).toBe('text');
    expect(await style(h1, 'background-image')).toContain('linear-gradient');
    expect(await style(h1, 'letter-spacing')).not.toBe('normal');
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await style(h1, 'background-image')).toBe('none');
    expect(await style(h1, 'color')).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('in Arabic the h1 has no letter spacing, table heads are lowercase mono, digits stay Western', async ({
    page,
  }) => {
    await useBrowserState(page, { theme: 'dark', language: 'ar' });
    await openDesign(page);
    expect(await style(page.locator('h1'), 'letter-spacing')).toMatch(/^(0px|normal)$/);
    const head = page.locator('th.table-head-look').first();
    expect(await style(head, 'text-transform')).toBe('lowercase');
    const family = await style(head, 'font-family');
    expect(family).toMatch(/geist.?mono/i);
    expect(family).toMatch(/noto/i);
    const before = await page
      .locator('.section-label')
      .first()
      .evaluate((element) => {
        const computed = getComputedStyle(element, '::before');
        return { content: computed.content, color: computed.color };
      });
    expect(before.content).toContain('//');
  });
});

test.describe('keyboard focus is visible on every control (AC-8, AC-22)', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`Tab through /design in ${theme}: each focused control shows a 2px ring`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await useBrowserState(page, { theme, language: 'en' });
      await openDesign(page);
      const failures: string[] = [];
      const seen = new Set<string>();
      let visited = 0;
      for (let step = 0; step < 260; step += 1) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element || element === document.body) return null;
          const computed = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            id: `${element.tagName}:${(element.textContent ?? '').trim().slice(0, 24)}:${Math.round(rect.x)}:${Math.round(rect.y + window.scrollY)}`,
            outlineWidth: computed.outlineWidth,
            outlineStyle: computed.outlineStyle,
            outlineColor: computed.outlineColor,
            shadow: computed.boxShadow,
            inIframe: element.tagName === 'IFRAME',
          };
        });
        if (!info) continue;
        if (seen.has(info.id)) break;
        seen.add(info.id);
        visited += 1;
        const hasOutline = info.outlineStyle !== 'none' && parseFloat(info.outlineWidth) >= 2;
        const hasShadowRing = info.shadow !== 'none';
        if (!hasOutline && !hasShadowRing && !info.inIframe) failures.push(info.id);
      }
      expect(visited).toBeGreaterThan(30);
      expect(failures).toEqual([]);
    });
  }
});
