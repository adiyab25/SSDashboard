import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { type SeededAccount } from './accounts';
import { STORAGE_STATE, ownerDatabaseUrl } from './auth';
import { api, createSku } from './master-data-api';
import { expectNoAxeViolations, textFor } from './support';
import {
  COMBINATIONS,
  button,
  enterAsNewManager,
  measureFields,
  measureFocusRings,
  measureNotedTables,
  openDialogBy,
  openPath,
  settleAnimations,
  shot,
  walk,
  type Screen,
  type Translate,
} from './look-support';

// Spec 0025 milestone M5 (AC-6, AC-8, AC-20, AC-21, AC-22, decisions 13 and 14): the customers
// search and review screens, the customer profile with its flag dialogs, the merge screen, and the
// two connections screens in the Midnight look, measured in a real browser at 1280px. Every
// screen (and each state of it that paints different controls: results, review rows, dialogs, the
// picker, the filled and same-customer merge, an invalid form) gets axe in dark and light, English
// and Arabic. Each test signs in as its own manager so the 30 a minute search throttle is never
// shared. Set SHOT_DIR to also save screenshots.

const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

interface Seed {
  tag: string;
  /** Two refused orders, a second phone, a channel id, and a customer merged into her. */
  signal: { id: string; name: string; local: string; mergedId: string };
  /** Flagged (the clear flag dialog). */
  flagged: { id: string; name: string };
  /** Plain and unflagged (the set flag dialog and the same customer merge). */
  plain: { id: string; name: string; phone: string };
  /** Two open merge suggestions: the pairs listed on the review tab. */
  pairs: { firstId: string; secondId: string; firstName: string; secondName: string }[];
  cleanup: () => Promise<void>;
}

let seed: Seed | undefined;
const accounts: SeededAccount[] = [];

