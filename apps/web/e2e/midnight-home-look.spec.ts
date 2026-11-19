import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import type { AuditEntryView } from '@ssdashboard/contracts';
import {
  seedAccount,
  seedPartnerAccount,
  seedPartnerLogin,
  signInThroughApi,
  type SeededAccount,
  type SeededPartnerAccount,
} from './accounts';
import { STORAGE_STATE } from './auth';
import { api, createLocation, createSku, receive, voidReceipt } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState as setBrowserState,
  type TextDirection,
  type Theme,
} from './support';

// Spec 0025 milestone M6 (AC-8, AC-10, AC-20, AC-21, AC-22, decisions 13 and 14): home, staff (both
// tabs), audit, settings, cost rules and the account page in the Midnight look, measured in a real
// browser at 1280px. One test per screen and combination (dark and light, English and Arabic)
// walks the screen and each dialog or tab that paints different controls, and in each view checks
// axe, the fields (fill, border, 40px, focus ring), every table (header 44px, rows 40px, card edge)
// and the main action count. The notices are checked apart. Set SHOT_DIR to also save screenshots.

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
  receiptId: string;
  entry: AuditEntryView;
  partner: SeededPartnerAccount;
  partnerLogin: SeededAccount;
  cleanup: () => Promise<void>;
}

let seed: Seed | undefined;
const accounts: SeededAccount[] = [];

function seeded(): Seed {
  if (!seed) throw new Error('no seed');
  return seed;
}

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const request: APIRequestContext = await playwright.request.newContext({
    baseURL: baseURL ?? origin,
    storageState: STORAGE_STATE,
    extraHTTPHeaders: { origin },
  });
  try {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    // A voided stock receipt: one real audit entry with a field diff (the entry dialog's table).
    const location = await createLocation(request, `HL-${tag}`);
    const sku = await createSku(request, `HLK-${tag}`);
    const receipt = await receive(request, location.id, sku.id, 3);
    await voidReceipt(request, receipt.id, `Look ${tag}`);
    const { body } = await api(
      request,
      'GET',
      `/audit/entries?recordType=stock_receipt&recordId=${receipt.id}`,
    );
    const entry = (body.items as AuditEntryView[])[0];
    if (!entry) throw new Error('The void left no audit entry');
    // A partner login, so the partner logins tab has a data row with its action button.
    const partner = await seedPartnerAccount();
    const partnerLogin = await seedPartnerLogin(partner.id, { name: `Look Partner ${tag}` });
    seed = {
      receiptId: receipt.id,
      entry,
      partner,
      partnerLogin,
      cleanup: async () => {
        await partnerLogin.remove().catch(() => undefined);
        await partner.remove().catch(() => undefined);
      },
    };
  } finally {
    await request.dispose();
  }
});

test.afterAll(async () => {
  await seed?.cleanup();
});

test.afterEach(async () => {
  while (accounts.length > 0)
    await accounts
      .pop()
      ?.remove()
      .catch(() => undefined);
});

