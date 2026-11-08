import { expect, test, type Page } from '@playwright/test';
import type { MessageKey } from '@ssdashboard/i18n';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0009 milestone 3 (AC-9, AC-12, AC-30): the module aware shell and the off dialog. No real
// module is toggleable yet and a test must never switch one, so every answer is route mocked:
// `GET /api/platform/modules` shows an `off` and a `read_only` entry, `GET /api/settings` carries a
// fixture switch, and the off impact and the write are answered by the browser too. Nothing here
// reaches the database.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const desktopOnly = (name: string) =>
  test.skip(name !== 'desktop', 'reads the sidebar and writes: desktop project only');

const view = (key: string, state: string, extra: Record<string, unknown> = {}) => ({
  key,
  state,
  since: null,
  before: null,
  reason: null,
  ...extra,
});

/** Answers the module states: Stock is off, Catalog is read only since a fixed day. */
async function mockModules(page: Page) {
  await page.route('**/api/platform/modules', (route) =>
    route.fulfill({
      json: {
        modules: [
          view('inventory', 'off', { since: '2026-11-01T22:00:00.000Z', reason: 'toggled_off' }),
          view('catalog', 'read_only', { since: '2026-11-01T22:00:00.000Z', reason: 'lapsed' }),
        ],
        capabilities: [],
        staffNotices: [],
        licenseNotices: null,
      },
    }),
  );
}

const link = (page: Page, dir: TextDirection, key: MessageKey) =>
  page.getByRole('navigation', { name: textFor(dir, 'shell.nav.label') }).getByRole('link', {
    name: textFor(dir, key),
    exact: true,
  });

for (const { dir, name } of LANGUAGES) {
  test.describe(`module aware shell in ${name}`, () => {
    test(`hides the entries of an off module and keeps a read only one (AC-9)`, async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await mockModules(page);
      await useBrowserState(page, { dir });
      await page.goto('/');
      await expect(link(page, dir, 'shell.nav.items.settings')).toBeVisible();

      await expect(link(page, dir, 'shell.nav.items.stock')).toHaveCount(0);
      await expect(link(page, dir, 'shell.nav.items.receipts')).toHaveCount(0);
      await expect(link(page, dir, 'shell.nav.items.locations')).toHaveCount(0);
      await expect(link(page, dir, 'shell.nav.items.skus')).toBeVisible();
    });

    test(`shows the not available state for an off page, with one h1 and a way out, axe clean (AC-9)`, async ({
      page,
    }) => {
      await mockModules(page);
      await useBrowserState(page, { dir });
      await page.goto('/stock');

      await expect(
        page.getByRole('heading', { level: 1, name: textFor(dir, 'shell.nav.items.stock') }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByText(textFor(dir, 'shell.modules.notAvailable.title'))).toBeVisible();
      await expectNoAxeViolations(page);

      // By keyboard: the way out is a link, focused and opened with Enter.
      const home = page.getByRole('link', { name: textFor(dir, 'access.noAccess.home') });
      await home.focus();
      await expect(home).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/$/);
    });

    test(`shows the read only notice with its date above a history page, axe clean (AC-9)`, async ({
      page,
    }) => {
      await mockModules(page);
      await useBrowserState(page, { dir });
      await page.goto('/skus');

      const notice = page.getByRole('region', { name: textFor(dir, 'shell.modules.noticeLabel') });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('2026');
      await expect(notice).toContainText(textFor(dir, 'shell.modules.reasons.lapsed'));
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectNoAxeViolations(page);
    });
  });
}

// The fixture switch: a module that is on, with a typed confirmation and a partner holding stock.
const SWITCH = {
  key: 'module.catalog.enabled',
  group: 'modules',
  bundle: 'core',
  label: 'modules.catalog.label',
  description: 'modules.catalog.description',
  warning: null,
  confirm: null,
  reason: 'required',
  value: true,
  default: true,
  isDefault: true,
  invalid: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
  updatedBy: null,
  canChange: true,
  licensed: true,
} as const;

