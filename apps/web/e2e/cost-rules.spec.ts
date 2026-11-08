import { expect, test, type Page } from '@playwright/test';
import type { MessageKey } from '@ssdashboard/i18n';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  expectNoAxeViolations,
  textFor,
  useBrowserState,
  waitForElementHydration,
  type TextDirection,
} from './support';

// Spec 0009 milestone 5 (AC-23, AC-25, D14, D15): the Cost rules page at /settings/cost-rules.
// The suite's manager (who holds `cost.view`) reads the rules in English and Arabic and records a
// rule through the locked period override; a person with the cost grant but no settings
// permission reads them without the New rule action; a person without the grant gets the no
// access state and asks for nothing. Recording is route mocked: a rule row is append only, so a
// real one would stay in the shared database for ever. The read is the real api.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const desktopOnly = (name: string) =>
  test.skip(name !== 'desktop', 'mocks a write and reads the sidebar: desktop project only');

/** The text of a catalog key with its `{{name}}` filled in. */
const withName = (dir: TextDirection, key: MessageKey, name: string) =>
  textFor(dir, key).replace('{{name}}', name);

/** Opens the Cost rules page and waits for the rules in force today. */
async function openCostRules(page: Page, dir: TextDirection) {
  await page.goto('/settings/cost-rules');
  await expect(
    page.getByRole('heading', { level: 1, name: textFor(dir, 'settings.costRules.title') }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: textFor(dir, 'settings.costRules.currentTable') }),
  ).toBeVisible();
  // A reader has no control on this page, so wait for the rules table itself to hydrate.
  await waitForElementHydration(page, 'main table');
}

test.describe('as a manager with the cost grant', () => {
  for (const { dir, name } of LANGUAGES) {
    test(`reads the rule in force for every kind and the history, axe clean, in ${name}`, async ({
      page,
      viewport,
    }) => {
      await useBrowserState(page, { dir });
      await openCostRules(page, dir);
      await expect(page.locator('h1')).toHaveCount(1);
      const current = page.getByRole('table', {
        name: textFor(dir, 'settings.costRules.currentTable'),
      });
      for (const kind of [
        'cod_fee_percent',
        'gateway_fee_percent',
        'packaging_per_order',
        'rto_unrestocked_percent',
      ] as const) {
        await expect(
          current.getByRole('rowheader', {
            name: textFor(dir, `settings.costRules.kinds.${kind}`),
          }),
        ).toBeVisible();
      }
      await expect(
        page.getByRole('heading', {
          level: 2,
          name: textFor(dir, 'settings.costRules.historyHeading'),
        }),
      ).toBeVisible();
      if ((viewport?.width ?? 0) >= 1000) await expectNoAxeViolations(page);
    });
  }

  test('shows the prompt that nothing is locked yet while the lock date is unset (AC-23)', async ({
    page,
  }) => {
    await page.route('**/api/platform/cost-rules?*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      return route.fulfill({ response, json: { ...body, lockDate: null, lockDateInvalid: false } });
    });
    await useBrowserState(page, { dir: 'ltr' });
    await openCostRules(page, 'ltr');
    await expect(page.getByText(textFor('ltr', 'settings.costRules.lockUnset'))).toBeVisible();
  });

  test('names the locked months and records the rule in the locked period on purpose (AC-23, D14)', async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    const posts: unknown[] = [];
    await page.route('**/api/platform/cost-rules', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push(body);
      if (body.inLockedPeriod !== true) {
        return route.fulfill({
          status: 409,
          json: { code: 'COST_RULE_IN_LOCKED_PERIOD', months: ['2026-08', '2026-09'] },
        });
      }
      return route.fulfill({
        status: 201,
        json: {
          id: '00000000-0000-4000-8000-0000000000e1',
          kind: 'cod_fee_percent',
          status: 'set',
          value: '3',
          effectiveFrom: '2026-08-15',
          recordedAt: '2026-11-08T10:00:00.000000Z',
          recordedBy: null,
        },
      });
    });
    await useBrowserState(page, { dir: 'ltr' });
    await openCostRules(page, 'ltr');

    const kind = textFor('ltr', 'settings.costRules.kinds.cod_fee_percent');
    await page
      .getByRole('button', { name: withName('ltr', 'settings.costRules.addNamed', kind) })
      .click();
    const dialog = page.getByRole('dialog', {
      name: withName('ltr', 'settings.costRules.dialog.title', kind),
    });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(textFor('ltr', 'settings.costRules.dialog.percent')).fill('3');
    await dialog
      .getByLabel(textFor('ltr', 'settings.costRules.dialog.effectiveFrom'))
      .fill('2026-08-15');
    await dialog.getByLabel(textFor('ltr', 'settings.dialog.reason')).fill('August fee was wrong');
    await dialog
      .getByRole('button', { name: textFor('ltr', 'settings.costRules.dialog.save') })
      .click();

    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText(textFor('ltr', 'settings.costRules.dialog.lockedTitle'));
    await expect(alert).toContainText('2026-08');
    await expect(alert).toContainText('2026-09');
    await expectNoAxeViolations(page);
    await dialog
      .getByRole('button', { name: textFor('ltr', 'settings.costRules.dialog.overrideSave') })
      .click();
    await expect(dialog).toBeHidden();
    expect(posts).toEqual([
      {
        kind: 'cod_fee_percent',
        status: 'set',
        value: '3',
        effectiveFrom: '2026-08-15',
        reason: 'August fee was wrong',
      },
      {
        kind: 'cod_fee_percent',
        status: 'set',
        value: '3',
        effectiveFrom: '2026-08-15',
        reason: 'August fee was wrong',
        inLockedPeriod: true,
      },
    ]);
  });
});

test.describe('people without the manager hat', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;

  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  for (const { dir, name } of LANGUAGES) {
    test(`a cost.view holder without settings.manage reads the rules but cannot add one in ${name} (D15)`, async ({
      page,
      context,
      baseURL,
      isMobile,
    }) => {
      person = await seedAccount({
        hats: ['support'],
        grants: ['cost.view'],
        language: dir === 'rtl' ? 'ar' : 'en',
      });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { dir });
      await openCostRules(page, dir);

      await expect(
        page.getByText(textFor(dir, 'settings.costRules.addNeedsSettings')),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: textFor(dir, 'settings.costRules.add') }),
      ).toHaveCount(0);
      if (!isMobile) {
        const nav = page.getByRole('navigation', { name: textFor(dir, 'shell.nav.label') });
        await expect(
          nav.getByRole('link', { name: textFor(dir, 'shell.nav.items.costRules'), exact: true }),
        ).toHaveAttribute('aria-current', 'page');
        await expect(
          nav.getByRole('link', { name: textFor(dir, 'shell.nav.items.settings'), exact: true }),
        ).toHaveCount(0);
      }
    });
  }

  test('a person without cost.view gets the no access state and asks for nothing (AC-25)', async ({
    page,
    context,
    baseURL,
  }) => {
    person = await seedAccount({ hats: ['support'] });
    await signInThroughApi(context, person, baseURL ?? '');
    await useBrowserState(page, { dir: 'ltr' });
    const asked: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/platform/cost-rules')) asked.push(path);
    });

    await page.goto('/settings/cost-rules');
    const main = page.getByRole('main');
    await expect(main.getByText(textFor('ltr', 'access.noAccess.title'))).toBeVisible();
    await expect(
      main.getByRole('heading', { level: 1, name: textFor('ltr', 'settings.costRules.title') }),
    ).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('button', { name: new RegExp(person.name) })).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(asked).toEqual([]);
  });
});