/** Signs in as a fresh manager with the cost grant, in the language of the direction. */
async function enter(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  state: { theme: Theme; dir: TextDirection },
) {
  const account = await seedAccount({
    hats: ['manager'],
    grants: ['cost.view'],
    language: state.dir === 'rtl' ? 'ar' : 'en',
  });
  accounts.push(account);
  await signInThroughApi(context, account, baseURL ?? '');
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
async function openDialogBy(page: Page, trigger: Locator) {
  await expect(trigger.first()).toBeVisible();
  await expect(async () => {
    if (!(await page.getByRole('dialog').isVisible())) await trigger.first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole('dialog').locator('[data-slot="skeleton"]')).toHaveCount(0);
}

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

const withName = (dir: TextDirection, key: Parameters<typeof textFor>[1], name: string) =>
  textFor(dir, key).replace('{{name}}', name);

/** The audit list filtered to the seeded receipt, so exactly its entry is the data row. */
const auditPath = () => `/audit?recordType=stock_receipt&recordId=${seeded().receiptId}`;

interface Step {
  tag: string;
  /** Moves the open page into this state; the scope is where the controls to measure live. */
  run: (page: Page, dir: TextDirection, t: Translate) => Promise<void>;
  scope?: string;
}

interface Screen {
  tag: string;
  path: () => string;
  before?: (page: Page) => Promise<void>;
  /** Waits for what the screen loads, so no skeleton is measured. */
  ready: (page: Page, t: Translate) => Promise<void>;
  steps: Step[];
  /** How many main (default variant) buttons the main area shows in its base state. */
  blends: number;
}

/** The tab or dialog scope of a step that only changes what main shows. */
const MAIN = 'main';
const DIALOG = '[role="dialog"]';

async function openStaffTab(page: Page, key: 'staff.tabs.partners', t: Translate) {
  const tab = page.getByRole('tab', { name: t(key) });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/** Answers the license summary with a clock-behind check, in the browser only. */
async function mockClockBehind(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/platform/license',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      return route.fulfill({
        response,
        json: {
          ...json,
          lastCheck: {
            checkedAt: new Date().toISOString(),
            trigger: 'daily',
            outcome: 'valid',
            clockBehind: true,
          },
        },
      });
    },
  );
}

/** Answers the cost rules read with no lock date, in the browser only, whatever the database holds. */
async function mockLockUnset(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/platform/cost-rules',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      return route.fulfill({
        response,
        json: { ...json, lockDate: null, lockDateInvalid: false },
      });
    },
  );
}

const SCREENS: Screen[] = [
  {
    tag: 'home',
    path: () => '/',
    ready: async (page) => {
      await expect(page.locator('main dd').first()).toBeVisible();
    },
    blends: 0,
    steps: [],
  },
  {
    tag: 'staff',
    path: () => '/staff',
    ready: async (page, t) => {
      await expect(
        page.getByRole('searchbox', { name: new RegExp(t('staff.search')) }),
      ).toBeVisible();
      await expect(page.locator('main table tbody tr button').first()).toBeVisible();
    },
    blends: 1,
    steps: [
      {
        tag: 'add-staff',
        scope: DIALOG,
        run: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('staff.add')));
        },
      },
      {
        tag: 'partner-logins',
        scope: MAIN,
        run: async (page, _dir, t) => {
          await openStaffTab(page, 'staff.tabs.partners', t);
          await expect(
            page.getByRole('searchbox', { name: new RegExp(t('staff.partners.search')) }),
          ).toBeVisible();
          await expect(page.locator('main table tbody tr button').first()).toBeVisible();
          await expect(page.locator('main table tbody tr[aria-hidden]')).toHaveCount(0);
        },
      },
      {
        tag: 'add-partner-login',
        scope: DIALOG,
        run: async (page, _dir, t) => {
          await openStaffTab(page, 'staff.tabs.partners', t);
          await openDialogBy(page, button(page, t('staff.partners.add')));
        },
      },
    ],
  },
  {
    tag: 'audit',
    path: auditPath,
    ready: async (page) => {
      await expect(page.locator('main table tbody tr button').first()).toBeVisible();
    },
    blends: -1,
    steps: [
      {
        tag: 'entry-dialog',
        scope: DIALOG,
        run: async (page) => {
          await openDialogBy(page, page.locator('main table tbody tr button').first());
          await expect(page.getByRole('dialog').locator('table')).toBeVisible();
        },
      },
    ],
  },
  {
    tag: 'settings',
    path: () => '/settings',
    before: mockClockBehind,
    ready: async (page, t) => {
      await expect(
        page.getByRole('heading', { level: 2, name: t('settings.sections.brand') }),
      ).toBeVisible();
    },
    blends: -1,
    steps: [
      {
        tag: 'change-dialog',
        scope: DIALOG,
        run: async (page, dir, t) => {
          await openDialogBy(
            page,
            button(
              page,
              withName(
                dir,
                'settings.row.changeNamed',
                t('settings.entries.operatingDayCutoffHour.label'),
              ),
            ),
          );
        },
      },
    ],
  },
  {
    tag: 'cost-rules',
    path: () => '/settings/cost-rules',
    ready: async (page, t) => {
      await expect(
        page.getByRole('table', { name: t('settings.costRules.currentTable') }),
      ).toBeVisible();
    },
    blends: -1,
    steps: [
      {
        tag: 'rule-dialog',
        scope: DIALOG,
        run: async (page, _dir, _t) => {
          await openDialogBy(page, page.locator('main table tbody tr button').first());
        },
      },
    ],
  },
  {
    tag: 'account',
    path: () => '/account',
    ready: async (page, t) => {
      await expect(page.getByRole('button', { name: t('account.profile.save') })).toBeVisible();
    },
    blends: 1,
    steps: [],
  },
];

