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
