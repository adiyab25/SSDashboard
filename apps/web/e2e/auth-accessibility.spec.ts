import { expect, test, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi } from './accounts';
import { E2E_ADMIN } from './auth';
import {
  expectNoAxeViolations,
  stubConfig,
  textFor,
  useBrowserState,
  type TextDirection,
  type Theme,
} from './support';

// Spec 0005 slice 8 (AC-24): every new screen has no axe violations (WCAG 2.2 AA tags, the same
// set as the sign in suite) in {light, dark} x {English left to right, Arabic right to left}.
// Each screen is checked in a state that shows its errors where it has them, because that is
// where contrast and association mistakes hide.

const THEMES: readonly Theme[] = ['light', 'dark'];
const DIRECTIONS: readonly TextDirection[] = ['ltr', 'rtl'];

/** Opens a signed out page and waits for the install settings (React has hydrated by then). */
async function openAuthPage(page: Page, path: string) {
  const hydrated = page.waitForResponse((response) => response.url().endsWith('/api/config'));
  await page.goto(path);
  await hydrated;
}

async function expectDirection(page: Page, dir: TextDirection) {
  await expect(page.locator('html')).toHaveAttribute('dir', dir);
  await expect(page.locator('html')).toHaveAttribute('lang', dir === 'rtl' ? 'ar' : 'en');
  // Exactly one h1 per page (AGENTS.md design rule).
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
}

test.describe('auth screens', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of THEMES) {
    for (const dir of DIRECTIONS) {
      const where = `${theme}, ${dir}`;

      test(`forgot password, mail off: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/forgot-password');
        await expect(page.locator('main h1')).toBeVisible();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`forgot password, form with an error: no axe violations in ${where}`, async ({
        page,
      }) => {
        await stubConfig(page, { mailEnabled: true });
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/forgot-password');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#forgot-email')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#forgot-email')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`forgot password, sent confirmation: no axe violations in ${where}`, async ({
        page,
      }) => {
        await stubConfig(page, { mailEnabled: true });
        await page.route('**/api/auth/request-password-reset', (route) =>
          route.fulfill({ json: { status: true } }),
        );
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/forgot-password');
        await page.locator('#forgot-email').fill('someone@example.com');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('main h1')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`invite, form with an error: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/reset-password?token=made-up-token&invite=1');
        await page.locator('#reset-password').fill('short');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#reset-password')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#reset-password')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`reset password, dead link: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/reset-password?error=INVALID_TOKEN');
        await expect(page.locator('main h1')).toBeVisible();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`reset password, form with an error: no axe violations in ${where}`, async ({
        page,
      }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/reset-password?token=made-up-token');
        await page.locator('#reset-password').fill('short');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#reset-password')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#reset-password')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`change password, form with errors: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/change-password');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#change-current')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#change-current')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`change password, weak new password: no axe violations in ${where}`, async ({
        page,
      }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/change-password');
        await page.locator('#change-current').fill('Whatever-1');
        await page.locator('#change-new').fill('weak');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#change-new')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#change-new')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`two factor code step, form with an error: no axe violations in ${where}`, async ({
        page,
      }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/two-factor');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('#two-factor-code')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#two-factor-code')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`two factor code step, wrong code answer: no axe violations in ${where}`, async ({
        page,
      }) => {
        await page.route('**/api/auth/two-factor/verify-totp', (route) =>
          route.fulfill({ status: 401, json: { code: 'INVALID_CODE', message: 'Invalid code' } }),
        );
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/two-factor');
        await page.locator('#two-factor-code').fill('000000');
        await page.locator('form button[type=submit]').click();
        await expect(page.locator('form [role=alert]')).toBeVisible();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`two factor backup code step: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await openAuthPage(page, '/two-factor');
        await page.locator('form button[type=button]').click();
        await expect(page.locator('#two-factor-code')).toBeVisible();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });
    }
  }
});

test.describe('auth screens, keyboard', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const dir of DIRECTIONS) {
    test(`sign in page tabs through its controls in order in ${dir}`, async ({ page }) => {
      await useBrowserState(page, { dir });
      await openAuthPage(page, '/sign-in');
      await expectDirection(page, dir);

      // The skip link comes first; then the form runs top to bottom.
      await page.keyboard.press('Tab');
      await expect(page.locator('a[href="#main-content"]')).toBeFocused();
      await page.locator('#sign-in-email').focus();
      await page.keyboard.press('Tab');
      await expect(page.locator('#sign-in-password')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('a[href="/forgot-password"]')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('form button[type=submit]')).toBeFocused();
    });

    test(`the other auth screens have a labelled, focusable first field in ${dir}`, async ({
      page,
    }) => {
      await useBrowserState(page, { dir });
      for (const [path, field] of [
        ['/change-password', '#change-current'],
        ['/two-factor', '#two-factor-code'],
        ['/reset-password?token=made-up-token', '#reset-password'],
      ] as const) {
        await openAuthPage(page, path);
        await expectDirection(page, dir);
        await page.locator(field).focus();
        await expect(page.locator(field)).toBeFocused();
        await expect(page.locator(field)).toHaveAccessibleName(/.+/);
      }
    });
  }
});

test.describe('account page', () => {
  for (const theme of THEMES) {
    for (const dir of DIRECTIONS) {
      const where = `${theme}, ${dir}`;

      test(`account with a field error: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await page.goto('/account');
        await expect(page.locator('#account-name')).toHaveValue(E2E_ADMIN.name);
        await page.locator('#account-name').fill('');
        await page.locator('#account-name').press('Enter');
        await expect(page.locator('#account-name')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#account-name')).toBeFocused();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`account two factor enrolment dialog: no axe violations in ${where}`, async ({
        page,
      }) => {
        await useBrowserState(page, { theme, dir });
        await page.goto('/account');
        await expect(page.locator('#account-name')).toBeVisible();
        // Opens the enrolment dialog on its password step, and submits it empty for the error.
        await page.locator('section[aria-labelledby=two-factor-title] button').first().click();
        await page.locator('[role=dialog] form button[type=submit]').click();
        await expect(page.locator('#enable-password')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#enable-password')).toBeFocused();

        await expectNoAxeViolations(page);
      });
    }
  }
});