/**
 * Visits a screen, calls `onView` on the page and again on each of its states, and answers the
 * failures it collected, so one broken state does not hide the rest.
 */
async function walk(
  page: Page,
  screen: Screen,
  dir: TextDirection,
  onView: (view: { name: string; scope: string; base: boolean }) => Promise<void>,
): Promise<string[]> {
  const t: Translate = (key) => textFor(dir, key);
  const failures: string[] = [];
  const attempt = async (name: string, scope: string, base: boolean) => {
    try {
      await onView({ name, scope, base });
    } catch (error) {
      failures.push(
        `${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 900)}`,
      );
    }
  };
  const open = async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await screen.before?.(page);
    await openPath(page, screen.path());
    await screen.ready(page, t);
  };
  await open();
  await attempt(screen.tag, MAIN, true);
  for (const step of screen.steps) {
    const name = `${screen.tag}-${step.tag}`;
    try {
      await step.run(page, dir, t);
    } catch (error) {
      failures.push(
        `${name}: could not reach: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      );
      await open();
      continue;
    }
    await attempt(name, step.scope ?? MAIN, false);
    await open();
  }
  return failures;
}

async function settleAnimations(page: Page) {
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
}

/** Every field in a scope: fill, border, corners, height, and what the page and the card colour are. */
async function measureFields(page: Page, scope: string) {
  await settleAnimations(page);
  return page
    .locator(scope)
    .first()
    .evaluate((root) => {
      const probe = (variable: string, property: 'backgroundColor' | 'color') => {
        const element = document.createElement('div');
        element.style[property] = `var(${variable})`;
        document.body.append(element);
        const color = getComputedStyle(element)[property];
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
      return {
        dark,
        cardColor: probe('--card', 'backgroundColor'),
        pageColor: probe('--background', 'backgroundColor'),
        inputColor: probe('--input', 'color'),
        errorColor: probe('--destructive', 'color'),
        fields: fields.map((element) => {
          const computed = getComputedStyle(element);
          const kind = element.matches('select')
            ? 'select'
            : element.matches('textarea')
              ? 'textarea'
              : element.matches('[role="combobox"]')
                ? 'combobox'
                : 'input';
          return {
            id: idOf(element),
            kind,
            fill: computed.backgroundColor,
            border: computed.borderTopColor,
            borderWidth: computed.borderTopWidth,
            radius: computed.borderTopLeftRadius,
            height: element.offsetHeight,
            invalid: element.getAttribute('aria-invalid') === 'true',
            onCard:
              element.closest(
                '[data-slot="card"], [data-slot="dialog-content"], .gradient-card-edge',
              ) !== null,
          };
        }),
        comboboxes: root.querySelectorAll('[role="combobox"]').length,
      };
    });
}

/** Focuses each field in a scope and reads its outline against the `--ring` colour. */
async function measureFocusRings(page: Page, scope: string) {
  const handles = await page
    .locator(scope)
    .first()
    .locator(
      'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="combobox"]:not([disabled])',
    )
    .filter({ visible: true })
    .elementHandles();
  const out: {
    id: string;
    style: string;
    width: number;
    offset: number;
    color: string;
    ring: string;
  }[] = [];
  for (const handle of handles) {
    await handle.evaluate((element) => (element as HTMLElement).focus());
    await settleAnimations(page);
    out.push(
      await handle.evaluate((node) => {
        const element = node as HTMLElement;
        const probe = document.createElement('div');
        probe.style.color = 'var(--ring)';
        document.body.append(probe);
        const ring = getComputedStyle(probe).color;
        probe.remove();
        const computed = getComputedStyle(element);
        return {
          id: element.id || element.tagName.toLowerCase(),
          style: computed.outlineStyle,
          width: parseFloat(computed.outlineWidth),
          offset: parseFloat(computed.outlineOffset),
          color: computed.outlineColor,
          ring,
        };
      }),
    );
  }
  return out;
}

/**
 * The allowed height range of the two rows that may grow (owner ruling 2026-11-19): /audit list
 * rows (a two line record cell; measured 55px in English, 59.25px in Arabic) and /staff rows in
 * Arabic only, when the name or email cell wraps (in Arabic at 1280px the name, email and
 * one-line date cannot all fit on one line; measured 56.5px).
 */
const GROWN_ROW_MIN = 52;
const GROWN_ROW_MAX = 60;

interface TableLook {
  label: string;
  panel: boolean;
  radius: string | null;
  heads: { text: string; height: number; mono: boolean; transform: string; weight: string }[];
  rows: { text: string; height: number; hasButton: boolean; cut: string[]; stacked: boolean }[];
  /** The table's panel scrolls sideways (its content is wider than the panel). */
  scrollsSideways: boolean;
  /** The panel's scrollWidth and clientWidth, for the report. */
  panelWidths: string;
}

/** Heights and looks of every table in a scope: headers and body rows. */
async function measureTables(page: Page, scope: string): Promise<TableLook[]> {
  await settleAnimations(page);
  return page.locator(`${scope} table:visible`).evaluateAll((all) =>
    all.map((table) => {
      const panel = table.closest('[class*="gradient-card-edge"]');
      return {
        label: table.getAttribute('aria-label') ?? '',
        panel: panel !== null,
        radius: panel ? getComputedStyle(panel).borderTopLeftRadius : null,
        heads: [...table.querySelectorAll('thead th')].map((th) => {
          const computed = getComputedStyle(th);
          return {
            text: (th.textContent ?? '').trim(),
            height: th.getBoundingClientRect().height,
            mono: computed.fontFamily.toLowerCase().includes('mono'),
            transform: computed.textTransform,
            weight: computed.fontWeight,
          };
        }),
        rows: [...table.querySelectorAll('tbody tr')].map((row) => ({
          text: (row.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
          height: row.getBoundingClientRect().height,
          hasButton: row.querySelector('button') !== null,
          // A cell really holds two lines: its text (outside buttons) spans more than one line box,
          // whether it is two stacked elements or one text that wraps.
          stacked: [...row.querySelectorAll('td, th')].some((cell) => {
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            const rects: DOMRect[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if ((node.textContent ?? '').trim() === '') continue;
              if (node.parentElement?.closest('button') != null) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              rects.push(range.getBoundingClientRect());
            }
            if (rects.length === 0) return false;
            const top = Math.min(...rects.map((r) => r.top));
            const bottom = Math.max(...rects.map((r) => r.bottom));
            return bottom - top > 30;
          }),
          // Text must never be cut: a cell or element that hides overflow or shows an ellipsis
          // while its content is wider or taller than its box.
          cut: [...row.querySelectorAll('td, th, td *')]
            .filter((el) => {
              const style = getComputedStyle(el);
              const hides = style.overflowX !== 'visible' || style.overflowY !== 'visible';
              const ellipsis = style.textOverflow === 'ellipsis';
              const tooWide = el.scrollWidth > el.clientWidth + 1;
              const tooTall = el.scrollHeight > el.clientHeight + 1;
              return (hides || ellipsis) && (tooWide || tooTall);
            })
            .map(
              (el) => `${el.tagName.toLowerCase()} ${(el.textContent ?? '').trim().slice(0, 20)}`,
            ),
        })),
        panelWidths: (() => {
          const panel = table.closest('[class*="gradient-card-edge"]') ?? table.parentElement!;
          return `${panel.scrollWidth}/${panel.clientWidth}`;
        })(),
        scrollsSideways: (() => {
          const panel = table.closest('[class*="gradient-card-edge"]') ?? table.parentElement!;
          return panel.scrollWidth > panel.clientWidth + 1;
        })(),
      };
    }),
  );
}

test.describe('every screen and state in the Midnight look (AC-8, AC-20, AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS) {
    for (const screen of SCREENS) {
      test(`${screen.tag} and its states: axe, fields, tables, main action in ${tag}`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.setTimeout(180_000);
        await enter(page, context, baseURL, { theme, dir });
        expect(
          await page.evaluate(() => window.innerWidth),
          'the desktop project is 1280px wide',
        ).toBe(1280);
        const failures = await walk(page, screen, dir, async ({ name, scope, base }) => {
          await expect(page.locator('h1')).toHaveCount(1);
          await expectNoAxeViolations(page);

          // Fields: the field fill, 1px input border, 8px corners, 40px, and the cyan focus ring.
          const result = await measureFields(page, scope);
          const wrong = result.fields
            .filter((field) => {
              const want = !result.dark && field.onCard ? result.cardColor : result.pageColor;
              return field.fill !== want;
            })
            .map(
              (field) => `${field.kind}#${field.id} painted ${field.fill}, onCard ${field.onCard}`,
            );
          expect(wrong, `${name} fill: card ${result.cardColor}, page ${result.pageColor}`).toEqual(
            [],
          );
          expect(
            result.fields
              .filter(
                (field) =>
                  field.border !== (field.invalid ? result.errorColor : result.inputColor) ||
                  field.borderWidth !== '1px' ||
                  field.radius !== '8px',
              )
              .map(
                (field) =>
                  `${field.id}: border ${field.border} ${field.borderWidth}, radius ${field.radius}`,
              ),
            `${name} input border and 8px corners`,
          ).toEqual([]);
          expect(
            result.fields
              .filter((field) => field.kind !== 'textarea' && field.height !== 40)
              .map((field) => `${field.kind}#${field.id} is ${field.height}px`),
            `${name} every input, select and combobox is 40px`,
          ).toEqual([]);
          const rings = await measureFocusRings(page, scope);
          expect(
            rings
              .filter(
                (ring) =>
                  ring.style !== 'solid' ||
                  ring.width !== 2 ||
                  ring.offset !== 2 ||
                  ring.color !== ring.ring,
              )
              .map(
                (ring) =>
                  `${ring.id}: ${ring.style} ${ring.width}px offset ${ring.offset} ${ring.color}`,
              ),
            `${name} cyan focus ring`,
          ).toEqual([]);

          // Tables: header 44px, data rows 40px (rows with a 32px button too), card edge panel.
          const tables = await measureTables(page, scope);
          const problems: string[] = [];
          for (const look of tables) {
            const label = look.label || 'table';
            if (!look.panel || look.radius !== '12px') {
              problems.push(`${label}: panel edge ${look.panel}, radius ${look.radius}`);
            }
            for (const head of look.heads) {
              if (head.height !== 44)
                problems.push(`${label}: header ${head.text} is ${head.height}px`);
              if (!head.mono || head.transform !== 'lowercase' || head.weight !== '400') {
                problems.push(
                  `${label}: header ${head.text} mono ${head.mono} ${head.transform} ${head.weight}`,
                );
              }
            }
            if (look.scrollsSideways) problems.push(`${label}: the panel scrolls sideways`);
            for (const row of look.rows) {
              // Owner ruling 2026-11-19: only /audit list rows (English and Arabic) and /staff rows
              // on both tabs in Arabic may grow to fit a cell that really wraps, bounded so a real
              // regression still fails. Every other row is 40px, and so is any row on these screens
              // whose cells do not wrap. No row ever cuts text.
              if (row.cut.length > 0) {
                problems.push(`${label}: row "${row.text}" cuts text: ${row.cut.join(', ')}`);
              }
              const mayGrow =
                (screen.tag === 'audit' && name === 'audit') ||
                (screen.tag === 'staff' && dir === 'rtl' && name !== 'staff-add-staff');
              if (mayGrow && row.stacked) {
                if (row.height < GROWN_ROW_MIN || row.height > GROWN_ROW_MAX) {
                  problems.push(
                    `${label}: row "${row.text}" is ${row.height}px, outside ${GROWN_ROW_MIN} to ${GROWN_ROW_MAX}`,
                  );
                }
                continue;
              }
              if (row.height !== 40) {
                problems.push(
                  `${label}: row "${row.text}" is ${row.height}px${row.hasButton ? ' (holds a button)' : ''}`,
                );
              }
            }
          }
          console.log(
            `${name} ${tag}: fields ${result.fields.length}, role=combobox ${result.comboboxes}, tables ${JSON.stringify(tables.map((l) => ({ label: l.label, head: l.heads.map((h) => h.height), rows: l.rows.map((r) => r.height), panel: l.panelWidths })))}`,
          );
          expect(problems, `${name} table problems`).toEqual([]);

          // One main (default variant, blend) button per view.
          const root = page.locator(scope).first();
          const defaults = await root
            .locator('[data-slot="button"][data-variant="default"]')
            .count();
          const blends = await root.locator('.gradient-primary').count();
          console.log(`${name} ${tag}: default buttons ${defaults}`);
          expect(blends, `${name}: every blend is a default button`).toBe(defaults);
          expect(defaults, `${name}: at most one main action`).toBeLessThanOrEqual(1);
          if (base && screen.blends >= 0) {
            expect(defaults, `${name}: the view's one main action`).toBe(screen.blends);
          }
          await shot(page, `${name}-${tag}`);
        });
        expect(failures).toEqual([]);
      });
    }
  }
});