function seeded(): Seed {
  if (!seed) throw new Error('no seed');
  return seed;
}

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const request: APIRequestContext = await playwright.request.newContext({
    baseURL: baseURL ?? origin,
    storageState: STORAGE_STATE,
    extraHTTPHeaders: { origin },
  });
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const customerIds: string[] = [];
  const suggestionIds: string[] = [];
  const one = async (sql: string, params: unknown[] = []) => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    const id = rows[0]?.id;
    if (!id) throw new Error('Seed query returned no id');
    return id;
  };
  const phone = () => `+2010${digits()}`;
  const makeCustomer = async (name: string, createdDaysAgo = 0) => {
    const id = await one(
      `INSERT INTO customers (name, created_at) VALUES ($1, now() - make_interval(days => $2::int)) RETURNING id`,
      [name, createdDaysAgo],
    );
    customerIds.push(id);
    const number = phone();
    await pool.query(
      `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary) VALUES ($1, $2, 'mobile', true)`,
      [id, number],
    );
    return { id, phone: number };
  };
  try {
    // The customer with a history: two refused orders make the returner signal.
    const signalName = `Look Mona ${tag}`;
    const local = `010${digits()}`;
    const storeId = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    const channelId = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    const code = `LKC-${tag}`;
    const sku = await createSku(request, code, { en: `Tee ${code}`, ar: `قميص ${code}` }, '570.00');
    const orderIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const made = await api(request, 'POST', '/orders', {
        clientRef: randomUUID(),
        storeId,
        channelId,
        shipTo: { name: signalName, phone: local, address: '12 Look Street, Cairo' },
        lines: [{ variantId: sku.id, quantity: 1, unitPrice: '570.00' }],
        shippingChargedAmount: '50.00',
        paymentMethod: 'cod',
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      orderIds.push(String(made.body['id']));
    }
    const signalId = await one(`SELECT customer_id AS id FROM orders WHERE id = $1::uuid`, [
      orderIds[0],
    ]);
    customerIds.push(signalId);
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
    await pool.query(
      `INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
       VALUES ($1::uuid, $2, 'mobile', false)`,
      [signalId, `+2011${digits()}`],
    );
    const partnerChannel = await one(
      `INSERT INTO channels (code, name, kind) VALUES ($1, $2, 'manual') RETURNING id`,
      [`LK-${tag}`, JSON.stringify({ en: `Look Showroom ${tag}`, ar: `معرض ${tag}` })],
    );
    await pool.query(
      `INSERT INTO customer_external_ids (customer_id, kind, channel_id, external_id)
       VALUES ($1::uuid, 'partner_reference', $2::uuid, $3)`,
      [signalId, partnerChannel, `REF-${tag}`],
    );
    const merged = await makeCustomer(`Look Dup ${tag}`);
    const mergeResult = await api(request, 'POST', '/customers/merges', {
      survivorId: signalId,
      mergedId: merged.id,
      reasonCode: 'same_person',
    });
    expect(mergeResult.status, JSON.stringify(mergeResult.body)).toBe(201);

    // A flagged customer, flagged through the api so the profile shows the flag and its clear action.
    const flagged = await makeCustomer(`Look Flagged ${tag}`);
    const profile = await request.get(`/api/customers/${flagged.id}`);
    expect(profile.status()).toBe(200);
    const stamp = ((await profile.json()) as { updatedAt: string }).updatedAt;
    const flagResponse = await request.fetch(`/api/customers/${flagged.id}/flag`, {
      method: 'PUT',
      headers: { origin },
      data: { kind: 'refuser', reasonCode: 'repeated_refusals', expectedUpdatedAt: stamp },
    });
    expect(flagResponse.status(), await flagResponse.text()).toBeLessThan(300);

    const plain = await makeCustomer(`Look Plain ${tag}`);

    // Two open suggestions; the first pair also feeds the filled merge screen.
    const pairs: Seed['pairs'] = [];
    for (let i = 0; i < 2; i += 1) {
      const firstName = `Look Older ${i} ${tag}`;
      const secondName = `Look Newer ${i} ${tag}`;
      const first = await makeCustomer(firstName, 30);
      const second = await makeCustomer(secondName);
      const phoneId = await one(`SELECT id FROM customer_phones WHERE customer_id = $1`, [
        second.id,
      ]);
      const [low, high] = first.id < second.id ? [first.id, second.id] : [second.id, first.id];
      suggestionIds.push(
        await one(
          `INSERT INTO customer_merge_suggestions
             (customer_low_id, customer_high_id, reason, evidence_phone_id)
           VALUES ($1, $2, 'second_phone_conflict', $3) RETURNING id`,
          [low, high, phoneId],
        ),
      );
      pairs.push({ firstId: first.id, secondId: second.id, firstName, secondName });
    }
    seed = {
      tag,
      signal: { id: signalId, name: signalName, local, mergedId: merged.id },
      flagged: { id: flagged.id, name: `Look Flagged ${tag}` },
      plain: { id: plain.id, name: `Look Plain ${tag}`, phone: plain.phone },
      pairs,
      cleanup: async () => {
        // Best effort: merges, flags, and orders are append only and name some of these rows.
        for (const id of suggestionIds) {
          await pool
            .query(`DELETE FROM customer_merge_suggestions WHERE id = $1`, [id])
            .catch(() => undefined);
        }
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  } finally {
    await request.dispose();
  }
});

test.afterAll(async () => {
  await seed?.cleanup();
});

test.afterEach(async () => {
  while (accounts.length > 0)
    await accounts
      .pop()
      ?.remove()
      .catch(() => undefined);
});

const POPULATED = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Working Brand',
      provider: 'shopify',
      storeCode: 'WB',
      status: 'active',
      health: 'ok',
      healthReason: null,
      healthWarnings: ['SHOP_TIMEZONE_DIFFERS'],
      freshness: { lastInboundAt: null, lastOrderAt: null, lastSweepAt: null },
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'New Brand',
      provider: 'shopify',
      storeCode: 'NB',
      status: 'active',
      health: 'connecting',
      healthReason: null,
      healthWarnings: [],
      freshness: { lastInboundAt: null, lastOrderAt: null, lastSweepAt: null },
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Broken Brand',
      provider: 'shopify',
      storeCode: 'BB',
      status: 'active',
      health: 'failing',
      healthReason: 'APP_NOT_INSTALLED',
      healthWarnings: [],
      freshness: { lastInboundAt: null, lastOrderAt: null, lastSweepAt: null },
    },
  ],
  nextCursor: null,
};

/** Answers the connections list with three rows, in the browser only (nothing reaches Shopify). */
async function mockPopulatedConnections(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/connections',
    (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: POPULATED }) : route.fallback(),
  );
}

const waitRow = async (page: Page, label: string, name: string) => {
  const table = page.getByRole('table', { name: label });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: name })).toBeVisible();
};

