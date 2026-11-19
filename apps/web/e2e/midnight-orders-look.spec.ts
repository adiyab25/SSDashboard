import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { createSku } from './master-data-api';
import {
  expectNoAxeViolations,
  openShell,
  seedLocations,
  textFor,
  useBrowserState as setBrowserState,
  waitForPageHydration,
} from './support';
import { COMBINATIONS, enterAs, shot } from './look-support';

// Spec 0025 milestone M3 (AC-8, AC-11, AC-21, AC-22): the orders list, the order page and the new
// order form in the Midnight look, measured in a real browser. Axe runs in dark and light, left to
// right and right to left, on all three screens including the edit and cancel dialogs. Set SHOT_DIR
// to also save screenshots. One manager, one SKU and one order are seeded for the file.

test.use({ storageState: { cookies: [], origins: [] } });

let manager: SeededAccount | undefined;
let orderPath = '';
let orderLabel = '';

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  manager = await seedAccount({ hats: ['manager'], language: 'en' });
  orderPath = await seedOrder(browser, baseURL ?? '', manager);
});

test.afterAll(async () => {
  const done = manager;
  manager = undefined;
  await done?.remove().catch(() => undefined);
});

/** Enters one order by hand as the manager and answers its page path; the order stays for the file. */
async function seedOrder(browser: Browser, baseURL: string, account: SeededAccount) {
  const context = await browser.newContext({ baseURL });
  try {
    await signInThroughApi(context, account, baseURL);
    const code = `MID-${randomUUID().slice(0, 8).toUpperCase()}`;
    await createSku(context.request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '250.00');
    const page = await context.newPage();
    await page.goto('/orders/new');
    await expect(page.locator('#order-store')).toBeVisible();
    await waitForPageHydration(page);
    const store = page.locator('#order-store');
    await store.selectOption(
      (await store.locator('option', { hasText: 'MAIN' }).getAttribute('value')) ?? '',
    );
    const channel = page.locator('#order-channel');
    await channel.selectOption(
      (await channel.locator('option', { hasText: 'Manual' }).first().getAttribute('value')) ?? '',
    );
    await page.locator('#order-name').fill('Mona E2E');
    await page
      .locator('#order-phone')
      .fill(`010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
    await page.locator('#order-address').fill('12 Nile Street, Cairo');
    await page.locator('#line-0-sku').click();
    await page.getByPlaceholder(textFor('ltr', 'inventory.receipt.searchSku')).fill(code);
    await page.getByRole('option', { name: new RegExp(code) }).click();
    await page.locator('#line-0-quantity').fill('1');
    await page.getByRole('button', { name: textFor('ltr', 'orders.new.submit') }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    const heading = page.getByRole('heading', { level: 1, name: /^MAIN\/SO-\d{4}-\d+$/ });
    await expect(heading).toBeVisible();
    orderLabel = (await heading.innerText()).trim();
    return new URL(page.url()).pathname;
  } finally {
    await context.close();
  }
}

async function openList(page: Page) {
  await page.goto('/orders');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await waitForPageHydration(page);
  await expect(page.getByRole('table').getByRole('link', { name: orderLabel })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function openOrder(page: Page) {
  await page.goto(orderPath);
  await expect(page.getByRole('heading', { level: 1, name: orderLabel })).toBeVisible();
  await waitForPageHydration(page);
  await page.evaluate(() => document.fonts.ready);
}

async function openNew(page: Page) {
  await page.goto('/orders/new');
  await expect(page.locator('#order-store')).toBeVisible();
  await waitForPageHydration(page);
  await page.evaluate(() => document.fonts.ready);
}

/** Every text field, native select and field-fill control on the page, with the fill it paints. */
async function fieldFills(page: Page, scope = 'body') {
  // A disabled control fades to its field fill; measure once no transition is running.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity &&
                animation.playState === 'running',
            ).length,
      ),
    )
    .toBe(0);
  return page.locator(scope).evaluate((root) => {
    const probe = (variable: string) => {
      const element = document.createElement('div');
      element.style.backgroundColor = `var(${variable})`;
      document.body.append(element);
      const color = getComputedStyle(element).backgroundColor;
      element.remove();
      return color;
    };
    const dark = document.documentElement.classList.contains('dark');
    const cardColor = probe('--card');
    const pageColor = probe('--background');
    const fields = [
      ...root.querySelectorAll<HTMLElement>(
        'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea, [class*="bg-field"], [role="combobox"]',
      ),
    ].filter((element) => element.getBoundingClientRect().width > 0);
    return {
      dark,
      cardColor,
      pageColor,
      fields: fields.map((element) => ({
        id:
          element.id || element.tagName.toLowerCase() + ':' + (element.getAttribute('name') ?? ''),
        fill: getComputedStyle(element).backgroundColor,
        onCard:
          element.closest(
            '[data-slot="card"], [data-slot="dialog-content"], .gradient-card-edge',
          ) !== null,
      })),
    };
  });
}

function expectFieldRule(result: Awaited<ReturnType<typeof fieldFills>>) {
  expect(result.fields.length).toBeGreaterThan(0);
  const wrong = result.fields
    .filter((field) => {
      const want = !result.dark && field.onCard ? result.cardColor : result.pageColor;
      return field.fill !== want;
    })
    .map((field) => `${field.id} painted ${field.fill}, onCard ${field.onCard}`);
  expect(wrong, `card ${result.cardColor}, page ${result.pageColor}, dark ${result.dark}`).toEqual(
    [],
  );
}

test.describe('axe on the three screens (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS) {
    test(`orders list, order page, both dialogs and new order: no axe violations in ${tag}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await enterAs(page, manager, { theme, dir });
      const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

      await openList(page);
      await expectNoAxeViolations(page);
      await shot(page, `orders-list-${tag}`);

      await openOrder(page);
      await expectNoAxeViolations(page);
      await shot(page, `order-page-${tag}`);

      const actions = page.getByRole('region', { name: t('orders.actions.label') });
      await actions.getByRole('button', { name: t('orders.actions.edit') }).click();
      const edit = page.getByRole('dialog');
      await expect(edit).toBeVisible();
      await expectNoAxeViolations(page);
      await shot(page, `order-edit-dialog-${tag}`);
      await page.keyboard.press('Escape');
      await expect(edit).toHaveCount(0);

      await actions.getByRole('button', { name: t('orders.actions.cancel') }).click();
      const cancel = page.getByRole('dialog');
      await expect(cancel).toBeVisible();
      await expectNoAxeViolations(page);
      await cancel.getByRole('button', { name: t('orders.cancel.confirm') }).click();
      await expect(cancel.getByText(t('orders.cancel.reasonRequired'))).toBeVisible();
      await expectNoAxeViolations(page);
      await shot(page, `order-cancel-dialog-${tag}`);

      await openNew(page);
      await expectNoAxeViolations(page);
      await shot(page, `order-new-${tag}`);
    });
  }
});

