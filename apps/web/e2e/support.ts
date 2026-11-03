import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';

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
  config: { languages?: string[]; defaultLanguage?: string } = {},
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

/** WCAG 2.2 AA through axe; contrast and target size need a real browser, so they run here. */
export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help}\n  ${violation.nodes.map((node) => node.target.join(' ')).join('\n  ')}`,
  );
  expect(summary).toEqual([]);
}

/** The owner connection to the dev database, for seeding test rows. */
function ownerDatabaseUrl(): string {
  const rootEnv = new URL('../../../.env', import.meta.url);
  if (!process.env.MIGRATION_DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url)
    throw new Error('Set MIGRATION_DATABASE_URL (or create the root .env) to seed locations.');
  return url;
}

export interface SeededLocations {
  warehouse: { id: string; code: string; name: string };
  showroom: { id: string; code: string; name: string };
  remove(): Promise<void>;
}

/** Inserts one warehouse and one showroom with unique codes, and removes them afterwards. */
export async function seedLocations(): Promise<SeededLocations> {
  const tag = randomUUID().slice(0, 8);
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const insert = async (code: string, name: string, type: string) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO locations (code, name, type) VALUES ($1, $2, $3) RETURNING id`,
      [code, JSON.stringify({ en: name }), type],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no location id');
    return { id, code, name };
  };
  const warehouse = await insert(`E2E-${tag}-WH`, `E2E warehouse ${tag}`, 'warehouse');
  const showroom = await insert(`E2E-${tag}-SR`, `E2E showroom ${tag}`, 'showroom');
  return {
    warehouse,
    showroom,
    async remove() {
      await pool.query(`DELETE FROM locations WHERE code LIKE $1`, [`E2E-${tag}-%`]);
      await pool.end();
    },
  };
}
