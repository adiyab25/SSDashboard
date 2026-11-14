import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { STORAGE_STATE } from './auth';
import { api, createLocation, createSku, receive } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState as setBrowserState,
  type TextDirection,
  type Theme,
} from './support';

// Spec 0025 milestone M4 (AC-8, AC-10, AC-11, AC-13, AC-20, AC-21, AC-22): the stock screens and the
// product catalogue in the Midnight look, measured in a real browser as the e2e admin. One location
// with stock, one empty location, one SKU, one receipt, one season and one costed style are seeded
// for the file. Every screen and its main dialogs get axe in dark and light, English and Arabic.
// Set SHOT_DIR to also save screenshots.

const SHOT_DIR = process.env.SHOT_DIR;

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

const COMBINATIONS = [
  { theme: 'dark', dir: 'ltr', tag: 'dark-en' },
  { theme: 'dark', dir: 'rtl', tag: 'dark-ar' },
  { theme: 'light', dir: 'ltr', tag: 'light-en' },
  { theme: 'light', dir: 'rtl', tag: 'light-ar' },
] as const satisfies readonly { theme: Theme; dir: TextDirection; tag: string }[];

type Translate = (key: Parameters<typeof textFor>[1]) => string;

interface Seed {
  tag: string;
  location: { id: string; code: string };
  emptyLocation: { id: string; code: string };
  sku: { id: string; code: string };
  receipt: { id: string; number: string };
  style: { id: string; code: string };
}

let seed: Seed | undefined;

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(90_000);
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const request = await playwright.request.newContext({
    baseURL: baseURL ?? origin,
    storageState: STORAGE_STATE,
    extraHTTPHeaders: { origin },
  });
  try {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const location = await createLocation(request, `ML-${tag}`, {
      en: `Midnight ${tag}`,
      ar: `منتصف الليل ${tag}`,
    });
    const emptyLocation = await createLocation(request, `ME-${tag}`, {
      en: `Midnight empty ${tag}`,
      ar: `فارغ ${tag}`,
    });
    const season = await api(request, 'POST', '/seasons', {
      code: `MS${tag}`,
      name: { en: `Season ${tag}`, ar: `موسم ${tag}` },
    });
    expect(season.status, JSON.stringify(season.body)).toBe(201);
    const styleCode = `MST-${tag}`;
    const created = await api(request, 'POST', '/products', {
      name: { en: `Midnight tee ${tag}`, ar: `قميص ${tag}` },
      styleCode,
      variants: [{ sku: `${styleCode}-1`, price: '250.00' }],
      seasonId: season.body.id as string,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const styleId = created.body.productId as string;
    const variantId = created.body.id as string;
    const cost = await api(request, 'POST', `/styles/${styleId}/cost-records`, {
      seasonId: season.body.id as string,
      unitCost: '100',
      effectiveFrom: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
      costBasis: 'factory_invoice',
      reason: 'e2e setup',
    });
    expect(cost.status, JSON.stringify(cost.body)).toBe(201);
    const receipt = await receive(request, location.id, variantId, 10, '12.5000');
    // A second plain SKU so /skus and /stock have more than one row of our own.
    await createSku(request, `MSK-${tag}`, { en: `Plain ${tag}`, ar: `بسيط ${tag}` }, '90.00');
    seed = {
      tag,
      location: { id: location.id, code: location.code },
      emptyLocation: { id: emptyLocation.id, code: emptyLocation.code },
      sku: { id: variantId, code: `${styleCode}-1` },
      receipt,
      style: { id: styleId, code: styleCode },
    };
  } finally {
    await request.dispose();
  }
});

function seeded(): Seed {
  if (!seed) throw new Error('no seed');
  return seed;
}

async function enter(page: Page, state: { theme: Theme; dir: TextDirection }) {
  await setBrowserState(page, state);
}

