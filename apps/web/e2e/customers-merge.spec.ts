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

// Spec 0014 milestone 2 (AC-7, AC-8, AC-9, AC-18): a support person finds two customers by phone on
// /customers/merge, merges them with the older record kept, and undoes the merge from the toast by
// keyboard; undoes a merge from the profile; and merges or dismisses a pair from the To review
// tab. The screens read in English and Arabic and pass axe (WCAG 2.2 AA). A merge is append only
// in the database, so merged customers stay (their names are unique to the run).

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** One pair of customers: the older record first, each with a phone, and the pool that seeded them. */
interface SeededPair {
  olderId: string;
  newerId: string;
  olderName: string;
  newerName: string;
  olderPhone: string;
  newerPhone: string;
  /** The id of the open suggestion for the pair, when one was asked for. */
  suggestionId: string | null;
  /** The merge state read back from the database. */
  mergedIntoOf(id: string): Promise<string | null>;
  suggestionStatus(): Promise<string | null>;
  remove(): Promise<void>;
}

/** Inserts two customers, 30 days apart, with a phone each, and optionally an open suggestion. */
async function seedPair(withSuggestion: boolean): Promise<SeededPair> {
  const tag = randomUUID().slice(0, 8);
  const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const olderPhone = `+2010${digits()}`;
  const newerPhone = `+2011${digits()}`;
  const olderName = `Mona Older ${tag}`;
  const newerName = `Mona Newer ${tag}`;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const one = async (sql: string, params: unknown[]) => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    const id = rows[0]?.id;
    if (!id) throw new Error('Seed insert returned no id');
    return id;
  };
  const olderId = await one(
    `INSERT INTO customers (name, created_at) VALUES ($1, now() - interval '30 days') RETURNING id`,
    [olderName],
  );
  const newerId = await one(`INSERT INTO customers (name) VALUES ($1) RETURNING id`, [newerName]);
  await pool.query(
    `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
     VALUES ($1, $2, 'mobile', true)`,
    [olderId, olderPhone],
  );
  const newerPhoneId = await one(
    `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
     VALUES ($1, $2, 'mobile', true) RETURNING id`,
    [newerId, newerPhone],
  );
  let suggestionId: string | null = null;
  if (withSuggestion) {
    const [low, high] = olderId < newerId ? [olderId, newerId] : [newerId, olderId];
    suggestionId = await one(
      `INSERT INTO customer_merge_suggestions
         (customer_low_id, customer_high_id, reason, evidence_phone_id)
       VALUES ($1, $2, 'second_phone_conflict', $3) RETURNING id`,
      [low, high, newerPhoneId],
    );
  }
  return {
    olderId,
    newerId,
    olderName,
    newerName,
    olderPhone,
    newerPhone,
    suggestionId,
    async mergedIntoOf(id) {
      const { rows } = await pool.query<{ merged_into_id: string | null }>(
        `SELECT merged_into_id FROM customers WHERE id = $1`,
        [id],
      );
      return rows[0]?.merged_into_id ?? null;
    },
    async suggestionStatus() {
      if (!suggestionId) return null;
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM customer_merge_suggestions WHERE id = $1`,
        [suggestionId],
      );
      return rows[0]?.status ?? null;
    },
    async remove() {
      try {
        // Best effort: a merged customer is named by append only rows and stays.
        if (suggestionId) {
          await pool.query(`DELETE FROM customer_merge_suggestions WHERE id = $1`, [suggestionId]);
        }
        for (const id of [olderId, newerId]) {
          await pool.query(`DELETE FROM customer_phones WHERE customer_id = $1`, [id]);
          await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
        }
      } catch {
        // kept on purpose
      } finally {
        await pool.end();
      }
    },
  };
}

/** Fills the slot's search box with a phone and chooses the customer it finds. */
async function pickByPhone(page: Page, slot: 'first' | 'second', phone: string, name: string) {
  await page.locator(`#merge-picker-${slot}`).fill(phone);
  await page.locator(`#merge-picker-${slot}`).press('Enter');
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const fill = (key: Parameters<typeof textFor>[1], values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      t(key),
    );

  test.describe(`customer merge in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let agent: SeededAccount | undefined;
    let pair: SeededPair | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      agent = await seedAccount({ hats: ['support'], language: dir === 'rtl' ? 'ar' : 'en' });
      await signInThroughApi(context, agent, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const person = agent;
      const seeded = pair;
      agent = undefined;
      pair = undefined;
      await seeded?.remove();
      // A person who merged is named by append only rows, so that account may stay.
      await person?.remove().catch(() => undefined);
    });

    test('finds two customers by phone, merges, and undoes from the toast by keyboard', async ({
      page,
    }) => {
      pair = await seedPair(false);
      const seeded = pair;

      await page.goto('/customers/merge');
      await expect(
        page.getByRole('heading', { level: 1, name: t('customers.merge.title') }),
      ).toBeVisible();
      await waitForPageHydration(page);
      await expectNoAxeViolations(page);

      // The newer record goes in the first slot: the older one must still be preselected.
      await pickByPhone(page, 'first', seeded.newerPhone, seeded.newerName);
      await pickByPhone(page, 'second', seeded.olderPhone, seeded.olderName);
      const radios = page.getByRole('radio', { name: t('customers.merge.compare.keep') });
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(1)).toBeChecked();
      await expect(radios.nth(0)).not.toBeChecked();
      expect(new URL(page.url()).search).toBe('');
      await expectNoAxeViolations(page);

      // Swap moves the keep choice to the newer record, and swapping back restores the older.
      const swap = page.getByRole('button', {
        name: t('customers.merge.compare.swap'),
        exact: true,
      });
      await swap.click();
      await expect(radios.nth(0)).toBeChecked();
      await swap.click();
      await expect(radios.nth(1)).toBeChecked();

      // Merge by keyboard.
      const submit = page.getByRole('button', { name: t('customers.merge.submit'), exact: true });
      await submit.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/customers/${seeded.olderId}`);
      await expect(page.getByRole('heading', { level: 1, name: seeded.olderName })).toBeVisible();
      await expect(page.getByText(t('customers.merge.done'))).toBeVisible();
      expect(await seeded.mergedIntoOf(seeded.newerId)).toBe(seeded.olderId);
      await expectNoAxeViolations(page);

      // Undo from the toast: Alt+T moves focus into the notifications, Tab reaches the button.
      await page.keyboard.press('Alt+KeyT');
      const undo = page.getByRole('button', { name: t('customers.merge.undo'), exact: true });
      for (
        let step = 0;
        step < 4 && !(await undo.evaluate((el) => el === document.activeElement));
        step++
      ) {
        await page.keyboard.press('Tab');
      }
      await expect(undo).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('customers.merge.undone'))).toBeVisible();
      await expect.poll(() => seeded.mergedIntoOf(seeded.newerId)).toBeNull();
    });

    // WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum, AA): on a phone the merge toast stays for
    // 15 s over the page bottom. No focused element may be entirely hidden behind it.
    test('the merge toast never hides a focused element on a phone (WCAG 2.4.11)', async ({
      page,
      viewport,
    }) => {
      test.skip((viewport?.width ?? 0) >= 1000, 'a phone sized screen only');
      pair = await seedPair(false);
      const seeded = pair;
      await page.goto(`/customers/merge?a=${seeded.olderId}&b=${seeded.newerId}`);
      await waitForPageHydration(page);
      await expect(
        page.getByRole('radio', { name: t('customers.merge.compare.keep') }),
      ).toHaveCount(2);
      await page.getByRole('button', { name: t('customers.merge.submit'), exact: true }).click();
      await expect(page).toHaveURL(`/customers/${seeded.olderId}`);
      await expect(page.getByText(t('customers.merge.done'))).toBeVisible();

      const hidden: string[] = [];
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      for (let step = 0; step < 40; step++) {
        await page.keyboard.press('Tab');
        const verdict = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const toast = document.querySelector('[data-sonner-toast]');
          if (!toast || el.closest('[data-sonner-toast]')) return { name: '', hidden: false };
          const a = el.getBoundingClientRect();
          const b = toast.getBoundingClientRect();
          const covered =
            a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
          return {
            name: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).slice(0, 40),
            hidden: covered,
          };
        });
        if (verdict?.hidden) hidden.push(verdict.name);
      }
      expect(hidden, 'focused elements entirely behind the toast').toEqual([]);
    });

    test('opens prefilled from the address and undoes from the profile', async ({ page }) => {
      pair = await seedPair(false);
      const seeded = pair;

      await page.goto(`/customers/merge?a=${seeded.olderId}&b=${seeded.newerId}`);
      await expect(
        page.getByRole('heading', { level: 1, name: t('customers.merge.title') }),
      ).toBeVisible();
      await waitForPageHydration(page);
      const radios = page.getByRole('radio', { name: t('customers.merge.compare.keep') });
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(0)).toBeChecked();
      await expect(page.getByText(t('customers.merge.compare.older'))).toBeVisible();
      await expectNoAxeViolations(page);

      await page.getByRole('button', { name: t('customers.merge.submit'), exact: true }).click();
      await expect(page).toHaveURL(`/customers/${seeded.olderId}`);

      // The merge is listed on the profile with its Undo.
      const merges = page.getByRole('region', { name: t('customers.profile.merges.title') });
      await expect(merges.getByText(seeded.newerName)).toBeVisible();
      await expectNoAxeViolations(page);
      // By keyboard: on a phone the merge toast covers the bottom of the page, so a tap would land on it.
      const profileUndo = merges.getByRole('button', {
        name: fill('customers.profile.merges.undoLabel', { name: seeded.newerName }),
      });
      await profileUndo.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('customers.merge.undone'))).toBeVisible();
      await expect(merges).toHaveCount(0);
      expect(await seeded.mergedIntoOf(seeded.newerId)).toBeNull();
    });

    test('the To review tab merges one pair with one tap and dismisses another', async ({
      page,
    }) => {
      pair = await seedPair(true);
      const seeded = pair;
      const second = await seedPair(true);

      try {
        await page.goto('/customers');
        await expect(
          page.getByRole('heading', { level: 1, name: t('customers.title') }),
        ).toBeVisible();
        await waitForPageHydration(page);
        const review = page.getByRole('tab', {
          name: new RegExp(`^${t('customers.tabs.review')}`),
        });
        await review.click();
        const table = page.getByRole('table', { name: t('customers.review.tableLabel') });
        const rowFor = async (name: string) => {
          const row = table.getByRole('row').filter({ hasText: name });
          const more = page.getByRole('button', { name: t('customers.review.loadMore') });
          for (let i = 0; i < 20 && (await row.count()) === 0 && (await more.isVisible()); i++) {
            await more.click();
          }
          return row;
        };
        await expect(table).toBeVisible();
        await expectNoAxeViolations(page);

        // Dismiss the second pair: it leaves the list.
        const names = { first: second.olderName, second: second.newerName };
        const toDismiss = await rowFor(second.olderName);
        await expect(toDismiss).toBeVisible();
        await toDismiss
          .getByRole('button', { name: fill('customers.review.dismissLabel', names) })
          .click();
        await expect(page.getByText(t('customers.review.dismissed'))).toBeVisible();
        await expect(table.getByRole('row').filter({ hasText: second.olderName })).toHaveCount(0);
        expect(await second.suggestionStatus()).toBe('dismissed');

        // Merge the first pair: the merge page opens with both records and the suggestion.
        const row = await rowFor(seeded.olderName);
        await row
          .getByRole('link', {
            name: fill('customers.review.mergeLabel', {
              first: seeded.olderName,
              second: seeded.newerName,
            }),
          })
          .click();
        await expect(page).toHaveURL(/\/customers\/merge\?a=.+&b=.+&s=.+/);
        const radios = page.getByRole('radio', { name: t('customers.merge.compare.keep') });
        await expect(radios).toHaveCount(2);
        await expect(radios.nth(0)).toBeChecked();
        await expectNoAxeViolations(page);
        await page.getByRole('button', { name: t('customers.merge.submit'), exact: true }).click();
        await expect(page).toHaveURL(`/customers/${seeded.olderId}`);
        expect(await seeded.suggestionStatus()).toBe('applied');
      } finally {
        await second.remove();
      }
    });
  });

  test.describe(`customer merge undone from the audit screen in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let manager: SeededAccount | undefined;
    let pair: SeededPair | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      manager = await seedAccount({
        hats: ['support', 'manager'],
        language: dir === 'rtl' ? 'ar' : 'en',
      });
      await signInThroughApi(context, manager, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const person = manager;
      const seeded = pair;
      manager = undefined;
      pair = undefined;
      await seeded?.remove();
      await person?.remove().catch(() => undefined);
    });

    // Milestone 2 done when: an undo from /audit of a merge made on /customers/merge restores both
    // records (spec 0014 AC-8, spec 0010 AC-14).
    test('undoes a merge made on the merge screen from /audit and restores both records', async ({
      page,
    }) => {
      pair = await seedPair(false);
      const seeded = pair;

      await page.goto(`/customers/merge?a=${seeded.olderId}&b=${seeded.newerId}`);
      await waitForPageHydration(page);
      await expect(
        page.getByRole('radio', { name: t('customers.merge.compare.keep') }),
      ).toHaveCount(2);
      await page.getByRole('button', { name: t('customers.merge.submit'), exact: true }).click();
      await expect(page).toHaveURL(`/customers/${seeded.olderId}`);
      expect(await seeded.mergedIntoOf(seeded.newerId)).toBe(seeded.olderId);

      // The merged record's entry carries the undo.
      await page.goto(`/audit?recordType=customer&recordId=${seeded.newerId}`);
      const row = page.getByRole('button', { name: new RegExp(t('audit.actions.customerMerged')) });
      await expect(row.first()).toBeVisible();
      await row.first().focus();
      await page.keyboard.press('Enter');
      const detail = page.getByRole('dialog', { name: t('audit.actions.customerMerged') });
      const undo = detail.getByRole('button', { name: t('audit.undo.button') });
      await expect(undo).toBeVisible();
      await undo.focus();
      await page.keyboard.press('Enter');

      await page.locator('#undo-reason').selectOption('wrong_merge');
      await page.getByRole('button', { name: t('audit.undo.confirm'), exact: true }).click();
      await expect(detail.getByText(t('audit.undo.undoneNotice'))).toBeVisible();

      // Both records are canonical again, and the profile of the merged one opens as itself.
      expect(await seeded.mergedIntoOf(seeded.newerId)).toBeNull();
      expect(await seeded.mergedIntoOf(seeded.olderId)).toBeNull();
      await page.goto(`/customers/${seeded.newerId}`);
      await expect(page.getByRole('heading', { level: 1, name: seeded.newerName })).toBeVisible();
      await expect(page).toHaveURL(`/customers/${seeded.newerId}`);
    });
  });

  test.describe(`customer merge without permission in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      person = await seedAccount({ hats: ['media_buyer'], language: dir === 'rtl' ? 'ar' : 'en' });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = person;
      person = undefined;
      await done?.remove();
    });

    test('gets the no access state on the merge page and asks for no customer data', async ({
      page,
    }) => {
      const requests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/customers')) requests.push(path);
      });

      await page.goto(`/customers/merge?a=${randomUUID()}&b=${randomUUID()}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(t('access.noAccess.title'))).toBeVisible();
      await expectNoAxeViolations(page);
      expect(requests).toEqual([]);
    });
  });
}
