import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { MessageKey } from '@ssdashboard/i18n';
import { E2E_ADMIN } from './auth';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0009 milestone 1 (AC-25, AC-26): the /settings screen with the Brand and Policies
// sections. A manager changes a setting with a reason in English and Arabic and the dialog
// refuses without one; a typed confirmation guards the VAT switch; an Operations item is shown
// disabled with the plan it needs (the list is route mocked with that entry not licensed); the screen is axe clean in both languages;
// a person without `settings.manage` gets the no access state and no sidebar entry.
//
// The write tests change `operating_day_cutoff_hour` and `prices_include_vat` (neither locks any
// posting) and put the stored value back afterwards through the api.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const CUTOFF = {
  key: 'operating_day_cutoff_hour',
  label: 'settings.entries.operatingDayCutoffHour.label',
} as const;
const VAT = {
  key: 'prices_include_vat',
  label: 'settings.entries.pricesIncludeVat.label',
} as const;
const WIND_DOWN_LABEL = 'settings.entries.operationsWindDownDays.label' as const;

interface ApiEntry {
  key: string;
  value: unknown;
  updatedAt: string | null;
}

/** One call to the settings api with the signed in manager's cookie and the app's own Origin. */
async function settingsApi(
  request: APIRequestContext,
  method: 'GET' | 'PUT',
  path: string,
  data?: unknown,
) {
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').origin;
  const response = await request.fetch(`/api/settings${path}`, {
    method,
    data,
    headers: { origin },
  });
  return { status: response.status(), body: (await response.json()) as { entries?: ApiEntry[] } };
}

/** The stored entry of one key, as the api lists it. */
async function currentEntry(request: APIRequestContext, key: string): Promise<ApiEntry> {
  const { body } = await settingsApi(request, 'GET', '');
  const found = body.entries?.find((entry) => entry.key === key);
  if (!found) throw new Error(`No setting ${key}`);
  return found;
}

/**
 * The write tests change install wide settings, so only one project may run them: two projects in
 * parallel workers would race each other into 409 or read each other's value.
 */
const desktopOnly = (name: string) =>
  test.skip(name !== 'desktop', 'writes install wide settings: desktop project only');

/** The text of a catalog key with its `{{name}}` filled in. */
const withName = (dir: TextDirection, key: MessageKey, name: string) =>
  textFor(dir, key).replace('{{name}}', name);

/** Opens the settings page and waits for the sections. */
async function openSettings(page: Page, dir: TextDirection) {
  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { level: 1, name: textFor(dir, 'settings.title') }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: textFor(dir, 'settings.sections.brand') }),
  ).toBeVisible();
  await waitForPageHydration(page);
}

/** The row of one setting, found by its name. */
const rowOf = (page: Page, dir: TextDirection, label: MessageKey) =>
  page.getByRole('listitem').filter({
    has: page.getByRole('heading', { level: 3, name: textFor(dir, label), exact: true }),
  });