/** Opens a path and waits until the page shows its h1, has no busy table or skeleton, and fonts are in. */
async function openPath(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n'));
  await expect(page.locator('main [aria-busy="true"], main [data-slot="skeleton"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

/** Clicks a trigger until its dialog shows (a click before hydration goes nowhere). */
async function openDialogBy(page: Page, trigger: Locator, prepare?: () => Promise<void>) {
  await expect(trigger.first()).toBeVisible();
  await expect(async () => {
    if (prepare) await prepare();
    if (!(await page.getByRole('dialog').isVisible())) await trigger.first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole('dialog').locator('[data-slot="skeleton"]')).toHaveCount(0);
}

/** The label of a templated string before its `{{code}}` placeholder. */
function before(dir: TextDirection, key: Parameters<typeof textFor>[1]) {
  return textFor(dir, key).split('{{')[0]!.trim();
}

interface Dialog {
  tag: string;
  /** Opens the dialog, or answers false when the trigger is not on the page (an optional dialog). */
  open: (page: Page, dir: TextDirection, t: Translate) => Promise<boolean>;
}

interface Screen {
  tag: string;
  path: () => string;
  dialogs: Dialog[];
}

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

const newThing: Dialog = {
  tag: 'new',
  open: async (page) => {
    await openDialogBy(page, page.locator('main [data-slot="button"][data-variant="default"]'));
    return true;
  },
};

const SCREENS: Screen[] = [
  {
    tag: 'stock',
    path: () => '/stock',
    dialogs: [
      {
        tag: 'new-sku',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('inventory.stock.newSku')));
          return true;
        },
      },
      {
        tag: 'new-location',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('inventory.stock.newLocation')));
          return true;
        },
      },
    ],
  },
  { tag: 'receipts', path: () => '/stock-receipts', dialogs: [] },
  { tag: 'receipt-new', path: () => '/stock-receipts/new', dialogs: [] },
  {
    tag: 'receipt',
    path: () => `/stock-receipts/${seeded().receipt.id}`,
    dialogs: [
      {
        tag: 'void',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('inventory.void.open')));
          return true;
        },
      },
    ],
  },
  {
    tag: 'skus',
    path: () => '/skus',
    dialogs: [
      {
        tag: 'new',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('inventory.skus.newSku')));
          return true;
        },
      },
      {
        tag: 'edit',
        open: async (page, dir) => {
          await openDialogBy(
            page,
            page.getByRole('table').getByRole('button', {
              name: new RegExp(`^${before(dir, 'inventory.skus.editLabel')}`),
            }),
          );
          return true;
        },
      },
    ],
  },
  {
    tag: 'sku',
    path: () => `/skus/${seeded().sku.id}`,
    dialogs: [
      {
        tag: 'edit',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('inventory.skuDetail.edit')));
          return true;
        },
      },
    ],
  },
  {
    tag: 'styles',
    path: () => '/styles',
    dialogs: [
      {
        tag: 'assign-season',
        open: async (page, _dir, t) => {
          const box = page.getByRole('table').getByRole('checkbox').first();
          await expect(box).toBeVisible();
          await openDialogBy(page, button(page, t('catalog.styles.setSeason')), async () => {
            if (!(await box.isChecked())) await box.check();
          });
          return true;
        },
      },
    ],
  },
  {
    tag: 'style',
    path: () => `/styles/${seeded().style.id}`,
    dialogs: [
      {
        tag: 'edit',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('catalog.style.edit')));
          return true;
        },
      },
      {
        tag: 'record-cost',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('catalog.style.recordCost')));
          return true;
        },
      },
      {
        tag: 'add-variant',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('catalog.style.addVariant')));
          return true;
        },
      },
    ],
  },
  { tag: 'product-groups', path: () => '/product-groups', dialogs: [newThing] },
  { tag: 'seasons', path: () => '/seasons', dialogs: [newThing] },
  {
    tag: 'locations',
    path: () => '/locations',
    dialogs: [
      {
        tag: 'new',
        open: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('inventory.locations.newLocation')));
          return true;
        },
      },
      {
        tag: 'edit',
        open: async (page, dir) => {
          await openDialogBy(
            page,
            page.getByRole('button', {
              name: new RegExp(`^${before(dir, 'inventory.locations.editLabel')}`),
            }),
          );
          return true;
        },
      },
      {
        tag: 'online-gate',
        open: async (page, dir) => {
          const trigger = page.getByRole('button', {
            name: new RegExp(`^${before(dir, 'inventory.onlineGate.openLabel')}`),
          });
          if ((await trigger.count()) === 0) return false;
          await openDialogBy(page, trigger);
          return true;
        },
      },
    ],
  },
];

/**
 * Visits a screen, calls `onView` on the page and again on each of its dialogs, and answers the
 * failures it collected, so one broken dialog does not hide the rest.
 */
