import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { api, createLocation, createSku, receive } from './master-data-api';
import { pressEnterOn, tabTo, typeInto, useOnlineFlag } from './online-flag';
import { expectNoAxeViolations, textFor, useBrowserState, waitForPageHydration } from './support';

// Spec 0011 milestone 1, QA pass (AC-12 badge, AC-16, AC-17, AC-19, AC-20): what the first online
// gate spec does not drive. The standing notice and its link on Stock and Locations, the gate
// dialog's counts, failed check, reservations count and its stale, failed and generic errors, the
// whole move and stop flow on a phone, and a person without `catalog.manage`. English and Arabic.
// The flag is shared state of the database: the tests that move it for real hold the cross worker
// lock of `useOnlineFlag` (this file and online-stock.spec.ts run in parallel workers) and stop
// online stock afterwards. The tests that stub the gate or the status never touch the flag.
test.describe.configure({ mode: 'serial' });

const LANGUAGES = [
  { language: 'en', dir: 'ltr' },
  { language: 'ar', dir: 'rtl' },
] as const;

/** Answers `GET /api/stock/online-status` with no online location. */
async function stubNoOnlineLocation(page: Page) {
  await page.route('**/api/stock/online-status', (route) =>
    route.fulfill({ json: { onlineLocation: null } }),
  );
}

/** Fails when the page scrolls sideways: a phone must never need that. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/** A visible focus ring on the focused element (outline or box shadow). */
async function expectFocusVisible(page: Page) {
  const ring = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return false;
    const style = getComputedStyle(element);
    return (
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none'
    );
  });
  expect(ring).toBe(true);
}

