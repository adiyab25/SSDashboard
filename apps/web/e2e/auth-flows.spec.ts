import { expect, test, type Page } from '@playwright/test';
import {
  seedAccount,
  signInThroughApi,
  signInThroughPage,
  totp,
  type SeededAccount,
  ownAddress,
  WORKING_HATS,
} from './accounts';
import { stubConfig, useBrowserState, waitForFormHydration } from './support';

// Spec 0005 slice 8: the forgot, reset, forced change and two factor screens (AC-7, AC-10,
// AC-14, AC-20, AC-24). These start signed out; the tests that need a person seed their own.
// They need the dev api running with MAIL_DRIVER=none (the forgot password test checks it).
test.use({ storageState: { cookies: [], origins: [] } });

// Each test gets its own client address, so the api's per address limits do not carry over.
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders(ownAddress());
});

const NEW_PASSWORD = 'Brand-New-Pass-9';

/** Opens an auth page and waits for the install settings, which load once React has taken over. */
async function openAuthPage(page: Page, path: string) {
  const hydrated = page.waitForResponse((response) => response.url().endsWith('/api/config'));
  await page.goto(path);
  await hydrated;
}

test.describe('forgot password', () => {
  test('with mail off tells the person to ask an administrator and sends nothing (AC-10)', async ({
    page,
    request,
  }) => {
    expect((await (await request.get('/api/config')).json()) as unknown).toMatchObject({
      mailEnabled: false,
    });
    const sent: string[] = [];
    page.on('request', (call) => {
      if (/request-password-reset/.test(call.url())) sent.push(call.url());
    });

    await openAuthPage(page, '/forgot-password');

    await expect(
      page.getByRole('heading', { level: 1, name: 'Ask an administrator' }),
    ).toBeVisible();
    await expect(page.getByText('This install does not send email.')).toBeVisible();
    await expect(page.getByLabel(/^Email/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(sent).toEqual([]);
  });

  test('is reachable from the sign in page by keyboard (AC-24)', async ({ page }) => {
    await openAuthPage(page, '/sign-in');
    // Real Tab presses from the email field prove the order: password, then the link.
    await page.getByLabel(/^Email/).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/^Password/)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Forgot your password?' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test.describe('with mail on', () => {
    test.beforeEach(async ({ page }) => {
      await stubConfig(page, { mailEnabled: true });
    });

    test('an empty or malformed email is announced and focus moves to the field (AC-24)', async ({
      page,
    }) => {
      await openAuthPage(page, '/forgot-password');
      const email = page.getByLabel(/^Email/);

      await page.getByRole('button', { name: 'Send reset link' }).click();
      await expect(email).toBeFocused();
      await expect(email).toHaveAttribute('aria-invalid', 'true');
      await expect(email).toHaveAccessibleDescription('Enter your email address.');

      await email.fill('not-an-email');
      await page.keyboard.press('Enter');
      await expect(email).toBeFocused();
      await expect(email).toHaveAccessibleDescription(/Enter a valid email address/);
    });

    test('any email gets the same neutral answer and focus moves to it (AC-9)', async ({
      page,
    }) => {
      await openAuthPage(page, '/forgot-password');
      await page.getByLabel(/^Email/).fill('nobody-here@example.com');
      await page.keyboard.press('Enter');

      const heading = page.getByRole('heading', { level: 1, name: 'Check your email' });
      await expect(heading).toBeFocused();
      await expect(page.getByRole('status')).toContainText('If that email belongs to an account');
    });
  });
});

test.describe('reset password', () => {
  test('a link with no token says the link is no longer valid and focuses the heading (AC-9)', async ({
    page,
  }) => {
    await openAuthPage(page, '/reset-password');

    const heading = page.getByRole('heading', { level: 1, name: 'This link is no longer valid' });
    await expect(heading).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test('a bad token sent through the api lands on the invalid screen (AC-9)', async ({ page }) => {
    await page.goto('/api/auth/reset-password/not-a-real-token?callbackURL=%2Freset-password');

    await expect(page).toHaveURL(/\/reset-password\?.*error=INVALID_TOKEN/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'This link is no longer valid' }),
    ).toBeVisible();
  });

  test('a made up token is refused when the password is saved (AC-9)', async ({ page }) => {
    await page.goto('/reset-password?token=made-up-token');
    await waitForFormHydration(page);
    const field = page.getByLabel(/^New password/);

    // A weak password never leaves the browser: it names the rule and keeps focus on the field.
    await field.fill('short');
    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    await field.fill(NEW_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { level: 1, name: 'This link is no longer valid' }),
    ).toBeFocused();
  });

  test('the invite wording shows for ?invite=1 (AC-13)', async ({ page }) => {
    await page.goto('/reset-password?token=made-up-token&invite=1');
    await waitForFormHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Set your password' })).toBeVisible();
  });

  test('paste into the password field is allowed (AC-24)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/reset-password?token=made-up-token');
    await waitForFormHydration(page);
    await page.evaluate((value) => navigator.clipboard.writeText(value), NEW_PASSWORD);
    const field = page.getByLabel(/^New password/);
    await field.focus();
    await page.keyboard.press('ControlOrMeta+V');

    await expect(field).toHaveValue(NEW_PASSWORD);
  });
});