const IMPACT = {
  waitingCommands: [{ kind: 'bosta.create_shipment', count: 3 }],
  inFlight: [{ area: 'exchanges.approved', count: 2 }],
  partnerStock: [
    {
      partnerId: '00000000-0000-4000-8000-0000000000a1',
      partnerName: 'Nile Showroom',
      pieces: 1200,
      totalValue: '45000.00',
      lastConfirmedSalesDay: '2026-11-01',
    },
  ],
  typedConfirmation: true,
};

test.describe('the off dialog (mocked, AC-12, AC-30)', () => {
  for (const { dir, name } of LANGUAGES) {
    test(`shows the impact, requires the typed name and a reason, and writes false in ${name}`, async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await useBrowserState(page, { dir });
      await page.route('**/api/settings', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = (await response.json()) as { entries: unknown[] };
        return route.fulfill({ response, json: { ...body, entries: [...body.entries, SWITCH] } });
      });
      await page.route('**/api/settings/module.catalog.enabled/off-impact', (route) =>
        route.fulfill({ json: IMPACT }),
      );
      const writes: unknown[] = [];
      await page.route('**/api/settings/module.catalog.enabled', (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        writes.push(route.request().postDataJSON());
        return route.fulfill({
          json: { entry: { ...SWITCH, value: false, isDefault: false }, changed: true },
        });
      });

      await page.goto('/settings');
      await expect(
        page.getByRole('heading', { level: 2, name: textFor(dir, 'settings.sections.license') }),
      ).toBeVisible();
      await waitForPageHydration(page);

      const catalog = textFor(dir, 'modules.catalog.label');
      const trigger = page.getByRole('button', {
        name: textFor(dir, 'settings.modules.row.turnOffNamed').replace('{{name}}', catalog),
      });
      await trigger.click();
      const dialog = page.getByRole('dialog', {
        name: textFor(dir, 'settings.modules.off.title').replace('{{name}}', catalog),
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('heading', {
          name: textFor(dir, 'settings.modules.impact.waitingHeading'),
        }),
      ).toBeVisible();
      await expect(dialog.getByText('bosta.create_shipment')).toBeVisible();
      await expect(dialog.getByText('Nile Showroom')).toBeVisible();
      await expectNoAxeViolations(page);

      const confirm = dialog.getByLabel(
        textFor(dir, 'settings.dialog.confirmLabel').replace('{{name}}', catalog),
      );
      const save = dialog.getByRole('button', {
        name: textFor(dir, 'settings.modules.off.confirm'),
      });

      // Empty submit: the typed name is the first fault, and nothing is sent.
      await save.click();
      await expect(confirm).toBeFocused();
      await expect(
        dialog.getByText(textFor(dir, 'settings.dialog.errors.confirmMismatch')),
      ).toBeVisible();
      expect(writes).toHaveLength(0);

      // By keyboard from here: type the name, type the reason, Enter on the focused button submits.
      await page.keyboard.type(catalog);
      await save.click();
      const reason = dialog.getByRole('textbox', {
        name: new RegExp(textFor(dir, 'settings.dialog.reason')),
      });
      await expect(reason).toBeFocused();
      await page.keyboard.type('Pausing the catalog');
      await save.focus();
      await page.keyboard.press('Enter');

      await expect(dialog).toBeHidden();
      expect(writes).toEqual([
        {
          value: false,
          reason: 'Pausing the catalog',
          expectedUpdatedAt: SWITCH.updatedAt,
        },
      ]);
    });
  }

  test('returns focus to the Turn off button when the dialog is cancelled', async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    await useBrowserState(page, { dir: 'ltr' });
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { entries: unknown[] };
      return route.fulfill({ response, json: { ...body, entries: [...body.entries, SWITCH] } });
    });
    await page.route('**/api/settings/module.catalog.enabled/off-impact', (route) =>
      route.fulfill({ json: { ...IMPACT, typedConfirmation: false } }),
    );
    await page.goto('/settings');
    await waitForPageHydration(page);
    const trigger = page.getByRole('button', { name: 'Turn off Catalog' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Turn off Catalog' });
    await expect(dialog.getByText('Nile Showroom')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