async function walk(
  page: Page,
  screen: Screen,
  dir: TextDirection,
  onView: (view: { name: string; scope: string; dialog: boolean }) => Promise<void>,
): Promise<string[]> {
  const t: Translate = (key) => textFor(dir, key);
  const failures: string[] = [];
  const attempt = async (name: string, scope: string, dialog: boolean) => {
    try {
      await onView({ name, scope, dialog });
    } catch (error) {
      failures.push(
        `${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 700)}`,
      );
    }
  };
  await openPath(page, screen.path());
  await attempt(screen.tag, 'main', false);
  for (const dialog of screen.dialogs) {
    const name = `${screen.tag}-${dialog.tag}`;
    try {
      if (!(await dialog.open(page, dir, t))) {
        console.log(`${name}: trigger absent, skipped`);
        continue;
      }
    } catch (error) {
      failures.push(
        `${name}: could not open: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      );
      await openPath(page, screen.path());
      continue;
    }
    await attempt(name, '[role="dialog"]', true);
    await page.keyboard.press('Escape');
    if (!(await page.getByRole('dialog').isHidden())) await openPath(page, screen.path());
  }
  return failures;
}

/** Every text field, native select, combobox button and field-fill control in a scope, with fill and height. */
async function measureFields(page: Page, scope: string) {
  return page
    .locator(scope)
    .first()
    .evaluate((root) => {
      const probe = (variable: string) => {
        const element = document.createElement('div');
        element.style.backgroundColor = `var(${variable})`;
        document.body.append(element);
        const color = getComputedStyle(element).backgroundColor;
        element.remove();
        return color;
      };
      const dark = document.documentElement.classList.contains('dark');
      const visible = (element: Element) => element.getBoundingClientRect().width > 0;
      const idOf = (element: Element) =>
        element.id || element.tagName.toLowerCase() + ':' + (element.getAttribute('name') ?? '');
      const fields = [
        ...root.querySelectorAll<HTMLElement>(
          'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), select, textarea, [class*="bg-field"]',
        ),
      ].filter(visible);
      const heightOf = (selector: string) =>
        [...root.querySelectorAll<HTMLElement>(selector)].filter(visible).map((element) => ({
          id: idOf(element),
          height: element.offsetHeight,
        }));
      return {
        dark,
        cardColor: probe('--card'),
        pageColor: probe('--background'),
        fields: fields.map((element) => ({
          id: idOf(element),
          fill: getComputedStyle(element).backgroundColor,
          onCard:
            element.closest(
              '[data-slot="card"], [data-slot="dialog-content"], .gradient-card-edge',
            ) !== null,
        })),
        selects: heightOf('select'),
        inputs: heightOf(
          'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file])',
        ),
        combos: heightOf('button[role="combobox"]'),
      };
    });
}

test.describe('axe on every screen and main dialog (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS) {
    for (const screen of SCREENS) {
      test(`${screen.tag} and its dialogs: no axe violations in ${tag}`, async ({ page }) => {
        test.setTimeout(150_000);
        await enter(page, { theme, dir });
        const failures = await walk(page, screen, dir, async ({ name }) => {
          await expect(page.locator('h1')).toHaveCount(1);
          await expectNoAxeViolations(page);
          await shot(page, `${name}-${tag}`);
        });
        expect(failures).toEqual([]);
      });
    }
  }
});

test.describe('the table and panel look (AC-11, AC-13)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  const TABLE_SCREENS = [
    'stock',
    'receipts',
    'receipt',
    'skus',
    'sku',
    'styles',
    'style',
    'product-groups',
    'seasons',
    'locations',
  ];

  for (const name of TABLE_SCREENS) {
    test(`${name}: lowercase mono headers, card edge with 12px corners, h1 blend, hover tint`, async ({
      page,
    }) => {
      const screen = SCREENS.find((entry) => entry.tag === name)!;
      await enter(page, { theme: 'dark', dir: 'ltr' });
      await openPath(page, screen.path());
      const tables = page.locator('main table');
      expect(await tables.count()).toBeGreaterThan(0);
      const looks = await tables.evaluateAll((all) =>
        all.map((table) => {
          const heads = [...table.querySelectorAll('thead th')].map((th) => {
            const computed = getComputedStyle(th);
            return {
              text: (th.textContent ?? '').trim(),
              mono: computed.fontFamily.toLowerCase().includes('mono'),
              transform: computed.textTransform,
              weight: computed.fontWeight,
            };
          });
          const panel = table.closest('[class*="gradient-card-edge"]');
          return {
            heads,
            panel: panel !== null,
            radius: panel ? getComputedStyle(panel).borderRadius : null,
          };
        }),
      );
      console.log(
        `${name} tables: ${JSON.stringify(looks.map((l) => ({ ...l, heads: l.heads.length })))}`,
      );
      for (const look of looks) {
        expect(look.panel, 'table sits in a gradient-card-edge panel').toBe(true);
        expect(look.radius).toBe('12px');
        expect(look.heads.length).toBeGreaterThan(0);
        for (const head of look.heads) {
          expect(head.mono, `${head.text} is mono`).toBe(true);
          expect(head.transform, `${head.text} is lowercase`).toBe('lowercase');
          expect(head.weight, `${head.text} weight`).toBe('400');
        }
      }
      const blend = await page
        .getByRole('heading', { level: 1 })
        .first()
        .evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            image: computed.backgroundImage,
            clip: computed.webkitBackgroundClip || computed.backgroundClip,
          };
        });
      expect(blend.image).toContain('linear-gradient');
      expect(blend.clip).toBe('text');

      const row = page.locator('main table tbody tr').first();
      if ((await row.count()) > 0) {
        const paint = (target: Locator) =>
          target.evaluate((element) => {
            const computed = getComputedStyle(element);
            return `${computed.backgroundColor}|${computed.backgroundImage}`;
          });
        const rest = await paint(row);
        await row.hover();
        await expect.poll(() => paint(row)).not.toBe(rest);
      }
    });
  }

  test('the empty stock state is a card panel and its action is secondary, the header keeps the one main action', async ({
    page,
  }) => {
    await enter(page, { theme: 'dark', dir: 'ltr' });
    // An install with no stock at all: the one case that shows the "receive stock" action.
    await page.route(/\/api\/stock(\?|$)/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: [], nextCursor: null } })
        : route.fallback(),
    );
    await page.goto('/stock');
    await expect(page.getByText(textFor('ltr', 'inventory.stock.emptyTitle'))).toBeVisible();
    const panel = await page
      .locator('main table tbody tr')
      .first()
      .evaluate((element) => element.closest('[class*="gradient-card-edge"]') !== null);
    expect(panel).toBe(true);
    const inTable = page.locator('main table [data-slot="button"]');
    expect(await inTable.count()).toBeGreaterThan(0);
    for (const variant of await inTable.evaluateAll((all) =>
      all.map((el) => el.getAttribute('data-variant')),
    )) {
      expect(variant).toBe('secondary');
    }
    await expect(page.locator('main [data-slot="button"][data-variant="default"]')).toHaveCount(1);
    await expect(page.locator('main .gradient-primary')).toHaveCount(1);
    await expectNoAxeViolations(page);
    await shot(page, 'stock-empty-dark-en');
  });

  test('every table panel and form section on the receipt form carries the card edge', async ({
    page,
  }) => {
    await enter(page, { theme: 'dark', dir: 'ltr' });
    await openPath(page, '/stock-receipts/new');
    expect(await page.locator('main section.gradient-card-edge').count()).toBeGreaterThanOrEqual(2);
  });
});

test.describe('one main action per view (AC-13 and the design rule)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  // How many default variant (gradient) buttons the page body should hold: the one place to go next.
  const EXPECTED: Record<string, number> = {
    stock: 1,
    receipts: 1,
    'receipt-new': 1,
    receipt: 1,
    skus: 1,
    sku: 1,
    styles: 0,
    style: 1,
    'product-groups': 1,
    seasons: 1,
    locations: 1,
  };
  for (const screen of SCREENS) {
    test(`${screen.tag} has ${EXPECTED[screen.tag]} main action in main`, async ({ page }) => {
      await enter(page, { theme: 'dark', dir: 'ltr' });
      await openPath(page, screen.path());
      const count = await page.locator('main [data-slot="button"][data-variant="default"]').count();
      const blends = await page.locator('main .gradient-primary').count();
      console.log(`${screen.tag}: default buttons ${count}, gradient-primary ${blends}`);
      expect(count).toBeLessThanOrEqual(1);
      expect(blends).toBe(count);
      expect(count).toBe(EXPECTED[screen.tag]);
    });
  }
});

test.describe('field colour (AC-8) and control height (AC-20)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS.filter((c) => c.dir === 'ltr')) {
    for (const screen of SCREENS) {
      test(`fields on ${screen.tag} and its dialogs in ${tag}`, async ({ page }) => {
        test.setTimeout(150_000);
        await enter(page, { theme, dir });
        const failures = await walk(page, screen, dir, async ({ name, scope, dialog }) => {
          const result = await measureFields(page, scope);
          console.log(
            `${name} ${tag}: fields ${result.fields.length}, selects ${JSON.stringify(result.selects)}, inputs ${JSON.stringify(result.inputs)}, combos ${JSON.stringify(result.combos)}`,
          );
          const wrong = result.fields
            .filter((field) => {
              const want = !result.dark && field.onCard ? result.cardColor : result.pageColor;
              return field.fill !== want;
            })
            .map((field) => `${field.id} painted ${field.fill}, onCard ${field.onCard}`);
          expect(wrong, `card ${result.cardColor}, page ${result.pageColor}`).toEqual([]);
          if (dialog && theme === 'light') {
            // On a dialog in light every field is the card colour.
            expect(result.fields.every((field) => field.fill === result.cardColor)).toBe(true);
          }
          const off = [...result.selects, ...result.inputs, ...result.combos]
            .filter((control) => control.height !== 40)
            .map((control) => `${control.id} is ${control.height}px`);
          expect(off, 'every select, input and combobox is 40px').toEqual([]);
        });
        expect(failures).toEqual([]);
      });
    }
  }

  test('the receipt form location select is as tall as its inputs, 40px', async ({ page }) => {
    await enter(page, { theme: 'dark', dir: 'ltr' });
    await openPath(page, '/stock-receipts/new');
    const heights = await page.evaluate(() => {
      const height = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect().height;
      return {
        select: height('#receipt-location'),
        input: height('main input[type="text"], main input:not([type])'),
      };
    });
    console.log(`receipt form heights: ${JSON.stringify(heights)}`);
    expect(heights.select).toBe(40);
    expect(heights.input).toBe(40);
  });
});

const PLAIN_ROWS = new Set(['stock', 'receipts', 'receipt']);

test.describe('density (AC-20)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const name of ['stock', 'receipts', 'skus', 'locations', 'receipt', 'styles', 'seasons']) {
    test(`${name}: header 44px, rows 40px, buttons and fields 40px`, async ({ page }) => {
      const screen = SCREENS.find((entry) => entry.tag === name)!;
      await enter(page, { theme: 'dark', dir: 'ltr' });
      await openPath(page, screen.path());
      const sizes = await page
        .locator('main table')
        .first()
        .evaluate((table) => {
          const heights = (elements: Element[]) =>
            elements.map(
              (element) => Math.round(element.getBoundingClientRect().height * 100) / 100,
            );
          const rows = [...table.querySelectorAll('tbody tr')];
          return {
            head: heights([...table.querySelectorAll('thead th')]),
            plain: heights(
              rows.filter((row) => row.querySelector('button, [data-slot="button"]') === null),
            ),
            withControls: heights(
              rows.filter((row) => row.querySelector('button, [data-slot="button"]') !== null),
            ),
          };
        });
      console.log(
        `${name} density: ${JSON.stringify({ head: sizes.head.slice(0, 3), plain: sizes.plain.slice(0, 6), withControls: sizes.withControls.slice(0, 6) })}`,
      );
      expect(sizes.head.length).toBeGreaterThan(0);
      for (const head of sizes.head) expect(head).toBe(44);
      // A row with a text link and plain text is the 40px row; one holding a button may be taller
      // (the row grows around the 32px small button and its padding), but never shorter than 40.
      if (PLAIN_ROWS.has(name)) {
        expect(sizes.plain.length).toBeGreaterThan(0);
        expect(Math.min(...sizes.plain)).toBe(40);
      }
      for (const row of [...sizes.plain, ...sizes.withControls])
        expect(row).toBeGreaterThanOrEqual(40);
    });
  }

  test('the main action is a 40px control', async ({ page }) => {
    await enter(page, { theme: 'dark', dir: 'ltr' });
    await openPath(page, '/skus');
    const height = await page
      .locator('main [data-slot="button"][data-variant="default"]')
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBe(40);
  });
});

test.describe('keyboard focus and target size (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const theme of ['dark', 'light'] as const) {
    test(`Tab through every screen in ${theme}: every control shows a ring and is at least 24px`, async ({
      page,
    }) => {
      test.setTimeout(280_000);
      await enter(page, { theme, dir: 'ltr' });
      const failures: string[] = [];
      for (const screen of SCREENS) {
        await openPath(page, screen.path());
        await page
          .locator('main h1')
          .first()
          .evaluate((element) => (element as HTMLElement).focus());
        const seen = new Set<string>();
        for (let step = 0; step < 90; step += 1) {
          await page.keyboard.press('Tab');
          const found = await page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            if (!element || element === document.body || element.tagName === 'NEXTJS-PORTAL') {
              return null;
            }
            const computed = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              id: `${element.tagName}#${element.id}:${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 24)}:${Math.round(rect.x)}:${Math.round(rect.y)}`,
              inMain: element.closest('main') !== null,
              outline: computed.outlineStyle !== 'none' && parseFloat(computed.outlineWidth) >= 2,
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
          if (!found.outline) failures.push(`${screen.tag} no ring: ${found.id}`);
          if (!found.exempt && (found.width < 24 || found.height < 24)) {
            failures.push(
              `${screen.tag} small ${Math.round(found.width)}x${Math.round(found.height)}: ${found.id}`,
            );
          }
        }
        console.log(`focus stops ${screen.tag} ${theme}: ${seen.size}`);
        if (seen.size <= 2) failures.push(`${screen.tag}: only ${seen.size} focus stops`);
      }
      expect(failures).toEqual([]);
    });
  }
});