/** Opens the change dialog of one setting by its button. */
async function openChange(page: Page, dir: TextDirection, label: MessageKey) {
  await page
    .getByRole('button', {
      name: withName(dir, 'settings.row.changeNamed', textFor(dir, label)),
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: withName(dir, 'settings.dialog.title', textFor(dir, label)),
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('as a manager', () => {
  let original: ApiEntry | undefined;

  test.afterEach(async ({ request }) => {
    // Put back what the test changed, whatever state it ended in.
    const touched = original;
    original = undefined;
    if (!touched) return;
    // The put must succeed: a value left changed would poison every later test. One retry with
    // a fresh `updatedAt` covers a write that slipped in between the read and the put.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = await currentEntry(request, touched.key);
      if (JSON.stringify(now.value) === JSON.stringify(touched.value)) return;
      const answer = await settingsApi(request, 'PUT', `/${touched.key}`, {
        value: touched.value,
        reason: 'e2e cleanup',
        expectedUpdatedAt: now.updatedAt,
      });
      if (answer.status === 200) return;
      if (attempt === 1) expect(answer.status, 'the cleanup put restores the setting').toBe(200);
    }
  });

  for (const { dir, name } of LANGUAGES) {
    test(`changes the operating day start with a reason in ${name}, and refuses without one (AC-25)`, async ({
      page,
      request,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      original = await currentEntry(request, CUTOFF.key);
      const next = original.value === 2 ? 3 : 2;
      await useBrowserState(page, { dir });
      await openSettings(page, dir);
      await expect(page.locator('h1')).toHaveCount(1);

      const dialog = await openChange(page, dir, CUTOFF.label);
      await dialog.getByLabel(textFor(dir, 'settings.dialog.newValue')).fill(String(next));
      await dialog.getByRole('button', { name: textFor(dir, 'settings.dialog.save') }).click();
      await expect(
        dialog.getByText(textFor(dir, 'settings.dialog.errors.reasonRequired')),
      ).toBeVisible();
      await expect(dialog.getByLabel(textFor(dir, 'settings.dialog.reason'))).toBeFocused();
      await expect(dialog).toBeVisible();

      await dialog.getByLabel(textFor(dir, 'settings.dialog.reason')).fill('Warehouse opens later');
      await dialog.getByRole('button', { name: textFor(dir, 'settings.dialog.save') }).click();
      await expect(dialog).toBeHidden();

      const row = rowOf(page, dir, CUTOFF.label);
      await expect(row).toContainText(`0${next}:00`);
      await expect(row).toContainText(E2E_ADMIN.name);
      await expect(row).toContainText(textFor(dir, 'settings.row.changed'));
      expect((await currentEntry(request, CUTOFF.key)).value).toBe(next);
      // Focus goes back to the button that opened the dialog.
      await expect(
        page.getByRole('button', {
          name: withName(dir, 'settings.row.changeNamed', textFor(dir, CUTOFF.label)),
        }),
      ).toBeFocused();
    });
  }

  test('asks for the name of the setting before the VAT switch changes (AC-25)', async ({
    page,
    request,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    original = await currentEntry(request, VAT.key);
    await useBrowserState(page, { dir: 'ltr' });
    await openSettings(page, 'ltr');

    const dialog = await openChange(page, 'ltr', VAT.label);
    await expect(
      dialog.getByText(textFor('ltr', 'settings.warnings.pricesIncludeVat')),
    ).toBeVisible();
    await dialog.getByLabel(textFor('ltr', 'settings.dialog.reason')).fill('Prices are now net');
    // Flip the switch: the option that is not selected now.
    const other = original.value === true ? 'settings.values.no' : 'settings.values.yes';
    await dialog.getByRole('radio', { name: textFor('ltr', other) }).check();
    await dialog.getByRole('button', { name: textFor('ltr', 'settings.dialog.save') }).click();
    await expect(
      dialog.getByText(textFor('ltr', 'settings.dialog.errors.confirmMismatch')),
    ).toBeVisible();

    await dialog
      .getByLabel(withName('ltr', 'settings.dialog.confirmLabel', textFor('ltr', VAT.label)))
      .fill(textFor('ltr', VAT.label));
    await dialog.getByRole('button', { name: textFor('ltr', 'settings.dialog.save') }).click();
    await expect(dialog).toBeHidden();
    expect((await currentEntry(request, VAT.key)).value).toBe(
      original.value === true ? false : true,
    );
  });

  test('shows an Operations item disabled with the plan it needs, and the currency without a change action', async ({
    page,
  }) => {
    // The install may hold an Operations license (the dev bootstrap writes one), so the list is
    // answered with that entry not licensed: the screen's own words for it are what is tested.
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { entries: { key: string; licensed: boolean }[] };
      const entries = body.entries.map((entry) =>
        entry.key === 'operations_wind_down_days' ? { ...entry, licensed: false } : entry,
      );
      return route.fulfill({ response, json: { ...body, entries } });
    });
    await useBrowserState(page, { dir: 'ltr' });
    await openSettings(page, 'ltr');
    const policies = rowOf(page, 'ltr', WIND_DOWN_LABEL);
    await expect(policies.getByText(textFor('ltr', 'settings.row.needsOperations'))).toBeVisible();
    await expect(policies.getByRole('button', { name: /Change/ })).toBeDisabled();
    const currency = rowOf(page, 'ltr', 'settings.entries.currency.label');
    await expect(currency.getByText(textFor('ltr', 'settings.row.fixed'))).toBeVisible();
    await expect(currency.getByRole('button', { name: /Change/ })).toBeDisabled();
  });

  test('lists Settings in the sidebar', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sidebar is a drawer on mobile');
    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(E2E_ADMIN.name) })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
    ).toBeVisible();
  });

  for (const { dir, name } of LANGUAGES) {
    test(`has no axe violations in ${name}, with the dialog open too`, async ({
      page,
      viewport,
    }) => {
      test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the accessibility sweep');
      await useBrowserState(page, { dir });
      await openSettings(page, dir);
      await expectNoAxeViolations(page);

      const dialog = await openChange(page, dir, VAT.label);
      await expectNoAxeViolations(page);
      await dialog.getByRole('button', { name: textFor(dir, 'settings.dialog.cancel') }).click();
      await expect(dialog).toBeHidden();
    });
  }
});

