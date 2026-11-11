import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { api, createSku } from './master-data-api';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0014 milestone 4 (AC-7, AC-13, AC-14, AC-15, AC-18): the customer profile shows one
// timeline across orders, a merge, phones, and the flag, 25 a page with Load more; a manager (who
// holds customers.merge, customers.flag, orders.view, and audit.read) undoes the merge from its
// entry, opens its history in the audit screen, and applies the suggested flag in one tap after
// two refused orders; the merge compare shows each customer's order count. Both languages, axe,
// desktop and mobile. Orders, merges, and flags are append only, so the seeded customers stay
// (their names are unique to the run).

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

interface SeededHistory {
  /** The customer the two orders created. */
  customerId: string;
  customerName: string;
  /** A second customer merged into the first. */
  mergedName: string;
  mergedId: string;
  orderIds: string[];
}

/**
 * Creates a customer through two manual orders (refused at the door as the carrier will), 24 extra
 * phones so the timeline needs a second page, and one customer merged into her. Orders go through
 * the real api as the signed in manager; the refusal is written the way the api e2e does it.
 */
async function seedHistory(request: APIRequestContext): Promise<SeededHistory> {
  const tag = randomUUID().slice(0, 8);
  const customerName = `Timeline Mona ${tag}`;
  const mergedName = `Timeline Dup ${tag}`;
  const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const local = `010${digits()}`;
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const one = async (sql: string, params: unknown[] = []) => {
      const { rows } = await pool.query<{ id: string }>(sql, params);
      const id = rows[0]?.id;
      if (!id) throw new Error('Seed query returned no id');
      return id;
    };
    const storeId = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    const channelId = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    const code = `TLN-${tag.toUpperCase()}`;
    const sku = await createSku(request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '570.00');

    const orderIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const made = await api(request, 'POST', '/orders', {
        clientRef: randomUUID(),
        storeId,
        channelId,
        shipTo: { name: customerName, phone: local, address: '12 Timeline Street, Cairo' },
        lines: [{ variantId: sku.id, quantity: 1, unitPrice: '570.00' }],
        shippingChargedAmount: '50.00',
        paymentMethod: 'cod',
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      orderIds.push(String(made.body['id']));
    }
    const customerId = await one(`SELECT customer_id AS id FROM orders WHERE id = $1::uuid`, [
      orderIds[0],
    ]);
    for (const orderId of orderIds) {
      await pool.query(
        `UPDATE orders SET fulfillment_state = 'refused', refused_reason_code = 'size',
                outcome = 'failed_delivery' WHERE id = $1::uuid`,
        [orderId],
      );
      await pool.query(
        `INSERT INTO order_events (order_id, machine, from_state, to_state, actor_type, occurred_at)
         VALUES ($1::uuid, 'fulfillment', 'new', 'refused', 'system_job', now())`,
        [orderId],
      );
    }
    // 24 more phones: 2 orders, 1 primary phone, 24 phones, and the merge are 28 entries, over one page.
    for (let i = 0; i < 24; i += 1) {
      await pool.query(
        `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
         VALUES ($1::uuid, $2, 'mobile', false)`,
        [customerId, `+2011${digits()}`],
      );
    }
    const mergedId = await one(`INSERT INTO customers (name) VALUES ($1) RETURNING id`, [
      mergedName,
    ]);
    await pool.query(
      `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
       VALUES ($1::uuid, $2, 'mobile', true)`,
      [mergedId, `+2012${digits()}`],
    );
    const merged = await api(request, 'POST', '/customers/merges', {
      survivorId: customerId,
      mergedId,
      reasonCode: 'same_person',
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    return { customerId, customerName, mergedName, mergedId, orderIds };
  } finally {
    await pool.end();
  }
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const language = dir === 'rtl' ? 'ar' : 'en';

  test.describe(`customer timeline in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let manager: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      manager = await seedAccount({ hats: ['manager'], language });
      await signInThroughApi(context, manager, baseURL ?? '');
      await useBrowserState(page, { dir });
    });
    test.afterEach(async () => {
      const done = manager;
      manager = undefined;
      // A person who merged or flagged is named by append only audit entries, so that account may stay.
      await done?.remove().catch(() => undefined);
    });

    test('shows the timeline, applies the suggested flag, undoes the merge, and loads more', async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      const seeded = await seedHistory(context.request);
      const toast = page.locator('[data-sonner-toast]');

      await page.goto(`/customers/${seeded.customerId}`);
      await expect(
        page.getByRole('heading', { level: 1, name: seeded.customerName }),
      ).toBeVisible();
      await waitForPageHydration(page);

      const timeline = page.getByRole('region', { name: t('customers.profile.timeline.title') });
      const entries = timeline.getByRole('listitem');
      await expect(entries).toHaveCount(25);
      // The merge entry carries Undo and the audit link for a manager.
      const mergeEntry = entries.filter({
        has: page.getByText(t('customers.profile.timeline.kind.merge'), { exact: true }),
      });
      await expect(mergeEntry).toHaveCount(1);
      await expect(mergeEntry).toContainText(seeded.mergedName);
      await expect(
        mergeEntry.getByRole('link', { name: t('customers.profile.timeline.openInAudit') }),
      ).toHaveAttribute(
        'href',
        new RegExp(`^/audit\\?recordType=customer&recordId=${seeded.mergedId}$`),
      );
      await expectNoAxeViolations(page);

      // The suggestion: two refused orders, no flag yet; one tap applies it.
      const suggestion = page.getByRole('region', { name: t('customers.profile.signal.title') });
      await expect(suggestion).toBeVisible();
      await expect(suggestion).toContainText('180');
      const flagName = t('customers.flag.refuser');
      const apply = suggestion.getByRole('button', {
        name: t('customers.profile.signal.apply').replace('{{flag}}', flagName),
      });
      await apply.focus();
      await page.keyboard.press('Enter');
      await expect(suggestion).toHaveCount(0);
      await expect(
        toast.filter({ hasText: t('customers.flagging.set.saved') }).first(),
      ).toBeVisible();
      const flagCard = page.getByRole('region', { name: t('customers.profile.flagCard.title') });
      await expect(flagCard.getByText(flagName)).toBeVisible();
      // The timeline shows the new flag entry at the top.
      await expect(entries.first()).toContainText(t('customers.profile.timeline.kind.flag'));

      // Undo the merge from its entry.
      await mergeEntry
        .getByRole('button', {
          name: t('customers.profile.merges.undoLabel').replace('{{name}}', seeded.mergedName),
        })
        .click();
      await expect(toast.filter({ hasText: t('customers.merge.undone') }).first()).toBeVisible();
      await expect(
        entries.filter({ hasText: t('customers.profile.timeline.kind.unmerge') }),
      ).toHaveCount(1);
      await expect(
        mergeEntry.getByRole('button', { name: new RegExp(seeded.mergedName) }),
      ).toHaveCount(0);

      // Load more brings the older entries, including the orders with their store and number.
      const loadMore = timeline.getByRole('button', {
        name: t('customers.profile.timeline.loadMore'),
      });
      await loadMore.click();
      const orderLink = timeline.getByRole('link', { name: /^MAIN\/SO-\d{4}-\d+$/ });
      await expect(orderLink).toHaveCount(2);
      await expect(orderLink.first()).toHaveAttribute('href', /\/orders\/[0-9a-f-]{36}$/);
      await expect(loadMore).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);
    });

    test('shows the order count of each customer on the merge compare', async ({
      page,
      context,
    }) => {
      const seeded = await seedHistory(context.request);
      const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
      let plainId: string;
      try {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO customers (name) VALUES ($1) RETURNING id`,
          [`Timeline Plain ${randomUUID().slice(0, 8)}`],
        );
        plainId = rows[0]?.id ?? '';
        await pool.query(
          `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
           VALUES ($1::uuid, $2, 'mobile', true)`,
          [plainId, `+2015${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`],
        );
      } finally {
        await pool.end();
      }

      await page.goto(`/customers/merge?a=${seeded.customerId}&b=${plainId}`);
      await waitForPageHydration(page);
      const orders = (count: string) =>
        t('customers.merge.card.orders').replace('{{number}}', count);
      await expect(page.getByText(orders('2'), { exact: true })).toBeVisible();
      await expect(page.getByText(orders('0'), { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);
    });
  });
}
