import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  textFor,
  useBrowserState as setBrowserState,
  type TextDirection,
  type Theme,
} from './support';

// The helpers the Midnight look specs (spec 0025, `midnight-*-look.spec.ts`) share: screenshots,
// the four theme and language combinations, signing in and opening pages, walking a screen and its
// states, and the computed style probes (fields, focus rings, tables). A look spec imports what it
// needs from here and keeps only its own seeds, screens, and assertions.

const SHOT_DIR = process.env.SHOT_DIR;

/** Saves a screenshot of the page into SHOT_DIR when it is set, and does nothing otherwise. */
export async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

/** The four theme and language pairs every look spec walks, tagged for test titles and shots. */
export const COMBINATIONS = [
  { theme: 'dark', dir: 'ltr', tag: 'dark-en' },
  { theme: 'dark', dir: 'rtl', tag: 'dark-ar' },
  { theme: 'light', dir: 'ltr', tag: 'light-en' },
  { theme: 'light', dir: 'rtl', tag: 'light-ar' },
] as const satisfies readonly { theme: Theme; dir: TextDirection; tag: string }[];

/** Looks up a message in the language of the direction under test. */
export type Translate = (key: Parameters<typeof textFor>[1]) => string;

/** Stores the theme and language in the browser before the first page load. */
export async function enter(page: Page, state: { theme: Theme; dir: TextDirection }) {
  await setBrowserState(page, state);
}

/** Signs a seeded account in through the api on the page's own context, then stores the theme and language. */
export async function enterAs(
  page: Page,
  account: SeededAccount | undefined,
  state: { theme: Theme; dir: TextDirection },
) {
  if (!account) throw new Error('no manager');
  await signInThroughApi(page.context(), account, test.info().project.use.baseURL ?? '');
  await enter(page, state);
}

/**
 * Seeds a fresh manager in the language of the direction (with the given extra grants), signs it in,
 * and stores the theme and language. Answers the account so the caller can clean it up.
 */
export async function enterAsNewManager(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  state: { theme: Theme; dir: TextDirection },
  options: { grants?: NonNullable<Parameters<typeof seedAccount>[0]>['grants'] } = {},
) {
  const account = await seedAccount({
    hats: ['manager'],
    ...(options.grants ? { grants: options.grants } : {}),
    language: state.dir === 'rtl' ? 'ar' : 'en',
  });
  await signInThroughApi(context, account, baseURL ?? '');
  await enter(page, state);
  return account;
}

/** Opens a path and waits until the page shows its h1, has no busy table or skeleton, and fonts are in. */
export async function openPath(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n'));
  await expect(page.locator('main [aria-busy="true"], main [data-slot="skeleton"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Clicks a trigger until its dialog shows (a click before hydration goes nowhere). `prepare` runs before
 * each try, for a page that needs a step first.
 */
export async function openDialogBy(page: Page, trigger: Locator, prepare?: () => Promise<void>) {
  await expect(trigger.first()).toBeVisible();
  await expect(async () => {
    if (prepare) await prepare();
    if (!(await page.getByRole('dialog').isVisible())) await trigger.first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole('dialog').locator('[data-slot="skeleton"]')).toHaveCount(0);
}

/** Finds a button by its exact accessible name. */
export function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

/** One state of a screen the walk moves into: a tab, a dialog, a filled form. */
export interface Step {
  tag: string;
  /** Moves the open page into this state; the scope is where the controls to measure live. */
  run: (page: Page, dir: TextDirection, t: Translate) => Promise<void>;
  scope?: string;
}

/** One screen the walk visits, with the states it has. */
export interface Screen {
  tag: string;
  path: () => string;
  before?: (page: Page) => Promise<void>;
  /** Waits for what the screen loads, so no skeleton is measured. */
  ready: (page: Page, t: Translate) => Promise<void>;
  steps: Step[];
  /** How many main (default variant) buttons the main area shows in its base state. */
  blends: number;
}

/**
 * Visits a screen, calls `onView` on the page and again on each of its states, and answers the
 * failures it collected, so one broken state does not hide the rest.
 */
export async function walk(
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
  await attempt(screen.tag, 'main', true);
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
    await attempt(name, step.scope ?? 'main', false);
    await open();
  }
  return failures;
}

/** Waits until no finite animation or transition is still running on the page. */
export async function settleAnimations(page: Page) {
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
export async function measureFields(page: Page, scope: string) {
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
export async function measureFocusRings(page: Page, scope: string) {
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

/** What a table looks like, with the notes and errors in its rows (see `measureNotedTables`). */
export interface NotedTableLook {
  label: string;
  panel: boolean;
  radius: string | null;
  heads: { text: string; height: number; mono: boolean; transform: string; weight: string }[];
  rows: {
    text: string;
    height: number;
    note: boolean;
    clipped: boolean;
    errorVisible: boolean | null;
    errorDetail: string;
  }[];
}

/** Heights and looks of every table in main: headers, body rows, and whether a note or error shows in full. */
export async function measureNotedTables(page: Page): Promise<NotedTableLook[]> {
  await settleAnimations(page);
  return page.locator('main table:visible').evaluateAll((all) =>
    all.map((table) => {
      const panel = table.closest('[class*="gradient-card-edge"]');
      const container = table.closest('[data-slot="table-container"]') ?? table.parentElement!;
      const bounds = container.getBoundingClientRect();
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
        rows: [...table.querySelectorAll('tbody tr')].map((row) => {
          const rect = row.getBoundingClientRect();
          const error = row.querySelector('[role="alert"]');
          const noteParagraph = row.querySelector('td p');
          const errorRect = error?.getBoundingClientRect();
          return {
            text: (row.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50),
            height: rect.height,
            note: error !== null || noteParagraph !== null,
            clipped: [...row.querySelectorAll('td')].some(
              (cell) => cell.scrollHeight > cell.clientHeight + 1,
            ),
            errorDetail: errorRect
              ? `error ${Math.round(errorRect.top)}-${Math.round(errorRect.bottom)} left ${Math.round(errorRect.left)} right ${Math.round(errorRect.right)} h ${Math.round(errorRect.height)} scroll ${(error as HTMLElement).scrollHeight}/${(error as HTMLElement).clientHeight}; row ${Math.round(rect.top)}-${Math.round(rect.bottom)}; panel ${Math.round(bounds.left)}-${Math.round(bounds.right)}`
              : '',
            errorVisible: errorRect
              ? errorRect.height > 0 &&
                errorRect.bottom <= rect.bottom + 1 &&
                errorRect.top >= rect.top - 1 &&
                (error as HTMLElement).scrollHeight <= (error as HTMLElement).clientHeight + 1 &&
                errorRect.left >= bounds.left - 1 &&
                errorRect.right <= bounds.right + 1
              : null,
          };
        }),
      };
    }),
  );
}

/** What a table looks like, with stacked cells and sideways scrolling (see `measureStackedTables`). */
export interface StackedTableLook {
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
export async function measureStackedTables(page: Page, scope: string): Promise<StackedTableLook[]> {
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