test.describe('a person without settings.manage', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;

  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  for (const { dir, name } of LANGUAGES) {
    test(`gets the no access state and no sidebar entry in ${name} (AC-25)`, async ({
      page,
      context,
      baseURL,
      isMobile,
    }) => {
      person = await seedAccount({ hats: ['support'], language: dir === 'rtl' ? 'ar' : 'en' });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { dir });
      const asked: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/settings')) asked.push(path);
      });

      await page.goto('/settings');
      const main = page.getByRole('main');
      await expect(main.getByText(textFor(dir, 'access.noAccess.title'))).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(
        main.getByRole('heading', { level: 1, name: textFor(dir, 'settings.title') }),
      ).toBeVisible();
      await expect(main.getByRole('listitem')).toHaveCount(0);
      // A positive signal that the page has settled: the shell knows the person (so the gate
      // has decided), and two frames have rendered since. Then no settings request was made.
      await expect(page.getByRole('button', { name: new RegExp(person.name) })).toBeVisible();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      expect(asked).toEqual([]);

      if (!isMobile) {
        await expect(
          page
            .getByRole('navigation')
            .getByRole('link', { name: textFor(dir, 'shell.nav.items.settings') }),
        ).toHaveCount(0);
      }
    });
  }
});

// Spec 0009 milestone 5 (AC-21, AC-24, AC-25, AC-29, AC-30, AC-31): every section in both
// languages, the Automations section with a fixture step (no real step exists yet, so the list,
// the module states, the off impact, and every write are answered by the browser), the step
// waiting on a stock out source with its words and the stock page notice, a Warehouse only
// install, the sales tax rate dialog, and the Location owner types section. The owner policy
// list is route mocked too: its route needs a migration that may not be applied on every
// database the suite runs against. Nothing below writes to the database.

interface ListedEntry {
  key: string;
  bundle: string;
  licensed: boolean;
}

/** A fixture executing step: its label and description are catalog keys the suite owns. */
const STEP = {
  key: 'step.fixture_send',
  group: 'automations',
  bundle: 'core',
  label: 'modules.capabilities.mailSend',
  description: 'modules.mail.description',
  warning: null,
  confirm: null,
  reason: 'required',
  value: false,
  default: false,
  isDefault: true,
  invalid: false,
  updatedAt: null,
  updatedBy: null,
  canChange: true,
  licensed: true,
  step: {
    capability: 'fixturesteps.send',
    notifiesCustomer: true,
    turnOn: { ready: true, facts: [] },
  },
} as const;

/** A fixture stock push step on an install with no stock out source (W9). */
const PUSH_STEP = {
  ...STEP,
  key: 'step.fixture_push',
  label: 'modules.inventory.label',
  description: 'modules.inventory.description',
  step: {
    capability: 'connectors.shopify.stock_push',
    notifiesCustomer: false,
    turnOn: { ready: false, precondition: 'NO_STOCK_OUT_SOURCE' },
  },
} as const;