test.describe('the list look (AC-11, AC-13, AC-21)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  test('column order, chips per row, mono lowercase headers, hover tint, card edge, heading blend', async ({
    page,
  }) => {
    await enterAs(page, manager, { theme: 'dark', dir: 'ltr' });
    await openList(page);
    const table = page.getByRole('table', { name: textFor('ltr', 'orders.tableLabel') });

    // Column order: code, who, where, how much (total, due), state, cash.
    const headers = await table.getByRole('columnheader').allInnerTexts();
    expect(headers.map((text) => text.trim())).toEqual(
      (['number', 'who', 'channel', 'total', 'due', 'state', 'cash'] as const).map((id) =>
        textFor('ltr', `orders.columns.${id}`).toLowerCase(),
      ),
    );

    // Headers: mono, lowercase, normal weight.
    const head = await table
      .getByRole('columnheader')
      .first()
      .evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          font: computed.fontFamily.toLowerCase(),
          transform: computed.textTransform,
          weight: computed.fontWeight,
        };
      });
    expect(head.font).toContain('mono');
    expect(head.transform).toBe('lowercase');
    expect(head.weight).toBe('400');

    // At most three chips per row: fulfillment, cash, and the optional third; the flags under the
    // number are plain text, not chips.
    const chipCounts = await table
      .locator('tbody tr')
      .evaluateAll((rows) =>
        rows.map(
          (row) => row.querySelectorAll('[data-slot="status-chip"], [data-status-chip]').length,
        ),
      );
    console.log(`chips per row: ${JSON.stringify(chipCounts.slice(0, 10))}`);
    expect(chipCounts.every((count) => count <= 3)).toBe(true);

    // Row hover tint: the row paints something it did not before.
    const row = table.locator('tbody tr').first();
    const before = await row.evaluate((e) => {
      const c = getComputedStyle(e);
      return `${c.backgroundColor}|${c.backgroundImage}`;
    });
    await row.hover();
    await expect
      .poll(() =>
        row.evaluate((e) => {
          const c = getComputedStyle(e);
          return `${c.backgroundColor}|${c.backgroundImage}`;
        }),
      )
      .not.toBe(before);

    // One main action: New order is the only element with the blend in main.
    await expect(page.locator('main .gradient-primary')).toHaveCount(1);

    // Card edge on the table wrapper.
    const wrapper = page.locator('.gradient-card-edge', { has: table }).first();
    expect(await wrapper.evaluate((e) => getComputedStyle(e).borderRadius)).toBe('12px');

    // Heading blend on the h1.
    const h1 = page.getByRole('heading', { level: 1 });
    const blend = await h1.evaluate((e) => {
      const c = getComputedStyle(e);
      return { image: c.backgroundImage, clip: c.webkitBackgroundClip || c.backgroundClip };
    });
    expect(blend.image).toContain('linear-gradient');
    expect(blend.clip).toBe('text');
  });

  test('panels on the order page and new order form carry the card edge', async ({ page }) => {
    await enterAs(page, manager, { theme: 'dark', dir: 'ltr' });
    await openOrder(page);
    expect(await page.locator('dl.gradient-card-edge').count()).toBeGreaterThanOrEqual(1);
    await openNew(page);
    expect(await page.locator('main section.gradient-card-edge').count()).toBeGreaterThanOrEqual(4);
  });
});

