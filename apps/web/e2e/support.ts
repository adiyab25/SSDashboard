import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import type { MessageKey } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { en } from '@ssdashboard/i18n';
import { ownerDatabaseUrl } from './auth';

export type Theme = 'light' | 'dark';
export type TextDirection = 'ltr' | 'rtl';
export type Language = 'en' | 'ar';

/** The core language that reads in each direction. */
const LANGUAGE_FOR_DIRECTION = { ltr: 'en', rtl: 'ar' } as const satisfies Record<
  TextDirection,
  Language
>;

/**
 * Stores the theme and the language (cookie `ss_lang`) before the page loads, as a returning
 * user. `dir` is a shortcut for the core language that reads in that direction.
 */
export async function useBrowserState(
  page: Page,
  state: { theme?: Theme | 'system'; language?: Language; dir?: TextDirection },
) {
  const { theme } = state;
  if (theme) await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
  const language = state.language ?? (state.dir ? LANGUAGE_FOR_DIRECTION[state.dir] : undefined);
  if (language) await setLanguageCookie(page, language);
}

/**
 * The text of a catalog entry in the language a direction opens in, so a locator keeps working
 * when `dir: 'rtl'` makes the app render in Arabic. Reads the same catalogs the app ships.
 */
export function textFor(dir: TextDirection, key: MessageKey): string {
  let node: unknown = dir === 'rtl' ? ar : en;
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== 'string') throw new Error(`No catalog text for ${key}`);
  return node;
}

/** Saves the language the way the app does, so the next load opens in it. */
export async function setLanguageCookie(page: Page, language: string) {
  const url = test.info().project.use.baseURL ?? 'http://localhost:3000';
  await page.context().addCookies([{ name: 'ss_lang', value: language, url }]);
}

/** The `ss_lang` cookie the page currently holds. */
export async function languageCookie(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === 'ss_lang')?.value;
}

/** Answers `GET /api/config` with these install settings. */
export async function stubConfig(
  page: Page,
  config: { languages?: string[]; defaultLanguage?: string; mailEnabled?: boolean } = {},
) {
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        clientName: 'Acme',
        version: '1.0.0',
        currency: 'EGP',
        timezone: 'Africa/Cairo',
        languages: ['en', 'ar'],
        defaultLanguage: 'en',
        mailEnabled: false,
        ...config,
      },
    }),
  );
}

/**
 * Opens a page and waits until the shell has hydrated and loaded its locations (the
 * request only starts after hydration, so shortcuts and menus work once it answers).
 */
export async function openShell(page: Page, path = '/') {
  const locations = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/locations'),
  );
  await page.goto(path);
  await locations;
  await expect(page.getByRole('main')).toBeVisible();
}

/**
 * Waits until React has taken over the form on the page. A click or Enter before that submits
 * the form natively (a full page post), which no person with a fast hand would notice but a
 * test does.
 */
export async function waitForFormHydration(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('main form');
    return form !== null && Object.keys(form).some((key) => key.startsWith('__reactProps'));
  });
}

/**
 * Waits until React has taken over the page's controls (for a page with no form, like a list
 * with a search box). Text typed before this is lost when hydration resets the input.
 */
export async function waitForPageHydration(page: Page) {
  await page.waitForFunction(() => {
    const control = document.querySelector('main input, main button');
    return control !== null && Object.keys(control).some((key) => key.startsWith('__reactProps'));
  });
}

/**
 * Waits until React has taken over one element of the page, found by a CSS selector (for a read
 * only page with no control of its own, such as the cost rules for a reader, where
 * `waitForPageHydration` would wait for a button that never comes). React tags every element it
 * renders with its props, so the tag on a server or first rendered element marks hydration.
 */
export async function waitForElementHydration(page: Page, selector: string) {
  await page.waitForFunction((css) => {
    const element = document.querySelector(css);
    return element !== null && Object.keys(element).some((key) => key.startsWith('__reactProps'));
  }, selector);
}

/** WCAG 2.2 AA through axe; contrast and target size need a real browser, so they run here. */
export async function expectNoAxeViolations(page: Page) {
  // Axe measures contrast on what is painted, so let a toast or dialog finish fading in first
  // (a "Receipt posted" toast caught mid fade reported color-contrast). A skeleton pulses
  // forever; only animations that end are worth waiting for.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help}\n  ${violation.nodes.map((node) => node.target.join(' ')).join('\n  ')}`,
  );
  expect(summary).toEqual([]);
}

export interface SeededLocations {
  warehouse: { id: string; code: string; name: string };
  shop: { id: string; code: string; name: string };
  remove(): Promise<void>;
}

/** Inserts one warehouse and one shop with unique codes, and removes them afterwards. */
export async function seedLocations(): Promise<SeededLocations> {
  const tag = randomUUID().slice(0, 8);
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const insert = async (code: string, name: string, kind: string) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO locations (code, name, kind) VALUES ($1, $2, $3) RETURNING id`,
      [code, JSON.stringify({ en: name }), kind],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no location id');
    return { id, code, name };
  };
  const warehouse = await insert(`E2E-${tag}-WH`, `E2E warehouse ${tag}`, 'warehouse');
  const shop = await insert(`E2E-${tag}-SR`, `E2E shop ${tag}`, 'shop');
  return {
    warehouse,
    shop,
    async remove() {
      await pool.query(`DELETE FROM locations WHERE code LIKE $1`, [`E2E-${tag}-%`]);
      await pool.end();
    },
  };
}

/**
 * Opens /staff in the language of `dir`, switches to the Partner logins tab (spec 0008, AC-15) and
 * waits for its search box. The page's one h1 is the people screen's title whichever tab is shown.
 */
export async function openPartnerLogins(page: Page, dir: TextDirection = 'ltr') {
  await page.goto('/staff');
  await expect(
    page.getByRole('heading', { level: 1, name: textFor(dir, 'staff.title') }),
  ).toBeVisible();
  await waitForPageHydration(page);
  await page.getByRole('tab', { name: textFor(dir, 'staff.tabs.partners') }).click();
  await expect(
    page.getByRole('searchbox', { name: textFor(dir, 'staff.partners.search') }),
  ).toBeVisible();
}