test.describe('staff page', () => {
  for (const theme of THEMES) {
    for (const dir of DIRECTIONS) {
      const where = `${theme}, ${dir}`;

      test(`staff list as an admin: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await page.goto('/staff');
        await expect(page.getByRole('row', { name: new RegExp(E2E_ADMIN.name) })).toBeVisible();

        await expectNoAxeViolations(page);
        await expectDirection(page, dir);
      });

      test(`staff add dialog with errors: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await page.goto('/staff');
        await expect(page.getByRole('row', { name: new RegExp(E2E_ADMIN.name) })).toBeVisible();
        await page.getByRole('button', { name: textFor(dir, 'staff.add') }).click();
        await page.locator('[role=dialog] form button[type=submit]').click();
        await expect(page.locator('#staff-name')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#staff-name')).toBeFocused();

        await expectNoAxeViolations(page);
      });

      test(`staff row menu open: no axe violations in ${where}`, async ({ page }) => {
        await useBrowserState(page, { theme, dir });
        await page.goto('/staff');
        const row = page.getByRole('row', { name: new RegExp(E2E_ADMIN.name) });
        await expect(row).toBeVisible();
        await row.getByRole('button').click();
        await expect(page.getByRole('menu')).toBeVisible();

        await expectNoAxeViolations(page);
      });
    }
  }

  test.describe('as a person with the staff role', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const theme of THEMES) {
      for (const dir of DIRECTIONS) {
        test(`staff forbidden message: no axe violations in ${theme}, ${dir}`, async ({
          page,
          context,
          baseURL,
        }) => {
          const person = await seedAccount({ role: 'staff' });
          try {
            await signInThroughApi(context, person, baseURL ?? '');
            await useBrowserState(page, { theme, dir });
            await page.goto('/staff');
            await expect(
              page.getByRole('paragraph').filter({ hasText: /./ }).first(),
            ).toBeVisible();
            await expect(page.locator('main h1')).toBeVisible();
            await expect(page.getByRole('button', { name: new RegExp(person.name) })).toBeVisible();

            await expectNoAxeViolations(page);
            await expectDirection(page, dir);
          } finally {
            await person.remove();
          }
        });
      }
    }
  });
});
