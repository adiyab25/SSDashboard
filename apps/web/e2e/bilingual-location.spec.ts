import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { openShell, useBrowserState } from './support';

// Spec 0004 AC-9 on a real screen: the location switcher shows bilingual stored text by the
// active language, else the install default, else any other non empty language, else the code.
test.describe('bilingual location names (AC-9)', () => {
  const tag = randomUUID().slice(0, 8);
  const arabicOnly = { code: `E2E-${tag}-AR`, arName: `مخزن ${tag}` };
  const englishOnly = { code: `E2E-${tag}-EN`, enName: `English only ${tag}` };
  const noNames = { code: `E2E-${tag}-NN` };

  test.beforeAll(async () => {
    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    try {
      const insert = (code: string, name: object) =>
        pool.query(`INSERT INTO locations (code, name, kind) VALUES ($1, $2, 'warehouse')`, [
          code,
          JSON.stringify(name),
        ]);
      await insert(arabicOnly.code, { ar: arabicOnly.arName });
      await insert(englishOnly.code, { en: englishOnly.enName });
      await insert(noNames.code, {});
    } finally {
      await pool.end();
    }
  });

  test.afterAll(async () => {
    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    try {
      await pool.query(`DELETE FROM locations WHERE code LIKE $1`, [`E2E-${tag}-%`]);
    } finally {
      await pool.end();
    }
  });

  test.beforeEach(({ viewport }) => {
    test.skip((viewport?.width ?? 0) < 1000, 'one viewport is enough for the name rule');
  });

  const open = async (page: Page) => {
    await openShell(page);
    await page.getByRole('button', { name: /^(Location|الموقع)/ }).click();
    await page.getByRole('combobox').fill(tag);
  };

  test('in English a name held only in Arabic shows, and a nameless location shows its code', async ({
    page,
  }) => {
    await useBrowserState(page, { dir: 'ltr' });
    await open(page);

    await expect(page.getByRole('option', { name: new RegExp(arabicOnly.arName) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(englishOnly.enName) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(`${noNames.code}`) })).toBeVisible();
  });

  test('in Arabic a name held only in English falls back to it', async ({ page }) => {
    await useBrowserState(page, { dir: 'rtl' });
    await open(page);

    await expect(page.getByRole('option', { name: new RegExp(arabicOnly.arName) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(englishOnly.enName) })).toBeVisible();
  });
});
