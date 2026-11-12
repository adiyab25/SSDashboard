import { expect, test, type Page, type Route } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import {
  expectNoAxeViolations,
  openShell,
  textFor,
  useBrowserState,
  waitForFormHydration,
  type TextDirection,
} from './support';

// Spec 0015 milestone (AC-1, AC-2, AC-27): the /connections list and the /connections/new Shopify
// connect form. A manager sees the nav entry, the list, and the form; contract messages show in
// words; the exact contract body is sent and the secret never lingers; each api refusal reads on
// its own field; reasons and warnings read as sentences; a person without `settings.manage` gets the
// no access state on both routes; the screens pass axe in English and Arabic.
//
// Nothing reaches Shopify: the connect call and the populated list are answered in the browser with
// `page.route`. The empty list comes from the real api. Every `.myshopify.com` name below lives only
// inside a mocked request.

const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

const VALID_BODY = {
  label: 'Test Brand',
  storeCode: 'TB-1',
  shopDomain: 'test-brand.myshopify.com',
  clientId: 'client-id-abc123',
  clientSecret: 'shpss_super_secret_value_9f8e7d',
  appOwner: 'organization',
} as const;

const NEW_ID = '7b0f6a4e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';

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

/**
 * Opens the navigation and returns where its links are: the sidebar on desktop, and on a phone the
 * sheet behind the menu button. The click is retried until the sheet shows, because a tap that comes
 * before React has taken over the button is lost.
 */
async function openNavigation(page: Page, isMobile: boolean, menuName: string) {
  if (!isMobile) return page.getByRole('navigation').first();
  const sheet = page.getByRole('dialog');
  await expect(async () => {
    await page.getByRole('button', { name: menuName }).click();
    await expect(sheet).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return sheet;
}

/** Answers the list with the populated page, in the browser only. */
async function mockPopulatedList(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/connections',
    (route: Route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: POPULATED }) : route.fallback(),
  );
}

/** Answers the list with no rows, so a landing after a connect never depends on the real api. */
async function mockEmptyList(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/connections',
    (route: Route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: [], nextCursor: null } })
        : route.fallback(),
  );
}

/** Answers the connect call with this status and body, and records each request body it receives. */
async function mockConnect(page: Page, status: number, json: unknown) {
  const bodies: unknown[] = [];
  await page.route(
    (url) => url.pathname === '/api/connections/shopify',
    async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status, json });
    },
  );
  return bodies;
}

/** Types every field of the form. Each call needs the secret again: the form clears it on send. */
async function fillForm(page: Page, body: Record<string, string> = VALID_BODY) {
  await page.locator('#connection-label').fill(body.label ?? '');
  await page.locator('#connection-store-code').fill(body.storeCode ?? '');
  await page.locator('#connection-shop-domain').fill(body.shopDomain ?? '');
  await page.locator('#connection-client-id').fill(body.clientId ?? '');
  await page.locator('#connection-client-secret').fill(body.clientSecret ?? '');
}