/** What a notice looks like: its border, text and icon colours against the role colours. */
async function readNotice(notice: Locator) {
  await expect(notice).toBeVisible();
  await notice.page().evaluate(() => document.fonts.ready);
  await settleAnimations(notice.page());
  return notice.evaluate((element) => {
    const probe = (variable: string) => {
      const el = document.createElement('div');
      el.style.color = `var(${variable})`;
      document.body.append(el);
      const color = getComputedStyle(el).color;
      el.remove();
      return color;
    };
    const description = element.querySelector('[data-slot="alert-description"]') ?? element;
    const svg = element.querySelector('svg');
    return {
      text: getComputedStyle(description).color,
      icon: svg ? getComputedStyle(svg).color : null,
      iconClass: svg?.getAttribute('class') ?? '',
      iconHidden: svg?.getAttribute('aria-hidden'),
      border: getComputedStyle(element).borderTopColor,
      muted: probe('--muted-foreground'),
      primary: probe('--primary'),
      ring: probe('--ring'),
      warning: probe('--warning'),
      destructive: probe('--destructive'),
    };
  });
}

/** An info notice: muted text and icon, the "i" icon, and never cyan, amber or red (AC-10, decision 13). */
function expectInfoNotice(name: string, look: Awaited<ReturnType<typeof readNotice>>) {
  console.log(`${name}: ${JSON.stringify(look)}`);
  expect(look.iconClass, `${name} icon`).toContain('lucide-info');
  expect(look.iconHidden, `${name} icon is hidden from readers`).toBe('true');
  expect(look.text, `${name} text is muted-foreground`).toBe(look.muted);
  expect(look.icon, `${name} icon is muted-foreground`).toBe(look.muted);
  for (const colour of [look.text, look.icon, look.border]) {
    for (const banned of [look.primary, look.ring, look.warning, look.destructive]) {
      expect(colour, `${name} is never a role colour`).not.toBe(banned);
    }
  }
}