/** A fixture step that is on, for the off dialog. */
const ON_STEP = {
  ...STEP,
  key: 'step.fixture_on',
  label: 'modules.orders.label',
  description: 'modules.orders.description',
  value: true,
  isDefault: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
} as const;

const OWNER_POLICIES = {
  policies: [
    {
      ownerType: 'own',
      stockOwnedByBrand: true,
      handoverIsSale: false,
      saleRecordedAt: 'at_shipment',
      endCustomerRefundBy: 'brand',
      defectivePieceRefundBy: 'brand',
      taxDocument: 'b2c_electronic_receipt',
      settlementOwnerType: null,
      canSellOnline: true,
      lockedFields: [
        'stockOwnedByBrand',
        'handoverIsSale',
        'saleRecordedAt',
        'taxDocument',
        'settlementOwnerType',
      ],
      activeLocations: 2,
      updatedAt: '2026-11-07T10:15:30.123456Z',
      updatedBy: null,
    },
  ],
};

/**
 * Answers the settings list with the real entries (each passed through `rewrite`) plus `extra`,
 * and hands every listed entry to `seen`, so a mocked write can answer with the entry it changed.
 */
async function extendSettings(
  page: Page,
  extra: readonly object[],
  rewrite: (entry: ListedEntry) => object = (entry) => entry,
  seen: (entries: readonly ListedEntry[]) => void = () => undefined,
) {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { entries: ListedEntry[] };
    seen(body.entries);
    return route.fulfill({
      response,
      json: { ...body, entries: [...body.entries.map(rewrite), ...extra] },
    });
  });
}

/** Answers the owner policy list with the fixture above. */
async function mockOwnerPolicies(page: Page) {
  await page.route('**/api/inventory/owner-policies', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: OWNER_POLICIES }) : route.continue(),
  );
}

/** Answers the module states with the stock push waiting for a stock out source. */
async function mockNoStockOutSource(page: Page) {
  await page.route('**/api/platform/modules', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { capabilities: unknown[] };
    const waiting = {
      key: 'connectors.shopify.stock_push',
      state: 'read_only',
      since: null,
      before: null,
      reason: 'no_stock_out_source',
    };
    return route.fulfill({
      response,
      json: { ...body, capabilities: [...body.capabilities, waiting] },
    });
  });
}

/** Answers a write to one setting with the entry as it would stand, and records the body. */
async function captureWrite(page: Page, key: string, entry: () => object, writes: unknown[]) {
  await page.route(`**/api/settings/${key}`, (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { value: unknown };
    writes.push(body);
    return route.fulfill({
      json: { entry: { ...entry(), value: body.value, isDefault: false }, changed: true },
    });
  });
}

const SECTIONS = [
  'settings.sections.brand',
  'settings.sections.license',
  'settings.sections.automations',
  'settings.sections.policies',
  'settings.sections.catalog',
  'settings.sections.ownerTypes',
] as const satisfies readonly MessageKey[];

