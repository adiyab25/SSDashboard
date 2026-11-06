import { expect, test, type Page } from '@playwright/test';
import {
  seedAccount,
  signInThroughApi,
  signInThroughPage,
  type SeededAccount,
  ownAddress,
} from './accounts';
import { languageCookie } from './support';

// Spec 0005 slice 8: the Account page (AC-19, AC-25). Each test seeds its own person, so the
// shared admin the rest of the suite signs in as is never renamed or given another password.
test.use({ storageState: { cookies: [], origins: [] } });

let person: SeededAccount;
// Set once seeding succeeded, and cleared after removal: a failed seed cannot end a pool twice.
let toRemove: SeededAccount | undefined;

// Each test gets its own client address, so the api's per address limits do not carry over.
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders(ownAddress());
});

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

/** Opens the account page and waits until the details have loaded. */
async function openAccount(page: Page) {
  await page.goto('/account');
  await expect(page.getByLabel(/^Name/)).toBeVisible();
}

test('shows the person, with email, hats and staff code read only (AC-19)', async ({ page }) => {
  await openAccount(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveValue(person.name);
  await expect(page.getByRole('term').filter({ hasText: 'Email' })).toBeVisible();
  await expect(page.getByText(person.email)).toBeVisible();
  // Email, hats and staff code are not inputs: a manager owns them.
  await expect(page.getByRole('textbox', { name: /^Email/ })).toHaveCount(0);
  await expect(page.getByRole('term').filter({ hasText: 'Hats' })).toBeVisible();
  await expect(page.getByText('Support, Operations, Warehouse')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Staff code/ })).toHaveCount(0);
});

test('edits the name, saves it, and it persists after a reload and in the user menu (AC-19, AC-25)', async ({
  page,
}) => {
  await openAccount(page);
  const renamed = `${person.name} Renamed`;
  await page.getByLabel(/^Name/).fill(renamed);
  await page.getByRole('button', { name: 'Save details' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Your details are saved.' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/^Name/)).toHaveValue(renamed);
  await page.getByRole('button', { name: new RegExp(renamed) }).click();
  await expect(page.getByRole('menu').getByText(person.email)).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Account' })).toBeVisible();
});

test('an empty name is announced and focus moves to it; a bad phone likewise (AC-24)', async ({
  page,
}) => {
  await openAccount(page);
  const name = page.getByLabel(/^Name/);
  await name.fill('');
  await page.getByRole('button', { name: 'Save details' }).click();

  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription('Enter your name.');

  await name.fill(person.name);
  const phone = page.getByLabel('Phone');
  await phone.fill('abc');
  await page.keyboard.press('Enter');
  await expect(phone).toBeFocused();
  await expect(phone).toHaveAccessibleDescription(/Use 5 to 30 digits/);
});

test('a chosen language is saved to the account and applied on the next sign in (AC-19)', async ({
  page,
  browser,
  baseURL,
}) => {
  await openAccount(page);
  await page.getByLabel('Language').selectOption('ar');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Your details are saved.' }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Language')).toHaveValue('ar');

  // A person with no language cookie on another device gets the saved language after sign in.
  const other = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
  const device = await other.newPage();
  await signInThroughPage(device, person);
  await expect(device).toHaveURL('/');
  await expect(device.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(device.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await languageCookie(device)).toBe('ar');
  await other.close();
});

test('changing the password asks for the current one and ends other sessions (AC-19)', async ({
  page,
  browser,
  baseURL,
}) => {
  // A second session that the change should end.
  const other = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
  await signInThroughApi(other, person, baseURL ?? '');
  expect((await other.request.get('/api/me')).status()).toBe(200);

  await openAccount(page);
  const section = page.getByRole('region', { name: 'Change your password' });
  await section.getByRole('button', { name: 'Change password' }).click();
  await expect(section.getByLabel(/^Current password/)).toBeFocused();

  await section.getByLabel(/^Current password/).fill('Not-The-Password-1');
  await section.getByLabel(/^New password/).fill('Another-Pass-77');
  await page.keyboard.press('Enter');
  await expect(section.getByRole('alert')).toContainText('not right');

  await section.getByLabel(/^Current password/).fill(person.password);
  await page.keyboard.press('Enter');
  await expect(section.getByRole('status')).toContainText('Your password is changed');

  expect((await other.request.get('/api/me')).status()).toBe(401);
  expect((await page.request.get('/api/me')).status()).toBe(200);
  await other.close();
});

test('every control is reachable by keyboard alone (AC-24)', async ({ page }) => {
  await openAccount(page);
  await page.getByLabel(/^Name/).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Keyboard Only');
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('status').filter({ hasText: 'Your details are saved.' }),
  ).toBeVisible();
});