const SCREENS: Screen[] = [
  {
    tag: 'customers-search',
    path: () => '/customers',
    ready: async (page, t) => {
      await expect(page.locator('#customer-search:visible').first()).toBeVisible();
      await expect(
        page.getByRole('tab', { name: new RegExp(`^${t('customers.tabs.search')}`) }),
      ).toBeVisible();
    },
    blends: 1,
    steps: [
      {
        tag: 'results',
        run: async (page, _dir, t) => {
          await page.locator('#customer-search:visible').first().fill(seeded().signal.local);
          await button(page, t('customers.search.submit')).click();
          await waitRow(page, t('customers.search.tableLabel'), seeded().signal.name);
        },
      },
      {
        tag: 'flagged',
        run: async (page, _dir, t) => {
          await button(page, t('customers.search.flaggedShow')).click();
          await waitRow(page, t('customers.search.tableLabel'), seeded().flagged.name);
        },
      },
    ],
  },
  {
    tag: 'customers-review',
    path: () => '/customers',
    ready: async (page, t) => {
      await expect(
        page.getByRole('tab', { name: new RegExp(`^${t('customers.tabs.review')}`) }),
      ).toBeVisible();
    },
    blends: 1,
    steps: [
      {
        tag: 'review-tab',
        run: async (page, _dir, t) => {
          await openReview(page, t);
          await waitRow(page, t('customers.review.tableLabel'), seeded().pairs[0]!.firstName);
        },
      },
      {
        tag: 'review-error',
        run: async (page, dir, t) => {
          await page.route(
            (url) => /\/api\/customers\/merge-suggestions\/[^/]+\/dismiss$/.test(url.pathname),
            (route) =>
              route.fulfill({ status: 500, json: { code: 'INTERNAL', message: 'failed' } }),
          );
          await openReview(page, t);
          const pair = seeded().pairs[1]!;
          await waitRow(page, t('customers.review.tableLabel'), pair.firstName);
          const row = page
            .getByRole('table', { name: t('customers.review.tableLabel') })
            .getByRole('row')
            .filter({ hasText: pair.firstName });
          await row
            .getByRole('button', {
              name: textFor(dir, 'customers.review.dismissLabel')
                .replace('{{first}}', pair.firstName)
                .replace('{{second}}', pair.secondName),
            })
            .click();
          await expect(row.getByRole('alert')).toBeVisible();
        },
      },
    ],
  },
  {
    tag: 'profile',
    path: () => `/customers/${seeded().signal.id}`,
    ready: async (page, t) => {
      await expect(
        page.getByRole('region', { name: t('customers.profile.signal.title') }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: t('customers.profile.timeline.title') })
          .getByRole('listitem')
          .first(),
      ).toBeVisible();
    },
    blends: 1,
    steps: [],
  },
  {
    tag: 'profile-merged',
    path: () => `/customers/${seeded().signal.mergedId}`,
    ready: async (page, t) => {
      await expect(page.getByText(t('customers.profile.merged'))).toBeVisible();
    },
    blends: 1,
    steps: [],
  },
  {
    tag: 'profile-plain',
    path: () => `/customers/${seeded().plain.id}`,
    ready: async (page, t) => {
      await expect(button(page, t('customers.profile.flagCard.set'))).toBeVisible();
    },
    blends: 0,
    steps: [
      {
        tag: 'set-flag',
        scope: '[role="dialog"]',
        run: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('customers.profile.flagCard.set')));
        },
      },
      {
        tag: 'set-flag-invalid',
        scope: '[role="dialog"]',
        run: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('customers.profile.flagCard.set')));
          await page
            .getByRole('dialog')
            .getByRole('button', { name: t('customers.flagging.set.submit') })
            .click();
          await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
        },
      },
    ],
  },
  {
    tag: 'profile-flagged',
    path: () => `/customers/${seeded().flagged.id}`,
    ready: async (page, t) => {
      await expect(button(page, t('customers.profile.flagCard.clear'))).toBeVisible();
    },
    blends: 0,
    steps: [
      {
        tag: 'clear-flag',
        scope: '[role="dialog"]',
        run: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('customers.profile.flagCard.clear')));
        },
      },
      {
        tag: 'clear-flag-invalid',
        scope: '[role="dialog"]',
        run: async (page, _dir, t) => {
          await openDialogBy(page, button(page, t('customers.profile.flagCard.clear')));
          await page
            .getByRole('dialog')
            .getByRole('button', { name: t('customers.flagging.clear.submit') })
            .click();
          await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
        },
      },
    ],
  },
  {
    tag: 'merge-empty',
    path: () => '/customers/merge',
    ready: async (page) => {
      await expect(page.locator('#merge-picker-first:visible').first()).toBeVisible();
      await expect(page.locator('#merge-picker-second:visible').first()).toBeVisible();
    },
    blends: 0,
    steps: [
      {
        tag: 'picker-results',
        run: async (page) => {
          await page.locator('#merge-picker-first:visible').first().fill(seeded().plain.phone);
          await page.locator('#merge-picker-first:visible').first().press('Enter');
          await expect(
            page.getByRole('button', { name: new RegExp(seeded().plain.name) }),
          ).toBeVisible();
        },
      },
    ],
  },
  {
    tag: 'merge-filled',
    path: () => `/customers/merge?a=${seeded().pairs[0]!.firstId}&b=${seeded().pairs[0]!.secondId}`,
    ready: async (page, t) => {
      await expect(
        page.getByRole('radio', { name: t('customers.merge.compare.keep') }),
      ).toHaveCount(2);
    },
    blends: 1,
    steps: [],
  },
  {
    tag: 'merge-same',
    path: () => `/customers/merge?a=${seeded().plain.id}&b=${seeded().plain.id}`,
    ready: async (page, t) => {
      await expect(page.getByText(t('customers.merge.compare.same'))).toBeVisible();
    },
    blends: 0,
    steps: [],
  },
  {
    tag: 'connections',
    path: () => '/connections',
    before: mockPopulatedConnections,
    ready: async (page, t) => {
      await expect(page.getByRole('table', { name: t('connections.tableLabel') })).toBeVisible();
    },
    blends: 1,
    steps: [],
  },
  {
    tag: 'connections-new',
    path: () => '/connections/new',
    ready: async (page) => {
      await expect(page.locator('#connection-label:visible').first()).toBeVisible();
    },
    blends: 1,
    steps: [
      {
        tag: 'invalid',
        run: async (page) => {
          await page.locator('main form button[type="submit"]').click();
          await expect(page.locator('main [aria-invalid="true"]').first()).toBeVisible();
        },
      },
    ],
  },
];