test.describe('every section (milestone 5)', () => {
  for (const { dir, name } of LANGUAGES) {
    test(`lists every section in order, the Catalog rows set elsewhere, and is axe clean in ${name} (AC-25, AC-31)`, async ({
      page,
      viewport,
    }) => {
      await mockOwnerPolicies(page);
      await useBrowserState(page, { dir });
      await openSettings(page, dir);
      const owners = page.getByRole('region', {
        name: textFor(dir, 'settings.sections.ownerTypes'),
      });
      await expect(
        owners.getByText(
          textFor(dir, 'settings.ownerPolicies.lockedNote').replace('{{locations}}', '2'),
        ),
      ).toBeVisible();
      await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(
        SECTIONS.map((key) => textFor(dir, key)),
      );
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(
        owners.getByText(textFor(dir, 'settings.ownerPolicies.description')),
      ).toBeVisible();

      // No real step exists yet: the Automations section shows its empty state.
      await expect(page.getByText(textFor(dir, 'settings.automations.empty'))).toBeVisible();

      const catalog = page.getByRole('region', { name: textFor(dir, 'settings.sections.catalog') });
      await expect(catalog.getByText(textFor(dir, 'settings.row.setElsewhere'))).toHaveCount(3);
      await expect(catalog.getByRole('button')).toHaveCount(0);
      await expect(
        rowOf(page, dir, 'settings.entries.shopifyGiftTags.label').getByText(
          textFor(dir, 'settings.row.setElsewhere'),
        ),
      ).toBeVisible();

      if ((viewport?.width ?? 0) >= 1000) await expectNoAxeViolations(page);
    });
  }

  test('changes the sales tax rate with its warning, worked split, typed name, and reason (AC-31)', async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    const writes: unknown[] = [];
    let listed: readonly ListedEntry[] = [];
    await extendSettings(page, [], undefined, (entries) => {
      listed = entries;
    });
    await captureWrite(
      page,
      'sales_tax_rate',
      () => listed.find((entry) => entry.key === 'sales_tax_rate') ?? {},
      writes,
    );
    await useBrowserState(page, { dir: 'ltr' });
    await openSettings(page, 'ltr');
    const label = 'settings.entries.salesTaxRate.label' as const;
    await expect(
      page
        .getByRole('region', { name: textFor('ltr', 'settings.sections.brand') })
        .getByRole('heading', { level: 3, name: textFor('ltr', label) }),
    ).toBeVisible();

    const dialog = await openChange(page, 'ltr', label);
    await expect(dialog.getByText(textFor('ltr', 'settings.warnings.salesTaxRate'))).toBeVisible();
    await dialog.getByLabel(textFor('ltr', 'settings.dialog.newValue')).fill('15.00');
    await expect(dialog.getByText(textFor('ltr', 'settings.dialog.taxSplit.title'))).toBeVisible();
    await dialog.getByLabel(textFor('ltr', 'settings.dialog.reason')).fill('VAT rate changed');
    await dialog.getByRole('button', { name: textFor('ltr', 'settings.dialog.save') }).click();
    await expect(
      dialog.getByText(textFor('ltr', 'settings.dialog.errors.confirmMismatch')),
    ).toBeVisible();
    expect(writes).toEqual([]);

    await dialog
      .getByLabel(withName('ltr', 'settings.dialog.confirmLabel', textFor('ltr', label)))
      .fill(textFor('ltr', label));
    await dialog.getByRole('button', { name: textFor('ltr', 'settings.dialog.save') }).click();
    await expect(dialog).toBeHidden();
    expect(writes).toEqual([
      expect.objectContaining({ value: '15.00', reason: 'VAT rate changed' }),
    ]);
  });

  test('shows every Operations item disabled on a Warehouse only install (AC-25)', async ({
    page,
  }) => {
    await extendSettings(page, [], (entry) =>
      entry.bundle === 'operations' ? { ...entry, licensed: false } : entry,
    );
    await page.route('**/api/platform/license', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { bundles: { bundle: string }[] };
      const bundles = body.bundles.map((bundle) =>
        bundle.bundle === 'operations'
          ? {
              bundle: 'operations',
              phase: 'not_licensed',
              perpetual: false,
              expiresOn: null,
              daysLeft: null,
              lapsesAt: null,
            }
          : bundle,
      );
      return route.fulfill({ response, json: { ...body, bundles } });
    });
    await useBrowserState(page, { dir: 'ltr' });
    await openSettings(page, 'ltr');
    for (const label of [
      'settings.entries.operationsWindDownDays.label',
      'settings.entries.operationsWindDownPickupDays.label',
    ] as const) {
      const row = rowOf(page, 'ltr', label);
      await expect(row.getByText(textFor('ltr', 'settings.row.needsOperations'))).toBeVisible();
      await expect(row.getByRole('button', { name: /Change/ })).toBeDisabled();
    }
  });
});