test.describe('info notices are muted with an "i" icon (AC-10, decision 13)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS) {
    test(`the audit undone notice, the license clock notice and the cost rules lock notice in ${tag}`, async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(120_000);
      await enter(page, context, baseURL, { theme, dir });
      const t: Translate = (key) => textFor(dir, key);

      // Audit: the entry dialog of an undone entry (the detail answer is stubbed, as audit.spec does).
      await page.route(`**/api/audit/entries/${seeded().entry.id}`, (route) =>
        route.fulfill({ json: { ...seeded().entry, undone: true, canUndo: false, changes: [] } }),
      );
      await openPath(page, auditPath());
      await openDialogBy(page, page.locator('main table tbody tr button').first());
      const undone = page
        .getByRole('dialog')
        .locator('[class*="gradient-card-edge"]')
        .filter({ hasText: t('audit.undo.undoneNotice') });
      expectInfoNotice(`audit undone notice ${tag}`, await readNotice(undone));
      await expectNoAxeViolations(page);
      await page.unrouteAll({ behavior: 'ignoreErrors' });

      // Settings: the license "server clock behind" notice (the last check is stubbed).
      await mockClockBehind(page);
      await openPath(page, '/settings');
      const clock = page
        .locator('main [class*="gradient-card-edge"]')
        .filter({ hasText: t('settings.license.clockBehind') })
        .last();
      expectInfoNotice(`license clock notice ${tag}`, await readNotice(clock));
      await page.unrouteAll({ behavior: 'ignoreErrors' });

      // Cost rules: the "no lock date set" notice (the lock date answer is stubbed).
      await mockLockUnset(page);
      await openPath(page, '/settings/cost-rules');
      const lock = page
        .locator('main [data-slot="alert"]')
        .filter({ hasText: t('settings.costRules.lockUnset') });
      expectInfoNotice(`cost rules lockUnset ${tag}`, await readNotice(lock));
    });
  }
});