async function openReview(page: Page, t: Translate) {
  const tab = page.getByRole('tab', { name: new RegExp(`^${t('customers.tabs.review')}`) });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

test.describe('axe on every screen and state (AC-22)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS) {
    for (const screen of SCREENS) {
      test(`${screen.tag} and its states: no axe violations in ${tag}`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.setTimeout(150_000);
        accounts.push(await enterAsNewManager(page, context, baseURL, { theme, dir }));
        const failures = await walk(page, screen, dir, async ({ name }) => {
          await expect(page.locator('h1')).toHaveCount(1);
          await expectNoAxeViolations(page);
          await shot(page, `${name}-${tag}`);
        });
        expect(failures).toEqual([]);
      });
    }
  }
});

test.describe('field fill, border, corners, height and focus ring (AC-8, AC-20)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { theme, dir, tag } of COMBINATIONS.filter((c) => c.dir === 'ltr')) {
    for (const screen of SCREENS) {
      test(`fields on ${screen.tag} and its states in ${tag}`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.setTimeout(150_000);
        accounts.push(await enterAsNewManager(page, context, baseURL, { theme, dir }));
        let comboboxes = 0;
        let fieldsSeen = 0;
        const failures = await walk(page, screen, dir, async ({ name, scope }) => {
          const result = await measureFields(page, scope);
          comboboxes += result.comboboxes;
          fieldsSeen += result.fields.length;
          console.log(
            `${name} ${tag}: ${result.fields.length} fields ${JSON.stringify(result.fields.map((f) => `${f.kind}#${f.id}:${f.height}px`))}, role=combobox ${result.comboboxes}`,
          );
          const wrong = result.fields
            .filter((field) => {
              const want = !result.dark && field.onCard ? result.cardColor : result.pageColor;
              return field.fill !== want;
            })
            .map((field) => `${field.id} painted ${field.fill}, onCard ${field.onCard}`);
          expect(wrong, `fill: card ${result.cardColor}, page ${result.pageColor}`).toEqual([]);
          expect(
            result.fields
              .filter(
                (field) =>
                  field.border !== (field.invalid ? result.errorColor : result.inputColor) ||
                  field.borderWidth !== '1px' ||
                  field.radius !== '8px',
              )
              .map(
                (field) =>
                  `${field.id}: border ${field.border} ${field.borderWidth}, radius ${field.radius}; want ${field.invalid ? result.errorColor : result.inputColor} 1px 8px`,
              ),
            'input border and 8px corners',
          ).toEqual([]);
          expect(
            result.fields
              .filter((field) => field.kind !== 'textarea' && field.height !== 40)
              .map((field) => `${field.id} is ${field.height}px`),
            'every input, select and combobox is 40px',
          ).toEqual([]);
          const rings = await measureFocusRings(page, scope);
          expect(
            rings
              .filter(
                (ring) =>
                  ring.style !== 'solid' ||
                  ring.width !== 2 ||
                  ring.offset !== 2 ||
                  ring.color !== ring.ring,
              )
              .map(
                (ring) =>
                  `${ring.id}: ${ring.style} ${ring.width}px offset ${ring.offset} ${ring.color}, want solid 2px offset 2 ${ring.ring}`,
              ),
            'cyan focus ring',
          ).toEqual([]);
        });
        console.log(
          `${screen.tag} ${tag}: role=combobox triggers across the screen and its states: ${comboboxes}`,
        );
        expect(failures).toEqual([]);
        // No screen here holds a combobox trigger (the stock screens' pickers do not exist here).
        expect(comboboxes, `${screen.tag} has no role=combobox trigger`).toBe(0);
        const expectsFields = ![
          'profile',
          'profile-merged',
          'merge-filled',
          'merge-same',
          'connections',
        ].includes(screen.tag);
        if (expectsFields) expect(fieldsSeen, `${screen.tag} has fields`).toBeGreaterThan(0);
      });
    }
  }

  test('the native select in the flag dialogs is the field fill with 40px height in both directions', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    for (const [dir, theme] of [
      ['ltr', 'dark'],
      ['rtl', 'light'],
    ] as const) {
      accounts.push(await enterAsNewManager(page, context, baseURL, { theme, dir }));
      const t: Translate = (key) => textFor(dir, key);
      await openPath(page, `/customers/${seeded().plain.id}`);
      await openDialogBy(page, button(page, t('customers.profile.flagCard.set')));
      const result = await measureFields(page, '[role="dialog"]');
      const select = result.fields.filter((field) => field.kind === 'select');
      expect(select.length, 'the reason select is in the set flag dialog').toBe(1);
      expect(select[0]?.height).toBe(40);
      expect(select[0]?.fill).toBe(result.dark ? result.pageColor : result.cardColor);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('one main action per view (AC-13 and the design rule)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const screen of SCREENS) {
    test(`${screen.tag} has ${screen.blends} main action in main`, async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir: 'ltr' }));
      const failures = await walk(page, screen, 'ltr', async ({ name, scope, base }) => {
        const root = page.locator(scope).first();
        const defaults = await root.locator('[data-slot="button"][data-variant="default"]').count();
        const blends = await root.locator('.gradient-primary').count();
        const variants = await root
          .locator('[data-slot="button"]')
          .evaluateAll((all) => all.map((el) => el.getAttribute('data-variant')));
        console.log(`${name}: default buttons ${defaults}, gradient-primary ${blends}`);
        expect(blends, `${name}: every blend is a default button`).toBe(defaults);
        expect(defaults, `${name}: at most one main action`).toBeLessThanOrEqual(1);
        // Everything else is secondary, outline, ghost, link or destructive.
        for (const variant of variants) {
          expect(['default', 'secondary', 'outline', 'ghost', 'link', 'destructive']).toContain(
            variant,
          );
        }
        if (base) expect(defaults, `${name}: the view's one main action`).toBe(screen.blends);
        // A dialog carries its own submit: the blend, or the destructive clear.
        if (scope === '[role="dialog"]' && name.includes('set-flag')) expect(defaults).toBe(1);
        if (scope === '[role="dialog"]' && name.includes('clear-flag')) expect(defaults).toBe(0);
      });
      expect(failures).toEqual([]);
    });
  }
});

