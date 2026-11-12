import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  expectNoAxeViolations,
  openShell,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0014 milestone 1 (AC-3, AC-4, AC-5, AC-18): the /customers search finds one customer
// however her phone is typed (Western or Arabic-Indic digits, local or international form), the
// phone never reaches the address, the profile shows her phones and channel ids, a merged id opens
// the survivor with a notice, and a person without `customers.view` gets the no access state. The
// screens read in English and Arabic and pass axe (WCAG 2.2 AA).

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** The rows one run seeds, with the cleanup that removes them. */
interface SeededCustomers {
  name: string;
  /** The primary phone as the api stores it, and the same number typed three other ways. */
  e164: string;
  local: string;
  international: string;
  arabicDigits: string;
  secondPhone: string;
  survivorId: string;
  mergedId: string;
  channelName: string;
  remove(): Promise<void>;
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Inserts one customer with two phones and a partner reference id, and a second record merged into her. */
async function seedCustomers(): Promise<SeededCustomers> {
  const tag = randomUUID().slice(0, 8);
  const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const e164 = `+2010${digits}`;
  const local = `010${digits}`;
  const secondPhone = `+2011${digits}`;
  const name = `Mona Seeded ${tag}`;
  const channelName = `E2E Showroom ${tag}`;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const one = async (sql: string, params: unknown[]) => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    const id = rows[0]?.id;
    if (!id) throw new Error('Seed insert returned no id');
    return id;
  };
  const survivorId = await one(`INSERT INTO customers (name) VALUES ($1) RETURNING id`, [name]);
  const mergedId = await one(
    `INSERT INTO customers (name, merged_into_id) VALUES ($1, $2) RETURNING id`,
    [`${name} old`, survivorId],
  );
  await pool.query(
    `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
     VALUES ($1, $2, 'mobile', true), ($1, $3, 'mobile', false)`,
    [survivorId, e164, secondPhone],
  );
  const channelId = await one(
    `INSERT INTO channels (code, name, kind) VALUES ($1, $2, 'manual') RETURNING id`,
    [`E2E-${tag}`, JSON.stringify({ en: channelName, ar: channelName })],
  );
  await pool.query(
    `INSERT INTO customer_external_ids (customer_id, kind, channel_id, external_id)
     VALUES ($1, 'partner_reference', $2, $3)`,
    [survivorId, channelId, `REF-${tag}`],
  );
  return {
    name,
    e164,
    local,
    international: `+20 10 ${digits.slice(0, 4)} ${digits.slice(4)}`,
    arabicDigits: local.replace(/\d/g, (digit) => ARABIC_DIGITS[Number(digit)] ?? digit),
    secondPhone,
    survivorId,
    mergedId,
    channelName,
    async remove() {
      try {
        await pool.query(`DELETE FROM customer_external_ids WHERE customer_id = $1`, [survivorId]);
        await pool.query(`DELETE FROM customer_phones WHERE customer_id = $1`, [survivorId]);
        await pool.query(`DELETE FROM customers WHERE id = $1`, [mergedId]);
        await pool.query(`DELETE FROM customers WHERE id = $1`, [survivorId]);
        await pool.query(`DELETE FROM channels WHERE id = $1`, [channelId]);
      } finally {
        await pool.end();
      }
    },
  };
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`customers in ${languageName}`, () => {
    // Search is throttled per person (30 a minute): every test signs in as its own support
    // person, so a test and its retry never share the allowance.
    test.use({ storageState: { cookies: [], origins: [] } });
    let seeded: SeededCustomers | undefined;
    let agent: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      seeded = await seedCustomers();
      agent = await seedAccount({ hats: ['support'], language: dir === 'rtl' ? 'ar' : 'en' });
      await signInThroughApi(context, agent, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = seeded;
      const person = agent;
      seeded = undefined;
      agent = undefined;
      await done?.remove();
      await person?.remove();
    });