for (const { dir, name: languageName } of LANGUAGES) {
  const t = (key: Parameters<typeof textFor>[1]) => textFor(dir, key);
  const language = dir === 'rtl' ? 'ar' : 'en';

  // The suite's saved sign in is a manager (settings.manage).
  test.describe(`connections as a manager in ${languageName}`, () => {
    test.beforeEach(async ({ page }) => {
      await useBrowserState(page, { dir });
    });

    test('the nav entry opens an empty list, and the list passes axe', async ({
      page,
      isMobile,
    }) => {
      await openShell(page);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      const nav = await openNavigation(page, isMobile, t('shell.topbar.menu'));
      const link = nav.getByRole('link', { name: t('shell.nav.items.connections') });
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL('/connections');

      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(
        page.getByRole('heading', { level: 1, name: t('connections.title') }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByText(t('connections.emptyTitle'))).toBeVisible();
      await expect(
        page.getByRole('main').getByRole('link', { name: t('connections.newConnection') }),
      ).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test('the populated list shows each reason and warning in words and passes axe', async ({
      page,
    }) => {
      await mockPopulatedList(page);
      await page.goto('/connections');
      const table = page.getByRole('table', { name: t('connections.tableLabel') });
      await expect(table).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      const working = table.getByRole('row').filter({ hasText: 'Working Brand' });
      await expect(working.getByText(t('connections.health.ok'), { exact: true })).toBeVisible();
      await expect(
        working.getByText(t('connections.warnings.SHOP_TIMEZONE_DIFFERS')),
      ).toBeVisible();

      const connecting = table.getByRole('row').filter({ hasText: 'New Brand' });
      await expect(connecting.getByText(t('connections.health.connecting'))).toBeVisible();

      const failing = table.getByRole('row').filter({ hasText: 'Broken Brand' });
      await expect(failing.getByText(t('connections.health.failing'))).toBeVisible();
      await expect(failing.getByText(t('connections.reasons.APP_NOT_INSTALLED'))).toBeVisible();
      // A raw code is never the only thing a manager reads.
      await expect(table.getByText('APP_NOT_INSTALLED')).toHaveCount(0);
      await expect(table.getByText('SHOP_TIMEZONE_DIFFERS')).toHaveCount(0);
      await expectNoAxeViolations(page);
    });

    test('the form: secret field, contract messages, one h1, axe', async ({ page }) => {
      await page.goto('/connections');
      await expect(page.getByText(t('connections.emptyTitle'))).toBeVisible();
      await page
        .getByRole('main')
        .getByRole('link', { name: t('connections.newConnection') })
        .click();
      await expect(page).toHaveURL('/connections/new');
      await expect(
        page.getByRole('heading', { level: 1, name: t('connections.form.title') }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await waitForFormHydration(page);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);

      const secret = page.locator('#connection-client-secret');
      await expect(secret).toHaveAttribute('type', 'password');
      await expect(secret).toHaveAttribute('autocomplete', 'off');
      await expectNoAxeViolations(page);

      // A bad store code and a bad domain read the contract's refusal in words.
      await page.locator('#connection-store-code').fill('bad code!');
      await page.locator('#connection-shop-domain').fill('example.com');
      const bodies = await mockConnect(page, 201, { id: NEW_ID, health: 'connecting' });
      // Errors show on submit, never on blur, so a click on Connect is never lost to a moving button.
      await page.getByRole('button', { name: t('connections.form.submit') }).click();
      await expect(page.locator('#connection-store-code-error')).toHaveText(
        t('connections.form.errors.storeCodeInvalid'),
      );
      await expect(page.locator('#connection-shop-domain-error')).toHaveText(
        t('connections.form.errors.shopDomainInvalid'),
      );
      await expect(page.locator('#connection-store-code')).toHaveAttribute('aria-invalid', 'true');

      // The same submit asks for every other field too and sends nothing.
      await expect(page.locator('#connection-label-error')).toHaveText(
        t('connections.form.errors.labelRequired'),
      );
      await expect(page.locator('#connection-client-id-error')).toHaveText(
        t('connections.form.errors.clientIdRequired'),
      );
      await expect(page.locator('#connection-client-secret-error')).toHaveText(
        t('connections.form.errors.clientSecretRequired'),
      );
      expect(bodies).toEqual([]);
      await expectNoAxeViolations(page);
    });

    test('a submit sends the exact contract body, clears the secret, and lands on the list', async ({
      page,
    }) => {
      const bodies = await mockConnect(page, 201, { id: NEW_ID, health: 'connecting' });
      await mockEmptyList(page);
      await page.goto('/connections/new');
      await waitForFormHydration(page);
      await fillForm(page);
      // Spaces and capitals around the domain are the form's to tidy: the contract trims and lowers.
      await page.locator('#connection-shop-domain').fill('  Test-Brand.myshopify.com ');
      await page.getByRole('radio', { name: t('connections.form.appOwnerPerson') }).click();

      const sent = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/api/connections/shopify',
      );
      await page.getByRole('button', { name: t('connections.form.submit') }).click();
      const request = await sent;
      expect(request.method()).toBe('POST');

      await expect(page).toHaveURL('/connections');
      expect(bodies).toEqual([{ ...VALID_BODY, appOwner: 'person' }]);
      // The secret is nowhere on the page after the send.
      await expect(
        page.getByRole('heading', { level: 1, name: t('connections.title') }),
      ).toBeVisible();
      expect(await page.locator('body').innerText()).not.toContain(VALID_BODY.clientSecret);
      expect(await page.content()).not.toContain(VALID_BODY.clientSecret);
      expect(page.url()).not.toContain(VALID_BODY.clientSecret);
    });

    const REFUSALS = [
      {
        name: 'SHOP_ALREADY_CONNECTED',
        status: 409,
        code: 'SHOP_ALREADY_CONNECTED',
        field: '#connection-shop-domain-error',
        text: 'connections.form.errors.SHOP_ALREADY_CONNECTED',
      },
      {
        name: 'STORE_CODE_TAKEN',
        status: 409,
        code: 'STORE_CODE_TAKEN',
        field: '#connection-store-code-error',
        text: 'connections.form.errors.STORE_CODE_TAKEN',
      },
      {
        name: 'INVALID_SHOP_DOMAIN',
        status: 422,
        code: 'INVALID_SHOP_DOMAIN',
        field: '#connection-shop-domain-error',
        text: 'connections.form.errors.INVALID_SHOP_DOMAIN',
      },
    ] as const;

    for (const refusal of REFUSALS) {
      test(`${refusal.name} is shown in words on its field and the secret is cleared`, async ({
        page,
      }) => {
        await mockConnect(page, refusal.status, {
          statusCode: refusal.status,
          code: refusal.code,
          message: refusal.code,
        });
        await page.goto('/connections/new');
        await waitForFormHydration(page);
        await fillForm(page);
        await page.getByRole('button', { name: t('connections.form.submit') }).click();

        await expect(page.locator(refusal.field)).toHaveText(t(refusal.text));
        await expect(page).toHaveURL('/connections/new');
        // The owner has to type the secret again, and it is not in the page.
        await expect(page.locator('#connection-client-secret')).toHaveValue('');
        expect(await page.content()).not.toContain(VALID_BODY.clientSecret);
        await expect(
          page.getByRole('button', { name: t('connections.form.submit') }),
        ).toBeEnabled();
        await expectNoAxeViolations(page);
      });
    }

    test('the form works by keyboard alone', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a keyboard path is a desktop concern');
      const bodies = await mockConnect(page, 201, { id: NEW_ID, health: 'connecting' });
      await mockEmptyList(page);
      await page.goto('/connections/new');
      await waitForFormHydration(page);

      await page.locator('#connection-label').focus();
      await page.keyboard.type(VALID_BODY.label);
      await page.keyboard.press('Tab');
      await expect(page.locator('#connection-store-code')).toBeFocused();
      await page.keyboard.type(VALID_BODY.storeCode);
      await page.keyboard.press('Tab');
      await expect(page.locator('#connection-shop-domain')).toBeFocused();
      await page.keyboard.type(VALID_BODY.shopDomain);
      await page.keyboard.press('Tab');
      await expect(page.locator('#connection-client-id')).toBeFocused();
      await page.keyboard.type(VALID_BODY.clientId);
      await page.keyboard.press('Tab');
      await expect(page.locator('#connection-client-secret')).toBeFocused();
      await page.keyboard.type(VALID_BODY.clientSecret);
      // The owner group is one tab stop; the arrows move between its two choices.
      await page.keyboard.press('Tab');
      await expect(
        page.getByRole('radio', { name: t('connections.form.appOwnerOrganization') }),
      ).toBeFocused();
      await page.keyboard.press(dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
      // Finding: in this build an arrow only moves focus; Space checks the choice.
      await expect(
        page.getByRole('radio', { name: t('connections.form.appOwnerPerson') }),
      ).toBeFocused();
      await page.keyboard.press('Space');
      await expect(
        page.getByRole('radio', { name: t('connections.form.appOwnerPerson') }),
      ).toBeChecked();
      await page.keyboard.press('Tab');
      const submit = page.getByRole('button', { name: t('connections.form.submit') });
      await expect(submit).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL('/connections');
      expect(bodies).toEqual([{ ...VALID_BODY, appOwner: 'person' }]);
    });

    test('keyboard focus lands in the form when the language is slow to load', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a keyboard path is a desktop concern');
      test.skip(dir === 'ltr', 'only a language other than English hides the page while it loads');
      // A slow /api/config keeps the page hidden after the form hydrates, as a loaded machine
      // did; the hydration wait must also wait for the page to show (see e2e/support.ts).
      await page.route('**/api/config', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await route.fallback();
      });
      await page.goto('/connections/new');
      await waitForFormHydration(page);

      await page.locator('#connection-label').focus();
      await expect(page.locator('#connection-label')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#connection-store-code')).toBeFocused();
    });
  });

  test.describe(`connections without settings.manage in ${languageName}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    let person: SeededAccount | undefined;

    for (const hat of ['support', 'warehouse'] as const) {
      test(`a ${hat} person gets the no access state on both routes and no nav entry`, async ({
        page,
        context,
        baseURL,
        isMobile,
      }) => {
        person = await seedAccount({ hats: [hat], language });
        try {
          await signInThroughApi(context, person, baseURL ?? '');
          await useBrowserState(page, { language });
          const asked: string[] = [];
          page.on('request', (request) => {
            const url = new URL(request.url());
            // The shell's Shopify freshness line is shown to every hat with orders.view
            // (spec 0015 AC-18, AC-27), so its read is allowed; every other
            // connections call stays refused.
            if (request.method() === 'GET' && url.pathname === '/api/connections/freshness') {
              return;
            }
            if (url.pathname.startsWith('/api/connections')) {
              asked.push(`${request.method()} ${url.pathname}`);
            }
          });

          for (const [path, title] of [
            ['/connections', 'connections.title'],
            ['/connections/new', 'connections.form.title'],
          ] as const) {
            await page.goto(path);
            const main = page.getByRole('main');
            await expect(main.getByText(t('access.noAccess.title'))).toBeVisible();
            await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
            await expect(main.getByRole('heading', { level: 1, name: t(title) })).toBeVisible();
            await expect(main.getByRole('table')).toHaveCount(0);
            await expect(main.locator('form')).toHaveCount(0);
            await expectNoAxeViolations(page);
          }
          await page.waitForLoadState('networkidle');
          expect(asked).toEqual([]);

          await openShell(page);
          const nav = await openNavigation(page, isMobile, t('shell.topbar.menu'));
          await expect(nav.getByRole('link', { name: t('shell.nav.items.home') })).toBeVisible();
          await expect(
            nav.getByRole('link', { name: t('shell.nav.items.connections'), exact: true }),
          ).toHaveCount(0);
        } finally {
          const seeded = person;
          person = undefined;
          await seeded?.remove();
        }
      });
    }
  });
}