/** The tallest a merge suggestion row may be, in English and Arabic (today 73px and 59px). */
const MERGE_SUGGESTION_ROW_MAX = 80;

/** The same with an error under its action, which wraps in the narrow action column (today 128.5px and 86px). */
const MERGE_SUGGESTION_ERROR_ROW_MAX = 140;

const TABLE_VIEWS = [
  { screen: 'customers-search', step: 'results' },
  { screen: 'customers-search', step: 'flagged' },
  { screen: 'customers-review', step: 'review-tab' },
  { screen: 'customers-review', step: 'review-error' },
  { screen: 'profile', step: null },
  { screen: 'connections', step: null },
] as const;

test.describe('tables: header 44px, lowercase mono heads, rows 40px (AC-11, AC-20, decision 14)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { dir, tag } of [
    { dir: 'ltr', tag: 'dark-en' },
    { dir: 'rtl', tag: 'dark-ar' },
  ] as const) {
    for (const view of TABLE_VIEWS) {
      const name = view.step ? `${view.screen}-${view.step}` : view.screen;
      test(`${name} tables in ${tag}`, async ({ page, context, baseURL }) => {
        test.setTimeout(90_000);
        accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir }));
        const screen = SCREENS.find((entry) => entry.tag === view.screen)!;
        const t: Translate = (key) => textFor(dir, key);
        await screen.before?.(page);
        await openPath(page, screen.path());
        await screen.ready(page, t);
        const step = screen.steps.find((entry) => entry.tag === view.step);
        if (step) await step.run(page, dir, t);
        const looks = await measureNotedTables(page);
        console.log(
          `${name} ${tag}: ${JSON.stringify(looks.map((l) => ({ label: l.label, head: l.heads.map((h) => h.height), rows: l.rows.map((r) => `${Math.round(r.height * 10) / 10}${r.note ? 'n' : ''}`) })))}`,
        );
        const problems: string[] = [];
        const reviewLabel = textFor(dir, 'customers.review.tableLabel');
        expect(looks.length, 'the view has a table').toBeGreaterThan(0);
        for (const look of looks) {
          expect(look.panel, `${look.label} sits in a gradient-card-edge panel`).toBe(true);
          expect(look.radius, `${look.label} panel corners`).toBe('12px');
          expect(look.heads.length).toBeGreaterThan(0);
          for (const head of look.heads) {
            expect(head.height, `${look.label}: header ${head.text}`).toBe(44);
            expect(head.mono, `${head.text} is mono`).toBe(true);
            expect(head.transform, `${head.text} is lowercase`).toBe('lowercase');
            expect(head.weight, `${head.text} weight`).toBe('400');
          }
          expect(look.rows.length, `${look.label} has rows`).toBeGreaterThan(0);
          // Collected, so one tall row does not hide whether a later error is clipped.
          for (const row of look.rows) {
            if (row.clipped) problems.push(`${look.label}: ${row.text} is clipped`);
            if (row.errorVisible === false) {
              problems.push(
                `${look.label}: ${row.text} error is not fully visible: ${row.errorDetail}`,
              );
            }
            // Owner ruling 2026-11-16 (spec 0025 decision 14): a merge suggestion row grows to fit its
            // two-line customer cell (name over phone). It is exempt from 40px but never clipped, and
            // capped so a real regression still fails.
            if (look.label === reviewLabel) {
              const max =
                row.errorVisible === null
                  ? MERGE_SUGGESTION_ROW_MAX
                  : MERGE_SUGGESTION_ERROR_ROW_MAX;
              if (row.height > max) {
                problems.push(`${look.label}: row ${row.text} is ${row.height}px, over ${max}`);
              }
              continue;
            }
            // The error under an action may grow its row, and so may a reason sentence; any other row is 40px.
            if (row.errorVisible === null && !row.note && row.height !== 40) {
              problems.push(`${look.label}: row ${row.text} is ${row.height}px, not 40`);
            }
            if (row.height < 40) problems.push(`${look.label}: row ${row.text} is under 40px`);
          }
        }
        expect(problems, 'table row problems').toEqual([]);
        await shot(page, `${name}-tables-${tag}`);
      });
    }
  }

  test('connections rows without an explanatory sentence are 40px and the sentence rows are not clipped', async ({
    page,
    context,
    baseURL,
  }) => {
    accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir: 'ltr' }));
    await mockPopulatedConnections(page);
    await openPath(page, '/connections');
    const table = page.getByRole('table', { name: textFor('ltr', 'connections.tableLabel') });
    await expect(table).toBeVisible();
    const heights = await table.locator('tbody tr').evaluateAll((rows) =>
      rows.map((row) => ({
        text: (row.textContent ?? '').trim().slice(0, 30),
        height: row.getBoundingClientRect().height,
        sentence: row.querySelector('td p') !== null,
        clippedCells: [...row.querySelectorAll('td')].filter(
          (cell) => cell.scrollHeight > cell.clientHeight + 1,
        ).length,
        // Every sentence lies inside its row's box and is not cut by its own height.
        escaping: [...row.querySelectorAll('td p')].filter((note) => {
          const box = note.getBoundingClientRect();
          const rowBox = row.getBoundingClientRect();
          return (
            box.top < rowBox.top - 1 ||
            box.bottom > rowBox.bottom + 1 ||
            note.scrollHeight > note.clientHeight + 1
          );
        }).length,
      })),
    );
    console.log(`connections rows: ${JSON.stringify(heights)}`);
    expect(
      heights.some((entry) => entry.sentence),
      'a row with a sentence is shown',
    ).toBe(true);
    for (const row of heights) {
      expect(row.clippedCells, `${row.text}: clipped cells`).toBe(0);
      expect(row.escaping, `${row.text}: sentences cut or outside the row`).toBe(0);
    }
    for (const row of heights.filter((entry) => !entry.sentence)) expect(row.height).toBe(40);
  });
});