test.describe('needs-attention warnings are amber with a triangle (owner ruling 2026-11-19)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  // ONE test for the two entry.warning Alerts: the setting change dialog here, and the step-on
  // dialog's (no automation entry carries a warning today, so that dialog cannot be opened with
  // real data; see the report). To rule them info again, change this one assertion to
  // expectInfoNotice.
  for (const { theme, dir, tag } of COMBINATIONS) {
    test(`the setting change dialog warning Alert is amber with a triangle in ${tag}`, async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      await enter(page, context, baseURL, { theme, dir });
      const t: Translate = (key) => textFor(dir, key);
      await openPath(page, '/settings');
      await openDialogBy(
        page,
        button(
          page,
          withName(
            dir,
            'settings.row.changeNamed',
            t('settings.entries.operatingDayCutoffHour.label'),
          ),
        ),
      );
      const warning = page
        .getByRole('dialog')
        .locator('[data-slot="alert"]')
        .filter({ hasText: t('settings.warnings.operatingDayCutoffHour') });
      const look = await readNotice(warning);
      console.log(`setting change warning ${tag}: ${JSON.stringify(look)}`);
      expect(look.iconClass).toContain('lucide-triangle-alert');
      expect(look.iconHidden).toBe('true');
      expect(look.border).toBe(look.warning);
      expect(look.text).toBe(look.warning);
      expect(look.icon).toBe(look.warning);
      await expectNoAxeViolations(page);
    });
  }
});