test.describe('field colour (AC-8)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS.filter((c) => c.dir === 'ltr')) {
    test(`fields on the orders screens in ${tag}`, async ({ page }) => {
      await enterAs(page, manager, { theme, dir });
      await openList(page);
      expectFieldRule(await fieldFills(page, 'main'));
      await openNew(page);
      const form = await fieldFills(page, 'main');
      console.log(`new order ${tag}: ${JSON.stringify(form)}`);
      expectFieldRule(form);
      // The SKU picker of a line is a combobox trigger that looks like a field: it is measured too.
      expect(form.fields.some((field) => field.id === 'line-0-sku')).toBe(true);
      if (theme === 'light') {
        // On the cards of the form the fields are the card colour, not the page colour.
        expect(form.fields.some((field) => field.onCard && field.fill === form.cardColor)).toBe(
          true,
        );
        expect(form.cardColor).not.toBe(form.pageColor);
      }
      await openOrder(page);
      await page
        .getByRole('region', { name: textFor('ltr', 'orders.actions.label') })
        .getByRole('button', { name: textFor('ltr', 'orders.actions.edit') })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const dialog = await fieldFills(page, '[role="dialog"]');
      console.log(`edit dialog ${tag}: ${JSON.stringify(dialog)}`);
      expectFieldRule(dialog);
      if (theme === 'light') {
        expect(dialog.fields.every((field) => field.fill === dialog.cardColor)).toBe(true);
      } else {
        expect(dialog.fields.every((field) => field.fill === dialog.pageColor)).toBe(true);
      }
    });
  }

  test('the sign in card fields are the card colour in light and the page colour in dark', async ({
    page,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      await setBrowserState(page, { theme, dir: 'ltr' });
      const hydrated = page.waitForResponse((response) => response.url().endsWith('/api/config'));
      await page.goto('/sign-in');
      await hydrated;
      await page.evaluate(() => document.fonts.ready);
      const result = await fieldFills(page, 'main');
      console.log(`sign in ${theme}: ${JSON.stringify(result)}`);
      expectFieldRule(result);
      expect(result.fields.every((field) => field.onCard)).toBe(true);
      if (theme === 'light') {
        expect(result.fields.every((field) => field.fill === result.cardColor)).toBe(true);
      }
      if (theme === 'light') await shot(page, 'signin-light-en');
      await page.reload();
    }
  });

  test('a native select is as tall as an Input (40px control height)', async ({ page }) => {
    await enterAs(page, manager, { theme: 'dark', dir: 'ltr' });
    await openNew(page);
    const heights = await page.evaluate(() => {
      const height = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect().height;
      return {
        input: height('#order-name'),
        store: height('#order-store'),
        channel: height('#order-channel'),
      };
    });
    expect(heights).toEqual({ input: 40, store: 40, channel: 40 });
  });
});

