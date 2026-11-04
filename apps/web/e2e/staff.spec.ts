import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from './auth';
import {
  removeAccountByEmail,
  seedAccount,
  signInThroughApi,
  signInThroughPage,
  type SeededAccount,
  ownAddress,
} from './accounts';

// Spec 0005 slice 8: the Staff page (AC-12, AC-14, AC-15, AC-25). The admin comes from the
// suite's saved sign in; the staff role person is seeded and signs in through the api.
const created: string[] = [];

// Each test gets its own client address, so the api's per address limits do not carry over.
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders(ownAddress());
});
test.afterEach(async () => {
  for (const email of created.splice(0)) await removeAccountByEmail(email);
});

/** Opens the staff page as the admin and waits for the list. */
async function openStaff(page: Page) {
  await page.goto('/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: /Search staff/ })).toBeVisible();
}

async function addStaff(page: Page, fields: { name: string; email: string }) {
  await page.getByRole('button', { name: 'Add staff' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add staff' });
  await dialog.getByLabel(/^Name/).fill(fields.name);
  await dialog.getByLabel(/^Email/).fill(fields.email);
  await dialog.getByRole('button', { name: 'Save' }).click();
  return dialog;
}

test.describe('as an administrator', () => {
  test('the sidebar and the command palette list Staff (AC-25)', async ({ page, isMobile }) => {
    await page.goto('/');
    // The user menu fills in once /api/me has answered: the page has hydrated and the role is known.
    await expect(page.getByRole('button', { name: new RegExp(E2E_ADMIN.name) })).toBeVisible();
    if (!isMobile) {
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' }),
      ).toBeVisible();
    }
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('option', { name: /Staff/ })).toBeVisible();
  });

  test('creates a person, shows the temporary password once, and the person must change it (AC-12, AC-14)', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = randomUUID().slice(0, 8);
    const email = `e2e-new-${tag}@example.com`;
    const name = `New Hire ${tag}`;
    created.push(email);

    await openStaff(page);
    await addStaff(page, { name, email });

    // With mail off the answer is a temporary password, shown once.
    const setup = page.getByRole('dialog', { name: `Temporary password for ${name}` });
    await expect(setup).toBeVisible();
    const password = (
      await setup.locator('code[aria-labelledby="temporary-label"]').innerText()
    ).trim();
    expect(password).toHaveLength(16);
    await setup.getByRole('button', { name: 'Done' }).click();
    await expect(setup).toHaveCount(0);
    await expect(page.getByText(password)).toHaveCount(0);

    // The person shows in the list as invited, and the password is not on the page again.
    await page.getByRole('searchbox', { name: /Search staff/ }).fill(email);
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Invited');
    await page.reload();
    await expect(page.getByText(password)).toHaveCount(0);

    // The new person signs in with it and is sent to change it before anything else.
    const device = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
    const newcomer = await device.newPage();
    await signInThroughPage(newcomer, { email, password });
    await expect(newcomer).toHaveURL(/\/change-password/);
    await device.close();
  });

  test('disables a person, who then cannot sign in, and enables them again (AC-15)', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const target: SeededAccount = await seedAccount({ role: 'staff' });
    try {
      // A first sign in makes the account active rather than invited.
      const first = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
      await signInThroughApi(first, target, baseURL ?? '');
      await first.close();
      await openStaff(page);
      await page.getByRole('searchbox', { name: /Search staff/ }).fill(target.email);
      const row = page.getByRole('row', { name: new RegExp(target.name) });
      // Only the match is left (plus the header row) before a menu is opened on it.
      await expect(page.getByRole('row')).toHaveCount(2);
      await expect(row).toContainText('Active');

      await row.getByRole('button', { name: `Actions for ${target.name}` }).click();
      await page.getByRole('menuitem', { name: 'Disable' }).click();
      const confirm = page.getByRole('dialog', { name: `Disable ${target.name}?` });
      await confirm.getByLabel(/^Reason/).fill('Left the company');
      await confirm.getByRole('button', { name: 'Disable account' }).click();

      await expect(page.getByText('Account disabled.')).toBeVisible();
      await expect(row).toContainText('Disabled');

      const refused = await request.post('/api/auth/sign-in/email', {
        headers: { origin: new URL(page.url()).origin, ...ownAddress() },
        data: { email: target.email, password: target.password },
      });
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'BANNED_USER' });

      await row.getByRole('button', { name: `Actions for ${target.name}` }).click();
      await page.getByRole('menuitem', { name: 'Enable' }).click();
      await expect(page.getByText('Account enabled.')).toBeVisible();
      await expect(row).toContainText('Active');
    } finally {
      await target.remove();
    }
  });

  test('an empty form names the problems and focuses the first; a duplicate email is refused (AC-12, AC-24)', async ({
    page,
  }) => {
    const target = await seedAccount({ role: 'staff' });
    try {
      await openStaff(page);
      await page.getByRole('button', { name: 'Add staff' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add staff' });
      await dialog.getByRole('button', { name: 'Save' }).click();

      await expect(dialog.getByLabel(/^Name/)).toBeFocused();
      await expect(dialog.getByLabel(/^Name/)).toHaveAccessibleDescription('Enter a name.');
      await expect(dialog.getByLabel(/^Email/)).toHaveAccessibleDescription(
        'Enter an email address.',
      );

      await dialog.getByLabel(/^Name/).fill('Duplicate Person');
      await dialog.getByLabel(/^Email/).fill(target.email);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog.getByLabel(/^Email/)).toBeFocused();
      await expect(dialog.getByLabel(/^Email/)).toHaveAccessibleDescription(
        'Another account already uses this email.',
      );
    } finally {
      await target.remove();
    }
  });

  test('can create a person from the keyboard alone (AC-24)', async ({ page }) => {
    const email = `e2e-kbd-${randomUUID().slice(0, 8)}@example.com`;
    created.push(email);
    await openStaff(page);
    await page.getByRole('button', { name: 'Add staff' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Add staff' }).getByLabel(/^Name/).focus();
    await page.keyboard.type('Keyboard Hire');
    await page.keyboard.press('Tab');
    await page.keyboard.type(email);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog', { name: /^Temporary password for/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('as a person with the staff role', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount;
  // Set once seeding succeeded, and cleared after removal: a failed seed cannot end a pool twice.
  let toRemove: SeededAccount | undefined;

  test.beforeEach(async ({ context, baseURL }) => {
    person = await seedAccount({ role: 'staff' });
    toRemove = person;
    await signInThroughApi(context, person, baseURL ?? '');
  });
  test.afterEach(async () => {
    const seeded = toRemove;
    toRemove = undefined;
    await seeded?.remove();
  });

  test('has no Staff entry in the sidebar or the command palette (AC-25)', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    // The user menu fills in once /api/me has answered; the nav follows the role.
    await expect(page.getByRole('button', { name: new RegExp(person.name) })).toBeVisible();
    if (!isMobile) {
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' }),
      ).toHaveCount(0);
    }
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('option', { name: /Design system/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Staff/ })).toHaveCount(0);
  });

  test('opening /staff by address says only administrators can manage staff (AC-15)', async ({
    page,
  }) => {
    await page.goto('/staff');

    await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
    await expect(page.getByText('Only administrators can manage staff.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add staff' })).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('the staff api answers 403 FORBIDDEN to reads and writes (AC-15)', async ({
    context,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? '').origin;
    const read = await context.request.get('/api/staff');
    expect(read.status()).toBe(403);
    expect(await read.json()).toMatchObject({ code: 'FORBIDDEN' });

    const write = await context.request.post('/api/staff', {
      headers: { origin },
      data: { name: 'Sneaky', email: 'sneaky@example.com', role: 'admin' },
    });
    expect(write.status()).toBe(403);
    expect(await write.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