test.describe('codes and money read left to right in Arabic (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  test('SKU, location, style and receipt codes are LTR isolates on their screens', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await enter(page, { theme: 'dark', dir: 'rtl' });
    const s = seeded();
    const checks: { path: string; codes: string[] }[] = [
      { path: '/skus', codes: [s.sku.code] },
      { path: `/skus/${s.sku.id}`, codes: [s.sku.code] },
      { path: '/styles', codes: [s.style.code] },
      { path: `/styles/${s.style.id}`, codes: [s.style.code, s.sku.code] },
      { path: '/locations', codes: [s.location.code] },
      { path: '/stock-receipts', codes: [s.receipt.number] },
      { path: `/stock-receipts/${s.receipt.id}`, codes: [s.receipt.number, s.sku.code] },
    ];
    const failures: string[] = [];
    for (const { path, codes } of checks) {
      await openPath(page, path);
      // Every code isolate in a table cell, whichever rows are on the first page of a shared database.
      const isolates = await page
        .locator('main table td [data-slot="ltr-text"]')
        .evaluateAll((all) =>
          all.map((element) => ({
            text: (element.textContent ?? '').trim(),
            direction: getComputedStyle(element).direction,
            mono: getComputedStyle(element).fontFamily.toLowerCase().includes('mono'),
          })),
        );
      console.log(`${path}: ${isolates.length} code isolates in cells`);
      if (isolates.length === 0) failures.push(`${path}: no code isolate in any cell`);
      for (const isolate of isolates) {
        if (isolate.direction !== 'ltr' || !isolate.mono) {
          failures.push(`${path} ${isolate.text}: ${JSON.stringify(isolate)}`);
        }
      }
      for (const code of codes) {
        const cell = page.locator('main').getByText(code, { exact: true }).first();
        if ((await cell.count()) === 0) {
          console.log(`${path}: ${code} not on the first page, covered by the isolate check`);
          continue;
        }
        const result = await cell.evaluate((element) => ({
          direction: getComputedStyle(element).direction,
          isolate: element.closest('[data-slot="ltr-text"], [dir="ltr"]') !== null,
        }));
        if (result.direction !== 'ltr' || !result.isolate) {
          failures.push(`${path} ${code}: ${JSON.stringify(result)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('money on the stock list and the receipt page uses Western digits laid out left to right', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await enter(page, { theme: 'dark', dir: 'rtl' });
    const s = seeded();
    const failures: string[] = [];
    for (const path of ['/stock', `/stock-receipts/${s.receipt.id}`, `/styles/${s.style.id}`]) {
      await openPath(page, path);
      const found = await page.locator('main table tbody td').evaluateAll((cells) => {
        const out: { text: string; arabicDigits: boolean; leftToRight: boolean }[] = [];
        for (const cell of cells) {
          const text = (cell.textContent ?? '').trim();
          const match = /\d[\d,]*\.\d{2,4}/.exec(text);
          if (!match) continue;
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          let leftToRight = false;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const value = node.textContent ?? '';
            const index = value.indexOf(match[0]);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const first = range.getBoundingClientRect();
            range.setStart(node, index + match[0].length - 1);
            range.setEnd(node, index + match[0].length);
            const last = range.getBoundingClientRect();
            leftToRight = first.left < last.left;
            break;
          }
          out.push({ text, arabicDigits: /[٠-٩]/.test(text), leftToRight });
          if (out.length >= 6) break;
        }
        return out;
      });
      console.log(`${path} money cells: ${JSON.stringify(found)}`);
      if (found.length === 0) failures.push(`${path}: no money cell found`);
      for (const item of found) {
        if (item.arabicDigits || !item.leftToRight)
          failures.push(`${path}: ${JSON.stringify(item)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

test.describe('status chips are never cyan (AC-10)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const theme of ['dark', 'light'] as const) {
    test(`badges on the stock and catalogue screens in ${theme} use no primary colour`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await enter(page, { theme, dir: 'ltr' });
      const failures: string[] = [];
      let total = 0;
      for (const screen of SCREENS) {
        await openPath(page, screen.path());
        const result = await page.evaluate(() => {
          const probe = (variable: string) => {
            const element = document.createElement('div');
            element.style.color = `var(${variable})`;
            document.body.append(element);
            const color = getComputedStyle(element).color;
            element.remove();
            return color;
          };
          const cyan = new Set([probe('--primary'), probe('--ring')]);
          const badges = [...document.querySelectorAll('main [data-slot="badge"]')];
          return {
            count: badges.length,
            bad: badges
              .map((badge) => {
                const computed = getComputedStyle(badge);
                return {
                  text: (badge.textContent ?? '').trim(),
                  color: computed.color,
                  background: computed.backgroundColor,
                  border: computed.borderTopColor,
                  gradient: badge.classList.contains('gradient-primary'),
                };
              })
              .filter(
                (badge) =>
                  cyan.has(badge.color) ||
                  cyan.has(badge.background) ||
                  cyan.has(badge.border) ||
                  badge.gradient,
              ),
          };
        });
        total += result.count;
        if (result.bad.length > 0) failures.push(`${screen.tag}: ${JSON.stringify(result.bad)}`);
      }
      console.log(`badges checked in ${theme}: ${total}`);
      expect(total).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    });
  }

  test('the online status notice keeps its triangle icon and is never cyan', async ({ page }) => {
    await enter(page, { theme: 'dark', dir: 'ltr' });
    await openPath(page, '/stock');
    const notice = page.getByRole('region', {
      name: textFor('ltr', 'inventory.onlineGate.noticeLabel'),
    });
    // The notice only shows while no location is online; a database with one online skips this.
    const shown = await notice.waitFor({ state: 'visible', timeout: 5000 }).then(
      () => true,
      () => false,
    );
    test.skip(!shown, 'an online location exists on this database, so the notice is not shown');
    const look = await notice.evaluate((element) => {
      const probe = (variable: string) => {
        const el = document.createElement('div');
        el.style.color = `var(${variable})`;
        document.body.append(el);
        const color = getComputedStyle(el).color;
        el.remove();
        return color;
      };
      const svg = element.querySelector('svg');
      return {
        text: getComputedStyle(element.querySelector('[data-slot="alert-description"]')!).color,
        icon: svg ? getComputedStyle(svg).color : null,
        iconClass: svg?.getAttribute('class') ?? '',
        iconHidden: svg?.getAttribute('aria-hidden'),
        muted: probe('--muted-foreground'),
        primary: probe('--primary'),
      };
    });
    console.log(`online notice look: ${JSON.stringify(look)}`);
    expect(look.iconClass).toContain('lucide-triangle-alert');
    expect(look.iconHidden).toBe('true');
    expect(look.text).not.toBe(look.primary);
    expect(look.icon).not.toBe(look.primary);
    await expectNoAxeViolations(page);
    await shot(page, 'stock-notice-dark-en');
  });
});

test.describe('phone (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'mobile')); // eslint-disable-line no-empty-pattern

  for (const path of ['/stock', '/skus']) {
    test(`${path} at 390px in dark Arabic has no sideways page scroll and passes axe`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 780 });
      await enter(page, { theme: 'dark', dir: 'rtl' });
      await openPath(page, path);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways).toBeLessThanOrEqual(0);
      await expectNoAxeViolations(page);
      await shot(page, `${path.slice(1)}-mobile-dark-ar`);
    });
  }
});