test.describe('info notices are muted with an "i" icon (AC-10, decision 13)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  const NOTICES = [
    {
      name: 'profile merged notice',
      path: () => `/customers/${seeded().signal.mergedId}`,
      text: 'customers.profile.merged' as const,
    },
    {
      name: 'merge same customer notice',
      path: () => `/customers/merge?a=${seeded().plain.id}&b=${seeded().plain.id}`,
      text: 'customers.merge.compare.same' as const,
    },
  ];
  for (const { theme, dir, tag } of COMBINATIONS) {
    for (const notice of NOTICES) {
      test(`the ${notice.name} is muted-foreground with an info icon in ${tag}`, async ({
        page,
        context,
        baseURL,
      }) => {
        accounts.push(await enterAsNewManager(page, context, baseURL, { theme, dir }));
        await openPath(page, notice.path());
        const alert = page.locator('main [data-slot="alert"]').filter({
          hasText: textFor(dir, notice.text),
        });
        await expect(alert).toBeVisible();
        await settleAnimations(page);
        const look = await alert.evaluate((element) => {
          const probe = (variable: string) => {
            const el = document.createElement('div');
            el.style.color = `var(${variable})`;
            document.body.append(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          const description = element.querySelector('[data-slot="alert-description"]')!;
          const svg = element.querySelector('svg');
          return {
            text: getComputedStyle(description).color,
            icon: svg ? getComputedStyle(svg).color : null,
            iconClass: svg?.getAttribute('class') ?? '',
            iconHidden: svg?.getAttribute('aria-hidden'),
            border: getComputedStyle(element).borderTopColor,
            muted: probe('--muted-foreground'),
            primary: probe('--primary'),
            ring: probe('--ring'),
            warning: probe('--warning'),
            destructive: probe('--destructive'),
          };
        });
        console.log(`${notice.name} ${tag}: ${JSON.stringify(look)}`);
        expect(look.iconClass).toContain('lucide-info');
        expect(look.iconHidden).toBe('true');
        expect(look.text).toBe(look.muted);
        expect(look.icon).toBe(look.muted);
        for (const colour of [look.text, look.icon, look.border]) {
          for (const banned of [look.primary, look.ring, look.warning, look.destructive]) {
            expect(colour).not.toBe(banned);
          }
        }
        await expectNoAxeViolations(page);
      });
    }
  }
});