test.describe('forced password change', () => {
  let person: SeededAccount;
  // Set once seeding succeeded, and cleared after removal: a failed seed cannot end a pool twice.
  let toRemove: SeededAccount | undefined;

  test.beforeEach(async ({ context, baseURL }) => {
    person = await seedAccount({ hats: WORKING_HATS, mustChangePassword: true });
    toRemove = person;
    await signInThroughApi(context, person, baseURL ?? '');
  });
  test.afterEach(async () => {
    const seeded = toRemove;
    toRemove = undefined;
    await seeded?.remove();
  });

  test('every page redirects to change password, keeps returnTo, and only me and sign out work (AC-14, AC-7)', async ({
    page,
    context,
  }) => {
    const request = context.request;
    await page.goto('/design?tab=color');

    await expect(page).toHaveURL(/\/change-password\?returnTo=%2Fdesign%3Ftab%3Dcolor$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Change your password' }),
    ).toBeVisible();

    expect((await request.get('/api/me')).status()).toBe(200);
    const blocked = await request.get('/api/locations');
    expect(blocked.status()).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  test('an empty submit names the first problem and focuses it, then a weak and a wrong password are refused (AC-24)', async ({
    page,
  }) => {
    await page.goto('/change-password');
    await waitForFormHydration(page);
    await page.getByRole('button', { name: 'Change password' }).click();

    const current = page.getByLabel(/^Current password/);
    await expect(current).toBeFocused();
    await expect(current).toHaveAccessibleDescription('Enter your current password.');

    await current.fill(person.password);
    await page.getByLabel(/^New password/).fill('weak');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/^New password/)).toBeFocused();
    await expect(page.getByLabel(/^New password/)).toHaveAttribute('aria-invalid', 'true');

    await current.fill('Not-The-Password-1');
    await page.getByLabel(/^New password/).fill(NEW_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('form').getByRole('alert')).toContainText(
      'The current password is not right',
    );
    await expect(page).toHaveURL(/\/change-password$/);
  });

  test('changes the password from the keyboard alone and lands on the page asked for (AC-14, AC-7, AC-24)', async ({
    page,
    context,
  }) => {
    const request = context.request;
    await page.goto('/design?tab=color');
    await expect(page).toHaveURL(/\/change-password\?returnTo=/);
    await waitForFormHydration(page);

    await page.getByLabel(/^Current password/).focus();
    await page.keyboard.type(person.password);
    await page.keyboard.press('Tab');
    await page.keyboard.type(NEW_PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/design\?tab=color$/);
    const me = await request.get('/api/me');
    expect(await me.json()).toMatchObject({ email: person.email, mustChangePassword: false });
    expect((await request.get('/api/locations')).status()).toBe(200);
  });

  test('an off site returnTo is ignored after the change (AC-7)', async ({ page }) => {
    await page.goto('/change-password?returnTo=%2F%2Fevil.example');
    await waitForFormHydration(page);
    await page.getByLabel(/^Current password/).fill(person.password);
    await page.getByLabel(/^New password/).fill(NEW_PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/');
  });

  test('paste into both password fields is allowed (AC-24)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/change-password');
    await waitForFormHydration(page);
    await page.evaluate((value) => navigator.clipboard.writeText(value), NEW_PASSWORD);
    for (const label of [/^Current password/, /^New password/]) {
      const field = page.getByLabel(label);
      await field.focus();
      await page.keyboard.press('ControlOrMeta+V');
      await expect(field).toHaveValue(NEW_PASSWORD);
    }
  });

  test('Sign out instead ends the session and opens sign in (AC-6)', async ({ page }) => {
    await page.goto('/change-password');
    await waitForFormHydration(page);
    await page.getByRole('button', { name: 'Sign out instead' }).click();

    await expect(page).toHaveURL(/\/sign-in$/);
    // The session really ended, not just the page.
    expect((await page.request.get('/api/me')).status()).toBe(401);
  });
});

