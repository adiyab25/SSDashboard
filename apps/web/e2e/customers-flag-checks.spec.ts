import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0014 milestone 3, QA gaps next to customers-flag.spec.ts: a stale dialog keeps its input,
// a flag held only by a merged record shows on the survivor, and the dialog keeps every control in
// view (WCAG 2.4.11 focus not obscured) on a 375px screen.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

type Pool = ReturnType<typeof createDatabase>['pool'];

/** Another session's write: flags the record and moves its stamp, as the api would. */
async function flagInDatabase(pool: Pool, id: string, kind: string) {
  await pool.query(
    `UPDATE customers SET risk_flag = $2::customer_risk_flag, risk_flag_source = 'rule',
       risk_flag_set_at = now(), updated_at = now() + interval '1 second' WHERE id = $1`,
    [id, kind],
  );
}

/** Inserts one customer with a primary phone, optionally merged into another and flagged. */
async function seedCustomer(label: string, options: { mergedInto?: string; fake?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8);
  const name = `${label} ${tag}`;
  const phone = `+2012${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (name, merged_into_id) VALUES ($1, $2) RETURNING id`,
    [name, options.mergedInto ?? null],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Seed insert returned no id');
  await pool.query(
    `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
     VALUES ($1, $2, 'mobile', true)`,
    [id, phone],
  );
  if (options.fake) await flagInDatabase(pool, id, 'fake');
  return {
    id,
    name,
    pool,
    async remove() {
      try {
        await pool.query(`DELETE FROM customer_phones WHERE customer_id = $1`, [id]);
        await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
      } catch {
        // kept on purpose: audit rows may name it
      } finally {
        await pool.end();
      }
    },
  };
}

async function expectFocusInView(page: Page) {
  const state = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, why: 'no focus' };
    const r = el.getBoundingClientRect();
    const inView =
      r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 0;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const top = !!hit && (el === hit || el.contains(hit) || hit.contains(el));
    return { ok: inView && top, why: `${el.tagName} inView=${inView} top=${top}` };
  });
  expect(state.ok, state.why).toBe(true);
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`customer flag checks in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let agent: SeededAccount | undefined;
    const seeded: Awaited<ReturnType<typeof seedCustomer>>[] = [];

    test.beforeEach(async ({ page, context, baseURL }) => {
      agent = await seedAccount({ hats: ['support'], language: dir === 'rtl' ? 'ar' : 'en' });
      await signInThroughApi(context, agent, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const person = agent;
      agent = undefined;
      for (const customer of seeded.splice(0).reverse()) await customer.remove();
      await person?.remove().catch(() => undefined);
    });

    test('a stale dialog says so and keeps what was typed, then saves after the reload', async ({
      page,
    }) => {
      const customer = await seedCustomer('Stale Dialog');
      seeded.push(customer);
      const note = `Typed note ${randomUUID().slice(0, 6)}`;
      await page.goto(`/customers/${customer.id}`);
      await waitForPageHydration(page);
      await page
        .getByRole('button', { name: t('customers.profile.flagCard.set'), exact: true })
        .click();
      // The title turns into "Change the flag" once the reload shows the other session's flag.
      const dialog = page.getByRole('dialog', { name: t('customers.flagging.set.title') });
      await dialog.getByRole('radio', { name: t('customers.flag.refuser') }).click();
      await dialog.getByLabel(t('customers.flagging.set.note')).fill(note);

      // Another session flags the same customer while the dialog is open.
      await flagInDatabase(customer.pool, customer.id, 'fake');

      await dialog.getByRole('button', { name: t('customers.flagging.set.submit') }).click();
      await expect(dialog.getByRole('alert')).toHaveText(
        t('customers.flagging.errors.STALE_RECORD'),
      );
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel(t('customers.flagging.set.note'))).toHaveValue(note);
      await expect(dialog.getByRole('radio', { name: t('customers.flag.refuser') })).toBeChecked();
      await expectNoAxeViolations(page);

      // The profile reloaded behind it, so the same input now saves.
      await dialog.getByRole('button', { name: t('customers.flagging.set.submit') }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole('region', { name: t('customers.profile.flagCard.title') }).getByText(note),
      ).toBeVisible();
      // The header names who set it and when, and the search row carries the badge.
      const card = page.getByRole('region', { name: t('customers.profile.flagCard.title') });
      await expect(card.getByText(agent?.name ?? 'missing')).toBeVisible();
      await expect(card.getByText(t('customers.profile.flagCard.setOn'))).toBeVisible();
      await expect(card.getByText(t('customers.flagSource.manual'))).toBeVisible();
    });

    test('a flag held only by a merged record shows on the survivor and in the flagged list', async ({
      page,
    }) => {
      const survivor = await seedCustomer('Survivor Flag');
      seeded.push(survivor);
      const merged = await seedCustomer('Absorbed Flag', { mergedInto: survivor.id, fake: true });
      seeded.push(merged);

      await page.goto(`/customers/${survivor.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await waitForPageHydration(page);
      const card = page.getByRole('region', { name: t('customers.profile.flagCard.title') });
      await expect(card.getByText(t('customers.flag.fake'))).toBeVisible();
      await expectNoAxeViolations(page);

      await page.goto('/customers');
      await waitForPageHydration(page);
      await page.getByRole('button', { name: t('customers.search.flaggedShow') }).click();
      const table = page.getByRole('table', { name: t('customers.search.tableLabel') });
      const row = table.getByRole('row').filter({ hasText: survivor.name });
      const more = page.getByRole('button', { name: t('customers.search.loadMore') });
      for (let i = 0; i < 20 && (await row.count()) === 0 && (await more.isVisible()); i++) {
        await more.click();
      }
      await expect(row.getByText(t('customers.flag.fake'))).toBeVisible();
    });

    test('every control of the set dialog stays in view and uncovered by keyboard', async ({
      page,
    }) => {
      const customer = await seedCustomer('Focus Dialog');
      seeded.push(customer);
      await page.goto(`/customers/${customer.id}`);
      await waitForPageHydration(page);
      await page
        .getByRole('button', { name: t('customers.profile.flagCard.set'), exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: t('customers.flagging.set.title') });
      await expect(dialog).toBeVisible();
      for (let i = 0; i < 9; i++) {
        await page.keyboard.press('Tab');
        await expectFocusInView(page);
        expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: t('customers.profile.flagCard.set'), exact: true }),
      ).toBeFocused();
    });
  });
}