test.describe('table rows after the global TableCell change (AC-20)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { dir, tag } of [
    { dir: 'ltr', tag: 'dark-en' },
    { dir: 'rtl', tag: 'dark-ar' },
  ] as const) {
    test(`orders list and order page rows are at least 40px in ${tag}`, async ({ page }) => {
      await enterAs(page, manager, { theme: 'dark', dir });
      // Only visible data rows: a hidden or empty row (display none, zero height) is not measured.
      const heightsOf = async () =>
        page.locator('main table tbody tr').evaluateAll((all) =>
          all
            .filter((row) => row.getClientRects().length > 0)
            .map((row) => Math.round(row.getBoundingClientRect().height * 100) / 100)
            .filter((height) => height > 0),
        );
      const hiddenRows = async () =>
        page
          .locator('main table tbody tr')
          .evaluateAll(
            (all) => all.filter((row) => row.getBoundingClientRect().height === 0).length,
          );
      await openList(page);
      const hiddenInList = await hiddenRows();
      const list = await heightsOf();
      await openOrder(page);
      console.log(
        `zero height rows ${tag}: list ${hiddenInList}, order page ${await hiddenRows()}`,
      );
      const order = await heightsOf();
      const summary = (values: number[]) => ({
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        at40: values.filter((value) => Math.abs(value - 40) <= 0.5).length,
        sample: values.slice(0, 8),
      });
      console.log(
        `orders rows ${tag}: list ${JSON.stringify(summary(list))}, order page ${JSON.stringify(summary(order))}`,
      );
      expect(list.length, 'the orders list has visible data rows').toBeGreaterThan(0);
      expect(order.length, 'the order page has visible table rows').toBeGreaterThan(0);
      for (const height of [...list, ...order]) expect(height).toBeGreaterThanOrEqual(39.5);
    });
  }
});