    test('searches by phone in any form and opens the profile', async ({ page }) => {
      const customer = seeded;
      if (!customer) throw new Error('not seeded');
      const searchBodies: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/customers/search') {
          searchBodies.push(`${request.method()} ${request.postData() ?? ''}`);
        }
      });

      await page.goto('/customers');
      await expect(
        page.getByRole('heading', { level: 1, name: t('customers.title') }),
      ).toBeVisible();
      await waitForPageHydration(page);
      await expectNoAxeViolations(page);

      const box = page.getByRole('searchbox', { name: t('customers.search.label') });
      const submit = page
        .getByRole('search')
        .getByRole('button', { name: t('customers.search.submit') });
      const table = page.getByRole('table', { name: t('customers.search.tableLabel') });

      // One number, typed four ways, finds the same customer (AC-3).
      for (const typed of [
        customer.local,
        customer.arabicDigits,
        customer.international,
        customer.e164,
      ]) {
        await box.fill(typed);
        await box.press('Enter');
        await expect(table.getByRole('link', { name: customer.name, exact: true })).toBeVisible();
        await expect(table.getByText(customer.e164)).toBeVisible();
      }
      expect(searchBodies.length).toBeGreaterThanOrEqual(4);
      expect(searchBodies.every((entry) => entry.startsWith('POST '))).toBe(true);
      // Neither the typed phone nor the name ever reaches the address (AC-3).
      expect(page.url()).not.toContain(customer.local.slice(3));
      expect(new URL(page.url()).search).toBe('');
      await expectNoAxeViolations(page);

      // A name fragment finds her too, and a bad phone is refused in words.
      await box.fill(customer.name.slice(0, 14));
      await submit.click();
      await expect(table.getByRole('link', { name: customer.name, exact: true })).toBeVisible();
      await box.fill('0100');
      await submit.click();
      await expect(page.locator('#customer-search-error')).toContainText(
        t('customers.search.invalidPhone'),
      );
      await expectNoAxeViolations(page);

      // A search with no answer says so, and passes axe too.
      await box.fill(`Nobody-${randomUUID().slice(0, 8)}`);
      await submit.click();
      await expect(page.getByText(t('customers.search.noMatchTitle'))).toBeVisible();
      await expectNoAxeViolations(page);

      // The profile (AC-4).
      await box.fill(customer.e164);
      await submit.click();
      await table.getByRole('link', { name: customer.name, exact: true }).click();
      await expect(page).toHaveURL(`/customers/${customer.survivorId}`);
      await expect(page.getByRole('heading', { level: 1, name: customer.name })).toBeVisible();
      const phones = page.getByRole('table', { name: t('customers.profile.phones.tableLabel') });
      await expect(phones.getByText(customer.e164)).toBeVisible();
      await expect(phones.getByText(customer.secondPhone)).toBeVisible();
      const ids = page.getByRole('table', { name: t('customers.profile.channelIds.tableLabel') });
      await expect(ids.getByText(customer.channelName)).toBeVisible();
      expect(page.url()).not.toContain('%2B20');
      await expectNoAxeViolations(page);
    });

    test('opens the survivor of a merged id with a notice', async ({ page }) => {
      const customer = seeded;
      if (!customer) throw new Error('not seeded');

      const profileGets: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'GET' && /^\/api\/customers\/[0-9a-f-]{36}$/.test(path)) {
          profileGets.push(path);
        }
      });

      await page.goto(`/customers/${customer.mergedId}`);
      await expect(page.getByRole('heading', { level: 1, name: customer.name })).toBeVisible();
      await expect(
        page.getByRole('status').filter({ hasText: t('customers.profile.merged') }),
      ).toBeVisible();
      await expect(page).toHaveURL(`/customers/${customer.survivorId}`);
      // The address change is answered from the page's own data: one GET, no flash of skeleton.
      await page.waitForTimeout(1000);
      expect(profileGets).toEqual([`/api/customers/${customer.mergedId}`]);
      await expect(page.getByRole('heading', { level: 1, name: customer.name })).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test('is reached from the sidebar by keyboard', async ({ page, isMobile }) => {
      await openShell(page);
      // On a phone the navigation sits behind the menu button.
      if (isMobile) await page.getByRole('button', { name: t('shell.topbar.menu') }).click();
      const link = page.getByRole('link', { name: t('shell.nav.items.customers'), exact: true });
      await expect(link).toBeVisible();
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/customers');
      await expect(
        page.getByRole('heading', { level: 1, name: t('customers.title') }),
      ).toBeVisible();
    });
  });

  test.describe(`a media buyer in ${languageName}`, () => {
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

    test('gets the no access state on both customer pages and asks for no customer data', async ({
      page,
    }) => {
      const requests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/customers')) requests.push(path);
      });

      for (const path of ['/customers', `/customers/${randomUUID()}`]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByText(t('access.noAccess.title'))).toBeVisible();
        await expectNoAxeViolations(page);
      }
      expect(requests).toEqual([]);
    });
  });
}
