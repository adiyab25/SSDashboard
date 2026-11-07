import { expect, test } from '@playwright/test';
import {
  ownAddress,
  seedAccount,
  signInThroughPage,
  type SeededAccount,
  WORKING_HATS,
} from './accounts';

// Spec 0005 AC-28: after a full sign in the person lands on their own audience's pages. The api
// answers every person as staff until spec 0008, so the partner case stubs `/api/me` with the
// 403 `WRONG_AUDIENCE` a partner session gets there, and `/api/partner/me` with a partner.
test.use({ storageState: { cookies: [], origins: [] } });

const PARTNER = {
  id: '0190c0de-0000-7000-8000-0000000000aa',
  name: 'Mona Showroom',
  email: 'mona@showroom.example',
  role: 'staff',
  phone: null,
  staffCode: null,
  language: 'en',
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'partner',
};

let person: SeededAccount;

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders(ownAddress());
  person = await seedAccount({ hats: WORKING_HATS });
});
test.afterEach(async () => {
  await person.remove();
});

test.describe('as a partner user', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/me', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 403,
            json: { code: 'WRONG_AUDIENCE', message: 'Wrong audience' },
          })
        : route.continue(),
    );
    await page.route('**/api/partner/me', (route) => route.fulfill({ json: PARTNER }));
  });

  test('lands on /partner when there is no returnTo', async ({ page }) => {
    await signInThroughPage(page, person);

    await expect(page).toHaveURL(/\/en\/partner$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Partner showroom');
  });

  test('lands on /partner when returnTo points at a staff page (/stock)', async ({ page }) => {
    await signInThroughPage(page, person, '/sign-in?returnTo=%2Fstock');

    await expect(page).toHaveURL(/\/en\/partner$/);
  });

  test('follows a returnTo inside the partner pages', async ({ page }) => {
    await signInThroughPage(page, person, '/sign-in?returnTo=%2Fen%2Fpartner%2Faccount');

    await expect(page).toHaveURL(/\/en\/partner\/account$/);
  });

  test('lands on /partner even when /api/partner/me then fails', async ({ page }) => {
    await page.route('**/api/partner/me', (route) =>
      route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: 'Not found' } }),
    );
    await signInThroughPage(page, person, '/sign-in?returnTo=%2Fstock');

    await expect(page).toHaveURL(/\/en\/partner$/);
  });

  test('sends a partner user with a temporary password to change it, carrying /partner', async ({
    page,
  }) => {
    await page.route('**/api/partner/me', (route) =>
      route.fulfill({ json: { ...PARTNER, mustChangePassword: true } }),
    );
    await signInThroughPage(page, person, '/sign-in?returnTo=%2Fstock');

    await expect(page).toHaveURL(/\/change-password\?returnTo=%2Fpartner$/);
  });
});

test.describe('as a staff person', () => {
  test('lands on / when returnTo points at the partner pages', async ({ page }) => {
    await signInThroughPage(page, person, '/sign-in?returnTo=%2Fen%2Fpartner');

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('keeps a back office returnTo', async ({ page }) => {
    await signInThroughPage(page, person, '/sign-in?returnTo=%2Faccount');

    await expect(page).toHaveURL(/\/account$/);
  });

  test('lands on / when returnTo collapses into another site after normalization', async ({
    page,
    baseURL,
  }) => {
    await signInThroughPage(page, person, '/sign-in?returnTo=%2F.%2F%2Fevil.example');

    await expect(page).toHaveURL(new URL('/', baseURL).href);
  });

  test('goes straight to change password when the password is temporary, carrying returnTo', async ({
    page,
  }) => {
    const temporary = await seedAccount({ hats: WORKING_HATS, mustChangePassword: true });
    try {
      await signInThroughPage(page, temporary, '/sign-in?returnTo=%2Fstock');

      await expect(page).toHaveURL(/\/change-password\?returnTo=%2Fstock$/);
    } finally {
      await temporary.remove();
    }
  });
});
