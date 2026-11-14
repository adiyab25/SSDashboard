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
  // The stock SKU filter starts disabled until the access check answers and then fades to its field
  // fill; measure what is painted once it is enabled and no transition is still running.
  const filter = page.locator('#stock-sku-filter');
  if ((await filter.count()) > 0) await expect(filter).toBeEnabled();
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
          'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), select, textarea, [class*="bg-field"], [role="combobox"]',
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
          // The pickers are comboboxes that look like fields; they must be among the fields measured.
          if (name === 'receipt-new' || name === 'stock') {
            expect(result.combos.length, `${name} has a combobox trigger`).toBeGreaterThan(0);
          }
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

test.describe('every table row is 40px (AC-20, owner ruling 2026-11-14)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  const ROW_SCREENS = [
    'stock',
    'receipts',
    'receipt',
    'locations',
    'skus',
    'styles',
    'seasons',
    'product-groups',
    // Two tables each: the style page SKUs and its cost history, the SKU page stock and history.
    'style',
    'sku',
  ];
  // Only these two lists may show a row with a protected or in use note (an owner question).
  const NOTE_ALLOWED = new Set(['seasons', 'product-groups']);
  // The style page SKU row whose cost cell shows its second line ("from <date> · from the style")
  // may grow too (owner ruling 2026-11-14, spec 0025 decision 14), up to TWO_LINE_MAX.
  const TWO_LINE_ALLOWED = new Set(['style']);
  const TWO_LINE_MAX = 64;
  for (const { theme, dir, tag } of COMBINATIONS) {
    for (const name of ROW_SCREENS) {
      test(`${name} rows are 40px in ${tag}`, async ({ page }) => {
        const screen = SCREENS.find((entry) => entry.tag === name)!;
        await enter(page, { theme, dir });
        await openPath(page, screen.path());
        const rows = await page.locator('main table tbody tr').evaluateAll((all) =>
          all.map((row) => {
            const last = row.lastElementChild;
            const controls = [...(last?.querySelectorAll('button, a') ?? [])];
            const controlText = controls.map((element) => element.textContent ?? '').join('');
            const lastText = (last?.textContent ?? '').replace(/\s/g, '');
            return {
              text: (row.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50),
              height: row.getBoundingClientRect().height,
              // A note is text in the last cell next to its buttons (the protected or in use line).
              hasNote:
                controls.length > 0 && lastText.length > controlText.replace(/\s/g, '').length,
              // A cell whose content is a column of two lines (the cost and its origin line).
              hasSecondLine: [...row.children].some((cell) => {
                const content = cell.firstElementChild;
                return (
                  content !== null &&
                  content.classList.contains('flex-col') &&
                  content.children.length >= 2
                );
              }),
            };
          }),
        );
        expect(rows.length).toBeGreaterThan(0);
        const off = rows.filter((row) => Math.abs(row.height - 40) > 0.5);
        console.log(
          `${name} ${tag}: ${rows.length} rows, ${rows.length - off.length} at 40px, other rows ${JSON.stringify(off.slice(0, 4).map((row) => ({ h: row.height, note: row.hasNote, text: row.text })))}`,
        );
        const notes = off.filter((row) => row.hasNote && NOTE_ALLOWED.has(name));
        if (notes.length > 0) {
          console.log(
            `${name} ${tag}: protected note rows ${JSON.stringify(notes.map((row) => ({ h: row.height, text: row.text })))}`,
          );
        }
        const twoLine = off.filter((row) => row.hasSecondLine && TWO_LINE_ALLOWED.has(name));
        for (const row of twoLine) {
          expect(row.height, `two line row: ${row.text}`).toBeLessThanOrEqual(TWO_LINE_MAX);
        }
        const unexpected = off.filter(
          (row) =>
            !(row.hasNote && NOTE_ALLOWED.has(name)) &&
            !(row.hasSecondLine && TWO_LINE_ALLOWED.has(name)),
        );
        expect(
          unexpected.map((row) => `${row.height}px: ${row.text}`),
          'rows that are not 40px',
        ).toEqual([]);
      });

      if (NOTE_ALLOWED.has(name)) {
        test(`${name} protected note rows are at most 62px and the note is fully visible in ${tag}`, async ({
          page,
        }) => {
          const screen = SCREENS.find((entry) => entry.tag === name)!;
          await enter(page, { theme, dir });
          await openPath(page, screen.path());
          const notes = await page.locator('main table tbody tr').evaluateAll((all) =>
            all.flatMap((row) => {
              const last = row.lastElementChild;
              if (!last) return [];
              const leaves = [...last.querySelectorAll('*')].filter(
                (element) =>
                  element.children.length === 0 &&
                  (element.textContent ?? '').trim() !== '' &&
                  element.closest('button, a') === null,
              );
              if (leaves.length === 0) return [];
              const panel = row.closest('[data-slot="table-container"]')!.getBoundingClientRect();
              const cell = last.getBoundingClientRect();
              return leaves.map((note) => {
                const rect = note.getBoundingClientRect();
                return {
                  text: (note.textContent ?? '').trim().slice(0, 40),
                  rowHeight: row.getBoundingClientRect().height,
                  noteClipped: note.scrollWidth > note.clientWidth + 1,
                  cellClipped: last.scrollWidth > last.clientWidth + 1,
                  insideCell: rect.left >= cell.left - 1 && rect.right <= cell.right + 1,
                  insidePanel: rect.left >= panel.left - 1 && rect.right <= panel.right + 1,
                  lines: Math.round(rect.height / parseFloat(getComputedStyle(note).lineHeight)),
                };
              });
            }),
          );
          console.log(`${name} ${tag} notes: ${JSON.stringify(notes)}`);
          expect(notes.length, 'a protected row with a note is on the first page').toBeGreaterThan(
            0,
          );
          for (const note of notes) {
            expect(note.rowHeight, note.text).toBeLessThanOrEqual(62);
            expect(note.noteClipped, `${note.text} clipped`).toBe(false);
            expect(note.cellClipped, `${note.text} cell clipped`).toBe(false);
            expect(note.insideCell, `${note.text} inside its cell`).toBe(true);
            expect(note.insidePanel, `${note.text} inside the panel`).toBe(true);
          }
        });
      }

      test(`${name} cells are not clipped, targets stay 24px, focus shows, axe zero in ${tag}`, async ({
        page,
      }) => {
        test.setTimeout(90_000);
        const screen = SCREENS.find((entry) => entry.tag === name)!;
        await enter(page, { theme, dir });
        await openPath(page, screen.path());
        const found = await page.locator('main table tbody tr').evaluateAll((all) => ({
          clipped: all.flatMap((row) =>
            [...row.querySelectorAll('td, th')]
              .filter((cell) => cell.scrollHeight > cell.clientHeight + 1)
              .map((cell) => (cell.textContent ?? '').trim().slice(0, 30)),
          ),
          small: all.flatMap((row) =>
            [...row.querySelectorAll('button')]
              .map((button) => button.getBoundingClientRect())
              .filter((rect) => rect.width < 24 || rect.height < 24)
              .map((rect) => `${Math.round(rect.width)}x${Math.round(rect.height)}`),
          ),
        }));
        expect(found.clipped, 'cells with clipped text').toEqual([]);
        expect(found.small, 'buttons under 24px').toEqual([]);

        // Keyboard focus on the first button (or text link) in the body shows a 2px outline.
        const button = page.locator('main table tbody button').first();
        const first =
          (await button.count()) > 0 ? button : page.locator('main table tbody a').first();
        if ((await first.count()) > 0) {
          let focused = false;
          for (let step = 0; step < 150 && !focused; step += 1) {
            await page.keyboard.press('Tab');
            focused = await first.evaluate((element) => element === document.activeElement);
          }
          expect(focused, 'Tab reaches the first row control').toBe(true);
          const ring = await first.evaluate((element) => {
            const computed = getComputedStyle(element);
            return {
              style: computed.outlineStyle,
              width: parseFloat(computed.outlineWidth),
              height: element.getBoundingClientRect().height,
              isButton: element.tagName === 'BUTTON',
            };
          });
          expect(ring.style).not.toBe('none');
          expect(ring.width).toBeGreaterThanOrEqual(2);
          // A text link in a cell is a WCAG 2.5.8 spacing case; a button must be 24px.
          if (ring.isButton) expect(ring.height).toBeGreaterThanOrEqual(24);
        }
        await expectNoAxeViolations(page);
        await shot(page, `${name}-rows-${tag}`);
      });
    }
  }
});