test.describe('Automations (mocked, AC-21, AC-25, AC-29, AC-30)', () => {
  for (const { dir, name } of LANGUAGES) {
    test(`turns a step on from the keyboard alone with its reason in ${name}`, async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      const writes: unknown[] = [];
      await extendSettings(page, [STEP]);
      await captureWrite(page, STEP.key, () => STEP, writes);
      await useBrowserState(page, { dir });
      await openSettings(page, dir);

      const stepName = textFor(dir, STEP.label);
      const trigger = page.getByRole('button', {
        name: withName(dir, 'settings.modules.row.turnOnNamed', stepName),
      });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', {
        name: withName(dir, 'settings.automations.turnOn.title', stepName),
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(textFor(dir, 'settings.automations.customerHears')),
      ).toBeVisible();
      await expect(
        dialog.getByText(textFor(dir, 'settings.automations.turnOn.fromNow')),
      ).toBeVisible();
      await expectNoAxeViolations(page);

      // Without a reason the dialog refuses and puts focus on the reason.
      const confirm = dialog.getByRole('button', {
        name: textFor(dir, 'settings.automations.turnOn.confirm'),
      });
      await confirm.focus();
      await page.keyboard.press('Enter');
      const reason = dialog.getByLabel(textFor(dir, 'settings.dialog.reason'));
      await expect(reason).toBeFocused();
      await page.keyboard.type('The brand wants it on');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      expect(writes).toEqual([
        { value: true, reason: 'The brand wants it on', expectedUpdatedAt: null },
      ]);
    });

    test(`shows a step waiting on a stock out source as unavailable, and the stock page notice, in ${name} (W9)`, async ({
      page,
    }) => {
      await extendSettings(page, [PUSH_STEP]);
      await mockNoStockOutSource(page);
      await useBrowserState(page, { dir });
      await openSettings(page, dir);

      const row = rowOf(page, dir, PUSH_STEP.label);
      await expect(row.getByText(textFor(dir, 'settings.automations.unavailable'))).toBeVisible();
      await expect(
        row.getByText(textFor(dir, 'settings.automations.preconditions.NO_STOCK_OUT_SOURCE')),
      ).toBeVisible();
      await expect(
        row.getByText(textFor(dir, 'settings.automations.customerShopify')),
      ).toBeVisible();
      await expect(row.getByRole('button')).toBeDisabled();

      await page.goto('/stock');
      await expect(page.getByText(textFor(dir, 'shell.modules.stockOutSource'))).toBeVisible();
    });
  }

  test('turns a step off through the off dialog with what it stops and a reason (AC-30)', async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    const writes: unknown[] = [];
    await extendSettings(page, [ON_STEP]);
    await page.route(`**/api/settings/${ON_STEP.key}/off-impact`, (route) =>
      route.fulfill({
        json: {
          waitingCommands: [{ kind: 'shopify.order_edit', count: 3 }],
          inFlight: [],
          partnerStock: [],
          typedConfirmation: false,
        },
      }),
    );
    await captureWrite(page, ON_STEP.key, () => ON_STEP, writes);
    await useBrowserState(page, { dir: 'ltr' });
    await openSettings(page, 'ltr');

    const stepName = textFor('ltr', ON_STEP.label);
    await page
      .getByRole('button', {
        name: withName('ltr', 'settings.modules.row.turnOffNamed', stepName),
      })
      .click();
    const dialog = page.getByRole('dialog', {
      name: withName('ltr', 'settings.modules.off.title', stepName),
    });
    await expect(
      dialog.getByRole('heading', {
        name: textFor('ltr', 'settings.modules.impact.waitingHeading'),
      }),
    ).toBeVisible();
    await dialog.getByLabel(textFor('ltr', 'settings.dialog.reason')).fill('Pause for the sale');
    await dialog
      .getByRole('button', { name: textFor('ltr', 'settings.modules.off.confirm') })
      .click();
    await expect(dialog).toBeHidden();
    expect(writes).toEqual([
      { value: false, reason: 'Pause for the sale', expectedUpdatedAt: ON_STEP.updatedAt },
    ]);
  });
});
