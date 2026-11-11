import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
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

// Spec 0014 milestone 3 (AC-11, AC-18): a support person flags a customer with a note by keyboard,
// sees the flag on the profile header and in the flagged search, and clears it with a reason. The
// dialogs read in English and Arabic and pass axe (WCAG 2.2 AA).

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** Inserts one unflagged customer with a phone; returns her id, name, and the cleanup. */
async function seedCustomer() {
  const tag = randomUUID().slice(0, 8);
  const name = `Mona Flagged ${tag}`;
  const phone = `+2012${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (name) VALUES ($1) RETURNING id`,
    [name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Seed insert returned no id');
  await pool.query(
    `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
     VALUES ($1, $2, 'mobile', true)`,
    [id, phone],
  );
  return {
    id,
    name,
    async remove() {
      try {
        // Best effort: a flagged customer is named by append only audit rows and may stay.
        await pool.query(`DELETE FROM customer_phones WHERE customer_id = $1`, [id]);
        await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
      } catch {
        // kept on purpose
      } finally {
        await pool.end();
      }
    },
  };
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`customer flag in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let agent: SeededAccount | undefined;
    let customer: Awaited<ReturnType<typeof seedCustomer>> | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      agent = await seedAccount({ hats: ['support'], language: dir === 'rtl' ? 'ar' : 'en' });
      await signInThroughApi(context, agent, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const person = agent;
      const seeded = customer;
      agent = undefined;
      customer = undefined;
      await seeded?.remove();
      await person?.remove().catch(() => undefined);
    });

    test('sets a flag with a note by keyboard, finds it in the flagged search, and clears it', async ({
      page,
    }) => {
      customer = await seedCustomer();
      const seeded = customer;
      const note = `Refused twice ${randomUUID().slice(0, 6)}`;

      await page.goto(`/customers/${seeded.id}`);
      await expect(page.getByRole('heading', { level: 1, name: seeded.name })).toBeVisible();
      await waitForPageHydration(page);

      // Open the dialog by keyboard.
      const open = page.getByRole('button', {
        name: t('customers.profile.flagCard.set'),
        exact: true,
      });
      await open.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: t('customers.flagging.set.title') });
      await expect(dialog).toBeVisible();
      await expectNoAxeViolations(page);

      // A kind is required.
      await dialog.getByRole('button', { name: t('customers.flagging.set.submit') }).click();
      await expect(dialog.getByRole('alert')).toHaveText(t('customers.flagging.set.kindRequired'));

      // Choose a kind, write a note, pick a reason, and save, all from the keyboard.
      const kind = dialog.getByRole('radio', { name: t('customers.flag.refuser') });
      await kind.focus();
      await page.keyboard.press('Space');
      await expect(kind).toBeChecked();
      await dialog.getByLabel(t('customers.flagging.set.note')).fill(note);
      await dialog.getByLabel(t('customers.flagging.set.reason')).selectOption('repeated_refusals');
      const save = dialog.getByRole('button', { name: t('customers.flagging.set.submit') });
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);

      // The header shows the kind, the source, and the note.
      await expect(
        page.getByRole('region', { name: t('customers.profile.flagCard.title') }).getByText(note),
      ).toBeVisible();
      const flagCard = page.getByRole('region', { name: t('customers.profile.flagCard.title') });
      await expect(flagCard.getByText(t('customers.flag.refuser'))).toBeVisible();
      await expect(flagCard.getByText(t('customers.flagSource.manual'))).toBeVisible();
      await expectNoAxeViolations(page);

      // The flagged search lists her with the flag.
      await page.goto('/customers');
      await waitForPageHydration(page);
      await page.getByRole('button', { name: t('customers.search.flaggedShow') }).click();
      const table = page.getByRole('table', { name: t('customers.search.tableLabel') });
      const row = table.getByRole('row').filter({ hasText: seeded.name });
      const more = page.getByRole('button', { name: t('customers.search.loadMore') });
      for (let i = 0; i < 20 && (await row.count()) === 0 && (await more.isVisible()); i++) {
        await more.click();
      }
      await expect(row.getByText(t('customers.flag.refuser'))).toBeVisible();
      await expectNoAxeViolations(page);

      // Clear it with a required reason.
      await row.getByRole('link', { name: seeded.name }).click();
      await expect(page).toHaveURL(`/customers/${seeded.id}`);
      await page
        .getByRole('button', { name: t('customers.profile.flagCard.clear'), exact: true })
        .click();
      const clearDialog = page.getByRole('dialog', { name: t('customers.flagging.clear.title') });
      await expect(clearDialog).toBeVisible();
      await expectNoAxeViolations(page);
      await clearDialog.getByRole('button', { name: t('customers.flagging.clear.submit') }).click();
      await expect(clearDialog.getByRole('alert')).toHaveText(
        t('customers.flagging.clear.reasonRequired'),
      );
      await clearDialog
        .getByLabel(t('customers.flagging.clear.reason'))
        .selectOption('customer_settled');
      await clearDialog.getByRole('button', { name: t('customers.flagging.clear.submit') }).click();
      await expect(clearDialog).toHaveCount(0);
      await expect(page.getByText(note)).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: t('customers.profile.flagCard.set'), exact: true }),
      ).toBeVisible();
    });
  });
}