for (const { language, dir } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);

  test.describe(`Online stock states in ${language}`, () => {
    test.beforeEach(async ({ page }) => {
      await useBrowserState(page, { language });
    });

    test('the not being updated line on Stock links to the gate, on Locations it does not (AC-20)', async ({
      page,
    }) => {
      await stubNoOnlineLocation(page);

      await page.goto('/stock');
      await waitForPageHydration(page);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      const notice = page.getByText(t('inventory.onlineGate.notice'));
      await expect(notice).toBeVisible();
      const link = page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') });
      await expect(link).toHaveAttribute('href', '/locations');
      await expect(page.locator('h1')).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await expectNoAxeViolations(page);

      // Keyboard only: Tab to the link, see the focus ring, Enter opens the Locations page.
      await tabTo(page, link);
      await expectFocusVisible(page);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/locations$/);
      // A fresh load: after a client side move the hidden Stock page stays mounted in the DOM.
      await page.goto('/locations');
      await waitForPageHydration(page);

      // On Locations the line shows without a link to itself.
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expect(
        page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') }),
      ).toHaveCount(0);
      await expect(page.locator('h1')).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await expectNoAxeViolations(page);
    });

    test('the gate dialog shows its counts, a failed check with its fix, and the stale, failed and generic errors (AC-19)', async ({
      page,
    }) => {
      const code = `0G${randomUUID().slice(0, 6).toUpperCase()}`;
      const location = await createLocation(page.request, code);
      const sku = await createSku(page.request, `E2E-GT-${randomUUID().slice(0, 8)}`);
      await receive(page.request, location.id, sku.id, 4);

      // The gate answer is the real one with a failed check from "another module", a current
      // online location with seven reservations, and every check passing from `mode` 'ready'.
      let mode: 'blocked' | 'ready' = 'blocked';
      let makeOnlineAnswer: { status: number; code?: string } = {
        status: 409,
        code: 'ONLINE_GATE_STALE',
      };
      let fixCalls = 0;
      await page.route(`**/api/locations/${location.id}/online-gate`, async (route: Route) => {
        const real = await route.fetch();
        const view = (await real.json()) as Record<string, unknown> & {
          checks: Record<string, unknown>[];
        };
        const other = {
          key: 'orders.open_orders_held',
          // Any catalog key does: the web translates what the api names.
          label: 'inventory.onlineGate.countsHeading',
          passed: mode === 'ready',
          count: 3,
          action: {
            method: 'POST',
            path: '/api/orders/hold-open-orders',
            label: 'inventory.onlineGate.stop',
          },
        };
        const checks = view.checks.map((check) =>
          mode === 'ready' ? { ...check, passed: true } : check,
        );
        await route.fulfill({
          json: {
            ...view,
            canGoOnline: true,
            checks: [...checks, other],
            reservationsAtOldLocation: 7,
            currentOnlineLocation: {
              id: randomUUID(),
              code: 'OLDONLINE',
              name: { en: 'Old online', ar: 'القديم' },
            },
          },
        });
      });
      await page.route('**/api/orders/hold-open-orders', (route) => {
        fixCalls += 1;
        mode = 'ready';
        return route.fulfill({ json: {} });
      });
      await page.route(`**/api/locations/${location.id}/make-online`, (route) =>
        route.fulfill({
          status: makeOnlineAnswer.status,
          json: { code: makeOnlineAnswer.code ?? 'INTERNAL', message: 'stub' },
        }),
      );

      await page.goto('/locations');
      await waitForPageHydration(page);
      await expect(page.locator('h1')).toHaveCount(1);
      const open = page.getByRole('button', {
        name: t('inventory.onlineGate.openLabel').replace('{{code}}', code),
      });
      await tabTo(page, open);
      await expectFocusVisible(page);
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // The counts, the old online location, its reservations, the failed check, the helper text.
      await expect(dialog.getByText(t('inventory.onlineGate.variantsWithStock'))).toBeVisible();
      await expect(dialog.getByText(t('inventory.onlineGate.totalOnHand'))).toBeVisible();
      await expect(dialog.getByText(t('inventory.onlineGate.variantsPushedZero'))).toBeVisible();
      await expect(dialog.getByText('OLDONLINE').first()).toBeVisible();
      await expect(
        dialog.getByText(
          t('inventory.onlineGate.reservationsAtOldLocation').replace('{{code}}', 'OLDONLINE'),
        ),
      ).toBeVisible();
      await expect(dialog.getByText('7', { exact: true })).toBeVisible();
      await expect(dialog.getByText(t('inventory.onlineGate.failed'))).toHaveCount(2);
      await expect(dialog.getByText(t('inventory.onlineGate.reasonHint'))).toBeVisible();
      const move = dialog.getByRole('button', { name: t('inventory.onlineGate.confirmMove') });
      await expect(move).toBeDisabled();
      await expect(page.locator('h1')).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await expectNoAxeViolations(page);

      // Run the failed check's fix: the gate is read again and the move opens up.
      await pressEnterOn(
        page,
        dialog.getByRole('button', { name: t('inventory.onlineGate.stop') }),
      );
      await expect(move).toBeEnabled();
      expect(fixCalls).toBe(1);

      // Stale, failed, then a generic error: each its own message, the dialog stays open.
      const reason = dialog.getByLabel(new RegExp(t('inventory.onlineGate.reason')));
      await typeInto(page, reason, 'Counted by hand');
      for (const [answer, message] of [
        [
          { status: 409, code: 'ONLINE_GATE_STALE' },
          t('inventory.onlineGate.errors.ONLINE_GATE_STALE'),
        ],
        [
          { status: 409, code: 'ONLINE_GATE_FAILED' },
          t('inventory.onlineGate.errors.ONLINE_GATE_FAILED'),
        ],
        [{ status: 500 }, t('inventory.onlineGate.errors.generic')],
      ] as const) {
        makeOnlineAnswer = answer;
        await pressEnterOn(page, move);
        await expect(dialog.getByRole('alert').getByText(message)).toBeVisible();
        await expect(dialog).toBeVisible();
      }
      await expectNoAxeViolations(page);

      // Escape closes it and focus goes back to the button that opened it.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();
    });
  });
}

