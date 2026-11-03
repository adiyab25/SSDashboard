import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from './auth';
import { expectNoAxeViolations, stubConfig, useBrowserState } from './support';

// Spec 0005 slice 1: these tests start signed out, unlike the rest of the suite.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Opens the sign in page and waits for hydration. The install name loads from `/api/config`
 * only after React has taken over, and a click before that would submit the form natively.
 */
async function openSignIn(page: Page, path = '/sign-in') {
  const hydrated = page.waitForResponse((response) => response.url().endsWith('/api/config'));
  await page.goto(path);
  await hydrated;
}

async function signIn(page: Page, password: string = E2E_ADMIN.password) {
  await page.getByLabel(/^Email/).fill(E2E_ADMIN.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('signed out', () => {
  test('a shell page redirects to sign in and remembers where the person was going (AC-7)', async ({
    page,
  }) => {
    await page.goto('/design?tab=color');

    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fdesign%3Ftab%3Dcolor$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('every api route but config and health answers 401 (AC-7)', async ({ request }) => {
    for (const path of ['/api/me', '/api/locations']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect((await request.get('/api/config')).status()).toBe(200);
  });

  test('signs in, lands on the page asked for, shows the person, and signs out (AC-1, AC-6, AC-25)', async ({
    page,
  }) => {
    await openSignIn(page, '/sign-in?returnTo=%2Fdesign');
    await signIn(page);

    await expect(page).toHaveURL(/\/design$/);
    // The menu fills in once GET /api/me has answered.
    const trigger = page.getByRole('button', { name: new RegExp(E2E_ADMIN.name) });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.getByText(E2E_ADMIN.email)).toBeVisible();
    await expect(page.getByText('Administrator')).toBeVisible();

    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    // The old session is gone: going back to a shell page asks for sign in again.
    await page.goto('/design');
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fdesign$/);
  });

  test('ignores a returnTo that points off site (AC-7)', async ({ page }) => {
    await openSignIn(page, '/sign-in?returnTo=%2F%2Fevil.example');
    await signIn(page);

    await expect(page).toHaveURL(/localhost(:\d+)?\/$/);
  });

  test('a wrong password gets the generic answer and keeps the typed email (AC-2)', async ({
    page,
  }) => {
    await openSignIn(page);
    await signIn(page, 'Wrong-Password-1');

    await expect(page.getByRole('form', { name: 'Sign in' }).getByRole('alert')).toContainText(
      'The email or password is not right',
    );
    await expect(page.getByLabel(/^Email/)).toHaveValue(E2E_ADMIN.email);
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('an empty submit names the problems and focuses the first field (AC-24)', async ({
    page,
  }) => {
    await openSignIn(page);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByLabel(/^Email/)).toBeFocused();
    await expect(page.getByLabel(/^Email/)).toHaveAccessibleDescription(
      'Enter your email address.',
    );
  });

  test('works from the keyboard alone (AC-24)', async ({ page }) => {
    await openSignIn(page, '/sign-in?returnTo=%2Fdesign');
    await page.getByLabel(/^Email/).focus();
    await page.keyboard.type(E2E_ADMIN.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(E2E_ADMIN.password);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/design$/);
  });
});

test.describe('sign in screen accessibility (AC-24)', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const dir of ['ltr', 'rtl'] as const) {
      test(`has no axe violations in ${theme}, ${dir}, with an error showing`, async ({ page }) => {
        await stubConfig(page);
        await useBrowserState(page, { theme, dir });
        await openSignIn(page);
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#sign-in-email')).toHaveAttribute('aria-invalid', 'true');

        await expectNoAxeViolations(page);
        await expect(page.locator('html')).toHaveAttribute('dir', dir);
      });
    }
  }
});