test.describe('two factor sign in', () => {
  let person: SeededAccount;
  // Set once seeding succeeded, and cleared after removal: a failed seed cannot end a pool twice.
  let toRemove: SeededAccount | undefined;

  test.beforeEach(async () => {
    person = await seedAccount({ hats: WORKING_HATS });
    toRemove = person;
  });
  test.afterEach(async () => {
    const seeded = toRemove;
    toRemove = undefined;
    await seeded?.remove();
  });

  test('enrol on the account page, then sign in asks for a code; a wrong code is announced; a backup code works once (AC-20, AC-24)', async ({
    page,
    context,
    browser,
    baseURL,
  }) => {
    test.slow();
    await signInThroughApi(context, person, baseURL ?? '');

    // Enrol: password, then the key, then the first code, then the backup codes.
    await page.goto('/account');
    await page.getByRole('button', { name: 'Turn on' }).click();
    // The dialog's name follows the step, so it is found by role alone.
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Password/).fill(person.password);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    const key = (await page.locator('code[aria-labelledby="setup-key-label"]').innerText()).replace(
      /\s/g,
      '',
    );
    await dialog.getByLabel(/^Code from the app/).fill(totp(key));
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    await expect(dialog.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible();
    const backupCodes = (await dialog.getByLabel('Backup codes').innerText())
      .split(/\s+/)
      .filter(Boolean);
    expect(backupCodes).toHaveLength(10);
    await dialog.getByRole('button', { name: 'I saved them' }).click();

    // A new browser: the password step now leads to the code step, carrying returnTo.
    const fresh = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
    const second = await fresh.newPage();
    await signInThroughPage(second, person, '/sign-in?returnTo=%2Fdesign');
    await expect(second).toHaveURL(/\/two-factor\?returnTo=%2Fdesign$/);
    await waitForFormHydration(second);
    await expect(second.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();

    const code = second.getByLabel(/^Code/);
    await second.getByRole('button', { name: 'Verify' }).click();
    await expect(code).toBeFocused();
    await expect(code).toHaveAccessibleDescription('Enter the code.');

    await code.fill('000000');
    await second.keyboard.press('Enter');
    await expect(second.getByRole('form').getByRole('alert')).toContainText(
      'That code is not right',
    );
    await expect(code).toBeFocused();

    await second.getByRole('button', { name: 'Use a backup code instead' }).click();
    await second.getByLabel(/^Backup code/).fill(backupCodes[0] ?? '');
    await second.keyboard.press('Enter');
    await expect(second).toHaveURL(/\/design$/);
    await fresh.close();

    // The same backup code does not work a second time.
    const again = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
    const third = await again.newPage();
    await signInThroughPage(third, person);
    await expect(third).toHaveURL(/\/two-factor$/);
    await waitForFormHydration(third);
    await third.getByRole('button', { name: 'Use a backup code instead' }).click();
    await third.getByLabel(/^Backup code/).fill(backupCodes[0] ?? '');
    await third.keyboard.press('Enter');
    await expect(third.getByRole('form').getByRole('alert')).toContainText('already used');

    // The authenticator app code still works.
    await third.getByRole('button', { name: 'Use my authenticator app instead' }).click();
    await third.getByLabel(/^Code/).fill(totp(key, Date.now() + 30_000));
    await third.keyboard.press('Enter');
    await expect(third).toHaveURL('/');
    await again.close();
  });

  test('a code step with no password step before it says to start again (AC-20)', async ({
    page,
  }) => {
    await page.goto('/two-factor');
    await waitForFormHydration(page);
    await page.getByLabel(/^Code/).fill('123456');
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('heading', { level: 1, name: /expired or was stopped/ }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
  });

  test('paste into the code field is allowed (AC-24)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/two-factor');
    await waitForFormHydration(page);
    await page.evaluate(() => navigator.clipboard.writeText('123456'));
    const field = page.getByLabel(/^Code/);
    await field.focus();
    await page.keyboard.press('ControlOrMeta+V');

    await expect(field).toHaveValue('123456');
  });
});

test('a dead reset link moves focus to its heading in Arabic too (AC-24)', async ({ page }) => {
  await useBrowserState(page, { dir: 'rtl' });
  await openAuthPage(page, '/reset-password?error=INVALID_TOKEN');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
});

test('the sign in screens keep working in Arabic (AC-24)', async ({ page }) => {
  await useBrowserState(page, { dir: 'rtl' });
  await openAuthPage(page, '/forgot-password');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(
    page.getByRole('heading', { level: 1, name: 'اطلب المساعدة من المسؤول' }),
  ).toBeVisible();
});