// The first online gate spec runs the whole real flow on a wide screen only; this one runs it on
// a phone, in both languages. The phone drives the dialogs by touch (`tap`): that is how this
// audience uses them; the keyboard is covered on the wide screen.
for (const { language, dir } of LANGUAGES) {
  test.describe(`phone in ${language}`, () => {
    useOnlineFlag();
    test(`phone: the real gate flow, badge, stop and notices in ${language}`, async ({
      page,
    }, testInfo) => {
      test.skip((page.viewportSize()?.width ?? 0) >= 1000, 'the phone project only');
      const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
      await useBrowserState(page, { language });
      const code = `0G${randomUUID().slice(0, 6).toUpperCase()}`;
      const location = await createLocation(page.request, code);
      const sku = await createSku(page.request, `E2E-PH-${randomUUID().slice(0, 8)}`);
      await receive(page.request, location.id, sku.id, 4);

      await page.goto('/locations');
      await waitForPageHydration(page);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.locator('h1')).toHaveCount(1);
      await page
        .getByRole('button', {
          name: t('inventory.onlineGate.openLabel').replace('{{code}}', code),
        })
        .tap();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(t('inventory.onlineGate.failed'))).toBeVisible();
      await expectNoSidewaysScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`gate-${language}.png`) });
      await expectNoAxeViolations(page);

      await dialog.getByRole('button', { name: t('inventory.onlineGate.confirmStock') }).tap();
      await expect(dialog.getByText(t('inventory.onlineGate.passed'))).toBeVisible();
      await dialog.getByLabel(new RegExp(t('inventory.onlineGate.reason'))).fill('Counted by hand');
      await dialog.getByRole('button', { name: t('inventory.onlineGate.confirmMove') }).tap();
      await expect(dialog).toBeHidden();

      const row = page.getByRole('row', { name: new RegExp(code) });
      await expect(row.getByText(t('inventory.onlineGate.badge'), { exact: true })).toBeVisible();
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toHaveCount(0);
      await expectNoSidewaysScroll(page);

      await row
        .getByRole('button', {
          name: t('inventory.onlineGate.stopLabel').replace('{{code}}', code),
        })
        .tap();
      const stop = page.getByRole('dialog');
      await stop.getByLabel(new RegExp(t('inventory.onlineGate.reason'))).fill('Recount');
      await stop.getByRole('button', { name: t('inventory.onlineGate.stopConfirm') }).tap();
      await expect(stop).toBeHidden();
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expect(
        page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') }),
      ).toHaveCount(0);

      await page.goto('/stock');
      await waitForPageHydration(page);
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expect(
        page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') }),
      ).toBeVisible();
      await expectNoSidewaysScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`stock-notice-${language}.png`) });
      await expectNoAxeViolations(page);
    });
  });
}

// A warehouse person holds stock.view but not catalog.manage: no link, no Locations page, and the
// gate routes answer 403 (AC-17, AC-20).
for (const { language, dir } of LANGUAGES) {
  test.describe(`a warehouse person in ${language}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;

    test.beforeEach(async ({ page, context, baseURL }) => {
      person = await seedAccount({ hats: ['warehouse'], language });
      await signInThroughApi(context, person, baseURL ?? '');
      await useBrowserState(page, { language });
    });
    test.afterEach(async () => {
      const seeded = person;
      person = undefined;
      await seeded?.remove();
    });

    test('sees the line without the link, no Locations page, and gets 403 on the gate routes', async ({
      page,
    }) => {
      const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
      await stubNoOnlineLocation(page);

      await page.goto('/stock');
      await waitForPageHydration(page);
      await expect(page.getByText(t('inventory.onlineGate.notice'))).toBeVisible();
      await expect(
        page.getByRole('link', { name: t('inventory.onlineGate.noticeLink') }),
      ).toHaveCount(0);
      await expect(page.locator('h1')).toHaveCount(1);
      await expectNoAxeViolations(page);

      await page.goto('/locations');
      const main = page.getByRole('main');
      await expect(main.getByText(t('access.noAccess.title'))).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(
        page.getByRole('button', { name: new RegExp(t('inventory.onlineGate.open')) }),
      ).toHaveCount(0);

      const id = randomUUID();
      const calls: [Parameters<typeof api>[1], string, unknown][] = [
        ['GET', `/locations/${id}/online-gate`, undefined],
        ['POST', `/locations/${id}/make-online`, { confirmedVariantCount: 0, reason: 'x' }],
        ['POST', `/locations/${id}/confirm-stock`, {}],
        ['POST', '/locations/online/stop', { reason: 'x' }],
      ];
      for (const [method, path, body] of calls) {
        const answer = await api(page.request, method, path, body);
        expect(answer.status, `${method} ${path}`).toBe(403);
      }
      // stock.view is enough for the status read.
      const status = await api(page.request, 'GET', '/stock/online-status');
      expect(status.status).toBe(200);
    });
  });
}
