import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';

export type Theme = 'light' | 'dark';
export type TextDirection = 'ltr' | 'rtl';

/** Stores the theme and development direction before the page loads, as a returning user. */
export async function useBrowserState(
  page: Page,
  state: { theme?: Theme | 'system'; dir?: TextDirection },
) {
  await page.addInitScript((value) => {
    if (value.theme) localStorage.setItem('theme', value.theme);
    if (value.dir) localStorage.setItem('ss_dir', value.dir);
  }, state);
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