test.describe('the returner signal panel and the timeline still render (AC-21)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  for (const { dir, tag } of [
    { dir: 'ltr', tag: 'dark-en' },
    { dir: 'rtl', tag: 'dark-ar' },
  ] as const) {
    test(`signal panel, timeline, phones and channel ids on the profile in ${tag}`, async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir }));
      const t: Translate = (key) => textFor(dir, key);
      await openPath(page, `/customers/${seeded().signal.id}`);
      const signal = page.getByRole('region', { name: t('customers.profile.signal.title') });
      await expect(signal).toBeVisible();
      await expect(signal).toContainText('180');
      const flag = t('customers.flag.refuser');
      await expect(
        signal.getByRole('button', {
          name: t('customers.profile.signal.apply').replace('{{flag}}', flag),
        }),
      ).toBeVisible();
      const panel = await signal.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          edge: element.classList.contains('gradient-card-edge'),
          radius: computed.borderTopLeftRadius,
        };
      });
      expect(panel).toEqual({ edge: true, radius: '12px' });

      const timeline = page.getByRole('region', { name: t('customers.profile.timeline.title') });
      await expect(timeline.getByRole('listitem').first()).toBeVisible();
      const merge = timeline.getByRole('listitem').filter({
        has: page.getByText(t('customers.profile.timeline.kind.merge'), { exact: true }),
      });
      await expect(merge).toHaveCount(1);
      await expect(
        timeline.getByRole('link', { name: /^MAIN\/SO-\d{4}-\d+$/ }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole('table', { name: t('customers.profile.phones.tableLabel') }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('table', { name: t('customers.profile.channelIds.tableLabel') })
          .getByText(`REF-${seeded().tag}`),
      ).toBeVisible();
      await shot(page, `profile-signal-${tag}`);
    });
  }

  const applyButton = (page: Page, signal: Locator) => {
    const t: Translate = (key) => textFor('ltr', key);
    return signal.getByRole('button', {
      name: t('customers.profile.signal.apply').replace('{{flag}}', t('customers.flag.refuser')),
    });
  };

  test('a failed apply keeps the panel and the button usable', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir: 'ltr' }));
    const t: Translate = (key) => textFor('ltr', key);
    // Answered in the browser, so the shared signal customer keeps her panel for the other tests.
    let puts = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/api\/customers\/[^/]+\/flag$/.test(request.url())) {
        puts += 1;
      }
    });
    await page.route(
      (url) => /\/api\/customers\/[^/]+\/flag$/.test(url.pathname),
      (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({ status: 500, json: { code: 'INTERNAL', message: 'x' } })
          : route.fallback(),
    );
    await openPath(page, `/customers/${seeded().signal.id}`);
    const signal = page.getByRole('region', { name: t('customers.profile.signal.title') });
    const apply = applyButton(page, signal);
    await expect(apply).toBeVisible();
    await apply.click();
    await expect.poll(() => puts).toBe(1);
    await expect(signal).toBeVisible();
    await expect(apply).toBeEnabled();
    await expect(apply).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('applying the suggested flag sends one PUT and the panel leaves', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir: 'ltr' }));
    const t: Translate = (key) => textFor('ltr', key);
    // A throwaway customer with two refused orders, so the real write can succeed.
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const name = `Look Apply ${tag}`;
    const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
    let customerId: string;
    try {
      const one = async (sql: string, params: unknown[] = []) => {
        const { rows } = await pool.query<{ id: string }>(sql, params);
        const id = rows[0]?.id;
        if (!id) throw new Error('Seed query returned no id');
        return id;
      };
      const storeId = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
      const channelId = await one(`SELECT id FROM channels WHERE code = 'manual'`);
      const code = `LKA-${tag}`;
      const sku = await createSku(
        context.request,
        code,
        { en: `Tee ${code}`, ar: `قميص ${code}` },
        '570.00',
      );
      const orderIds: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const made = await api(context.request, 'POST', '/orders', {
          clientRef: randomUUID(),
          storeId,
          channelId,
          shipTo: { name, phone: `010${digits()}`, address: '12 Look Street, Cairo' },
          lines: [{ variantId: sku.id, quantity: 1, unitPrice: '570.00' }],
          shippingChargedAmount: '50.00',
          paymentMethod: 'cod',
        });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        orderIds.push(String(made.body['id']));
      }
      customerId = await one(`SELECT customer_id AS id FROM orders WHERE id = $1::uuid`, [
        orderIds[0],
      ]);
      // Both orders must belong to one customer: the same phone makes that true for the first only,
      // so point the second order at her as well.
      await pool.query(`UPDATE orders SET customer_id = $1::uuid WHERE id = $2::uuid`, [
        customerId,
        orderIds[1],
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
    } finally {
      await pool.end();
    }
    let puts = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/api\/customers\/[^/]+\/flag$/.test(request.url())) {
        puts += 1;
      }
    });
    await openPath(page, `/customers/${customerId}`);
    const signal = page.getByRole('region', { name: t('customers.profile.signal.title') });
    const apply = applyButton(page, signal);
    await expect(apply).toBeVisible();
    await apply.click();
    await expect.poll(() => puts).toBe(1);
    await expect(signal).toHaveCount(0);
    const flagCard = page.getByRole('region', { name: t('customers.profile.flagCard.title') });
    await expect(flagCard.getByText(t('customers.flag.refuser'))).toBeVisible();
    expect(puts).toBe(1);
  });
});