test.describe('keyboard focus and notices (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, tag } of [
    { theme: 'dark', tag: 'dark' },
    { theme: 'light', tag: 'light' },
  ] as const) {
    for (const screen of ['list', 'order', 'new'] as const) {
      test(`Tab through ${screen} in ${tag}: every control shows a ring and is at least 24px`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await enterAs(page, manager, { theme, dir: 'ltr' });
        if (screen === 'list') await openList(page);
        else if (screen === 'order') await openOrder(page);
        else await openNew(page);
        // Start from the page's own content, past the shell.
        await page
          .locator('main h1')
          .first()
          .evaluate((e) => (e as HTMLElement).focus());
        const failures: string[] = [];
        const seen = new Set<string>();
        for (let step = 0; step < 80; step += 1) {
          await page.keyboard.press('Tab');
          const found = await page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            if (!element || element === document.body || element.tagName === 'NEXTJS-PORTAL')
              return null;
            const computed = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              id: `${element.tagName}#${element.id}:${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 24)}:${Math.round(rect.x)}:${Math.round(rect.y)}`,
              inMain: element.closest('main') !== null,
              outline: computed.outlineStyle !== 'none' && parseFloat(computed.outlineWidth) >= 2,
              shadow: computed.boxShadow !== 'none',
              exempt:
                (element.tagName === 'A' && element.closest('p, dd, li, td, h1') !== null) ||
                (element instanceof HTMLInputElement &&
                  ['checkbox', 'radio'].includes(element.type)),
              width: rect.width,
              height: rect.height,
            };
          });
          if (!found) continue;
          if (seen.has(found.id)) break;
          seen.add(found.id);
          if (!found.inMain) continue;
          if (!found.outline && !found.shadow) failures.push(`no ring: ${found.id}`);
          if (!found.exempt && (found.width < 24 || found.height < 24)) {
            failures.push(
              `small ${Math.round(found.width)}x${Math.round(found.height)}: ${found.id}`,
            );
          }
        }
        console.log(`focus stops ${screen} ${tag}: ${seen.size}`);
        expect(seen.size).toBeGreaterThan(2);
        expect(failures).toEqual([]);
      });
    }
  }

  test('the in Shopify notice shows an i icon with muted text, not cyan', async ({ page }) => {
    await enterAs(page, manager, { theme: 'dark', dir: 'ltr' });
    await page.route('**/api/orders/*/edits', (route) =>
      route.fulfill({ status: 409, json: { code: 'EDIT_IN_SHOPIFY' } }),
    );
    await openOrder(page);
    const actions = page.getByRole('region', { name: textFor('ltr', 'orders.actions.label') });
    await actions.getByRole('button', { name: textFor('ltr', 'orders.actions.edit') }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel(textFor('ltr', 'orders.shipTo.address')).fill('14 Garden City, Cairo');
    await edit.getByRole('button', { name: textFor('ltr', 'orders.edit.save') }).click();
    await expect(edit).toHaveCount(0);
    const notice = actions.getByRole('alert').filter({
      hasText: textFor('ltr', 'orders.actions.editInShopify'),
    });
    await expect(notice).toBeVisible();
    const look = await notice.evaluate((element) => {
      const text = getComputedStyle(
        element.querySelector('[data-slot="alert-description"]')!,
      ).color;
      const svg = element.querySelector('svg');
      const probe = (variable: string) => {
        const el = document.createElement('div');
        el.style.color = `var(${variable})`;
        document.body.append(el);
        const color = getComputedStyle(el).color;
        el.remove();
        return color;
      };
      return {
        text,
        icon: svg ? getComputedStyle(svg).color : null,
        iconLabel: svg?.getAttribute('aria-hidden'),
        iconClass: svg?.getAttribute('class') ?? '',
        muted: probe('--muted-foreground'),
        primary: probe('--primary'),
        accent: probe('--brand-accent'),
      };
    });
    console.log(`notice look: ${JSON.stringify(look)}`);
    expect(look.icon).not.toBeNull();
    expect(look.iconClass).toContain('lucide-info');
    expect(look.iconLabel).toBe('true');
    expect(look.text).toBe(look.muted);
    expect(look.text).not.toBe(look.primary);
    expect(look.icon).not.toBe(look.primary);
    await expectNoAxeViolations(page);
    await shot(page, 'order-notice-dark-en');
  });
});

test.describe('phone (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'mobile')); // eslint-disable-line no-empty-pattern

  test('the orders list at 390px in dark Arabic scrolls inside its wrapper and passes axe', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await enterAs(page, manager, { theme: 'dark', dir: 'rtl' });
    await openList(page);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page);
    await shot(page, 'orders-list-mobile-dark-ar');
  });
});

test.describe('location switcher with long location codes (batch 1 note)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  test('the popover keeps a code on one line in Arabic', async ({ page }) => {
    const seeded = await seedLocations();
    try {
      await enterAs(page, manager, { theme: 'dark', dir: 'rtl' });
      await openShell(page, '/orders');
      await page.getByRole('button', { name: /^(Location|الموقع)/ }).click();
      await expect(
        page.locator('[data-slot="popover-content"] [role="option"]').first(),
      ).toBeVisible();
      const measured = await page
        .locator('[data-slot="popover-content"] [role="option"]')
        .evaluateAll((options) =>
          options.map((option) => {
            const rect = option.getBoundingClientRect();
            const lines = [...option.querySelectorAll('*')]
              .filter(
                (child) => child.children.length === 0 && (child.textContent ?? '').trim() !== '',
              )
              .map((child) => ({
                text: (child.textContent ?? '').trim(),
                height: Math.round(child.getBoundingClientRect().height),
                clipped: child.scrollWidth > child.clientWidth,
              }));
            return { width: Math.round(rect.width), lines };
          }),
        );
      console.log(`location options (first 3): ${JSON.stringify(measured.slice(0, 3))}`);
      await shot(page, 'location-switcher-dark-ar');
      const codes = measured
        .flatMap((option) => option.lines)
        .filter((line) => line.text.startsWith('E2E-'));
      expect(codes.length).toBeGreaterThan(0);
      // A code is one line of text (about 16px at 12px type), never wrapped over several.
      for (const code of codes) expect(code.height, code.text).toBeLessThanOrEqual(24);
    } finally {
      await seeded.remove();
    }
  });
});