test.describe('SKU option line in Arabic at 3x (AC-20, look only)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop' || !SHOT_DIR)); // eslint-disable-line no-empty-pattern
  test.use({ deviceScaleFactor: 3 });

  for (const { theme, dir, tag } of COMBINATIONS.filter((c) => c.dir === 'rtl')) {
    test(`zoomed SKU rows with an option line in ${tag}`, async ({ page }) => {
      await enter(page, { theme, dir });
      await openPath(page, '/skus');
      const rows = page.locator('main table tbody tr');
      const heights = await rows.evaluateAll((all) =>
        all.slice(0, 6).map((row) => Math.round(row.getBoundingClientRect().height * 100) / 100),
      );
      console.log(`skus zoom ${tag} first row heights: ${JSON.stringify(heights)}`);
      // The code and name columns sit at the inline start (the right edge in Arabic).
      const box = await page.locator('main [data-slot="table-container"]').first().boundingBox();
      const first = await rows.first().boundingBox();
      if (!box || !first || !SHOT_DIR) return;
      mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({
        path: join(SHOT_DIR, `skus-zoom-${tag}.png`),
        clip: { x: box.x + box.width - 560, y: first.y - 4, width: 560, height: 6 * 40 + 8 },
      });
    });
  }
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

  for (const { theme, dir, tag } of COMBINATIONS) {
    for (const path of ['/stock', '/locations']) {
      test(`the online warning on ${path} is amber with a triangle, readable, and axe clean in ${tag}`, async ({
        page,
      }) => {
        test.setTimeout(90_000);
        await enter(page, { theme, dir });
        await openPath(page, path);
        const notice = page.getByRole('region', {
          name: textFor(dir, 'inventory.onlineGate.noticeLabel'),
        });
        // The notice only shows while no location is online; a database with one online skips this.
        const shown = await notice.waitFor({ state: 'visible', timeout: 8000 }).then(
          () => true,
          () => false,
        );
        test.skip(!shown, 'an online location exists on this database, so the notice is not shown');
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
        const look = await notice.evaluate((element) => {
          const probe = (variable: string) => {
            const el = document.createElement('div');
            el.style.color = `var(${variable})`;
            document.body.append(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          type Rgba = [number, number, number, number];
          const parse = (value: string): Rgba => {
            const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
            return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 1];
          };
          // The fill a person sees behind an element: its own colour over its ancestors' colours.
          const backdrop = (start: Element): Rgba => {
            const layers: Rgba[] = [];
            for (let node: Element | null = start; node; node = node.parentElement) {
              const color = parse(getComputedStyle(node).backgroundColor);
              if (color[3] > 0) layers.push(color);
              if (color[3] === 1) break;
            }
            let out: [number, number, number] = [255, 255, 255];
            for (const [r, g, b, a] of layers.reverse()) {
              out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
            }
            return [...out, 1];
          };
          const luminance = ([r, g, b]: Rgba) => {
            const channel = (value: number) => {
              const v = value / 255;
              return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          };
          const contrast = (a: Rgba, b: Rgba) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
          };
          const alert = element.querySelector('[data-slot="alert"]')!;
          const description = element.querySelector('[data-slot="alert-description"]')!;
          const svg = element.querySelector('svg');
          const link = element.querySelector('a');
          const linkLook = link
            ? {
                text: getComputedStyle(link).color,
                fill: backdrop(link),
                image: getComputedStyle(link).backgroundImage,
                contrast: contrast(parse(getComputedStyle(link).color), backdrop(link)),
              }
            : null;
          return {
            border: getComputedStyle(alert).borderTopColor,
            text: getComputedStyle(description).color,
            icon: svg ? getComputedStyle(svg).color : null,
            iconClass: svg?.getAttribute('class') ?? '',
            iconHidden: svg?.getAttribute('aria-hidden'),
            fill: getComputedStyle(alert).backgroundColor,
            warning: probe('--warning'),
            primary: probe('--primary'),
            card: (() => {
              const el = document.createElement('div');
              el.style.backgroundColor = 'var(--card)';
              document.body.append(el);
              const color = getComputedStyle(el).backgroundColor;
              el.remove();
              return color;
            })(),
            linkLook,
          };
        });
        console.log(`online warning ${path} ${tag}: ${JSON.stringify(look)}`);
        expect(look.iconClass).toContain('lucide-triangle-alert');
        expect(look.iconHidden).toBe('true');
        expect(look.border).toBe(look.warning);
        expect(look.text).toBe(look.warning);
        expect(look.icon).toBe(look.warning);
        expect(look.fill).toBe(look.card);
        for (const colour of [look.border, look.text, look.icon, look.fill]) {
          expect(colour).not.toBe(look.primary);
        }
        if (path === '/stock') {
          // The link to the gate: readable text on its fill, and a visible outline on keyboard focus.
          expect(look.linkLook, 'the gate link is in the notice').not.toBeNull();
          expect(look.linkLook?.image).toBe('none');
          expect(look.linkLook?.contrast ?? 0).toBeGreaterThanOrEqual(4.5);
          const link = notice.getByRole('link', {
            name: textFor(dir, 'inventory.onlineGate.noticeLink'),
          });
          let focused = false;
          for (let step = 0; step < 80 && !focused; step += 1) {
            await page.keyboard.press('Tab');
            focused = await link.evaluate((element) => element === document.activeElement);
          }
          expect(focused, 'Tab reaches the gate link').toBe(true);
          const ring = await link.evaluate((element) => {
            const computed = getComputedStyle(element);
            return { style: computed.outlineStyle, width: parseFloat(computed.outlineWidth) };
          });
          expect(ring.style).not.toBe('none');
          expect(ring.width).toBeGreaterThanOrEqual(2);
        }
        await expectNoAxeViolations(page);
        await shot(page, `${path === '/stock' ? 'stock' : 'locations'}-notice-${tag}`);
      });
    }
  }
});

test.describe('phone (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'mobile')); // eslint-disable-line no-empty-pattern

  test('/skus at 390px keeps its stacked card list: no table, cards at their own height', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await enter(page, { theme: 'dark', dir: 'rtl' });
    await openPath(page, '/skus');
    await expect(page.locator('main table')).toBeHidden();
    const cards = page.locator('main ul[aria-label] > li');
    expect(await cards.count()).toBeGreaterThan(0);
    const heights = await cards.evaluateAll((all) =>
      all.slice(0, 5).map((card) => Math.round(card.getBoundingClientRect().height)),
    );
    console.log(`skus mobile card heights: ${JSON.stringify(heights)}`);
    for (const height of heights) expect(height).toBeGreaterThan(80);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
    const padding = await page
      .locator('main ul[aria-label] > li td, main ul[aria-label] > li')
      .first()
      .evaluate((element) => getComputedStyle(element).paddingTop);
    // The card keeps its own `p-3` (12px); the desktop only `py-0` on cells does not reach it.
    expect(padding).toBe('12px');
  });

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