test.describe('no provisional values on these screens (spec 0025 M5 done when)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop')); // eslint-disable-line no-empty-pattern

  test('no dashed boundary, no approximate sign, and no hidden label shows on any customers or connections screen', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir: 'ltr' }));
    const found: string[] = [];
    for (const screen of SCREENS) {
      const failures = await walk(page, screen, 'ltr', async ({ name }) => {
        const result = await page.locator('main').evaluate((main) => {
          const dashed = [...main.querySelectorAll('*')].filter((element) => {
            const computed = getComputedStyle(element);
            return [
              computed.borderTopStyle,
              computed.borderRightStyle,
              computed.borderBottomStyle,
              computed.borderLeftStyle,
              computed.outlineStyle,
            ].includes('dashed');
          }).length;
          return {
            dashed,
            approx: (main.textContent ?? '').includes('≈'),
            provisional: main.querySelectorAll('[data-provisional]').length,
          };
        });
        if (result.dashed > 0 || result.approx || result.provisional > 0) {
          found.push(`${name}: ${JSON.stringify(result)}`);
        }
      });
      expect(failures).toEqual([]);
    }
    console.log(`provisional values found: ${found.length === 0 ? 'none' : found.join('; ')}`);
    expect(found).toEqual([]);
  });
});

test.describe('one h1 per screen at 1280px', () => {
  test('every restyled screen keeps one h1 with the blend text at 1280px', async ({
    page,
    context,
    baseURL,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    test.setTimeout(120_000);
    accounts.push(await enterAsNewManager(page, context, baseURL, { theme: 'dark', dir: 'ltr' }));
    for (const screen of SCREENS) {
      await screen.before?.(page);
      await openPath(page, screen.path());
      await screen.ready(page, (key) => textFor('ltr', key));
      await expect(page.locator('h1'), screen.tag).toHaveCount(1);
      expect(
        await page.evaluate(() => window.innerWidth),
        'the desktop project is 1280px wide',
      ).toBe(1280);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });
});
