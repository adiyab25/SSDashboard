import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_ADMIN } from './auth';
import {
  ownAddress,
  removeAccountByEmail,
  seedAccount,
  seedPartnerAccount,
  seedPartnerLogin,
  type SeededAccount,
  type SeededPartnerAccount,
} from './accounts';
import {
  expectNoAxeViolations,
  openPartnerLogins,
  textFor,
  useBrowserState,
  waitForPageHydration,
  type TextDirection,
} from './support';

// Spec 0008 milestone 2, item 4: the hats dialog on /staff (AC-7, AC-12, AC-18). The manager is
// the suite's saved sign in (`manager` plus `cost.view`); each test seeds the person it edits.

let person: SeededAccount | undefined;

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders(ownAddress());
});
test.afterEach(async () => {
  const seeded = person;
  person = undefined;
  await seeded?.remove();
});

/** Opens /staff in the language of `dir`, narrows the list to `email`, and returns its row. */
async function openRow(
  page: Page,
  account: { name: string; email: string },
  dir: TextDirection = 'ltr',
): Promise<Locator> {
  await page.goto('/staff');
  await expect(
    page.getByRole('heading', { level: 1, name: textFor(dir, 'staff.title') }),
  ).toBeVisible();
  await waitForPageHydration(page);
  await page.getByRole('searchbox', { name: textFor(dir, 'staff.search') }).fill(account.email);
  // Only the match is left (plus the header row) before a menu is opened on it.
  await expect(page.getByRole('row')).toHaveCount(2);
  const row = page.getByRole('row', { name: new RegExp(account.name) });
  await expect(row).toBeVisible();
  return row;
}

/** The row's actions button, in the language of `dir`. */
const actions = (row: Locator, name: string, dir: TextDirection = 'ltr') =>
  row.getByRole('button', { name: textFor(dir, 'staff.row.menu').replace('{{name}}', name) });

/** Opens the edit hats dialog from the row menu. */
async function openHats(page: Page, row: Locator, name: string, dir: TextDirection = 'ltr') {
  await actions(row, name, dir).click();
  await page.getByRole('menuitem', { name: textFor(dir, 'staff.hats.edit') }).click();
  const dialog = page.getByRole('dialog', {
    name: textFor(dir, 'staff.hats.title').replace('{{name}}', name),
  });
  await expect(dialog).toBeVisible();
  // The person's hats have loaded once the first checkbox is there.
  await expect(
    dialog.getByRole('checkbox', { name: textFor(dir, 'access.hats.support.name') }),
  ).toBeVisible();
  return dialog;
}

/** The cells of a row: name, email, hats, sees cost, status, last sign in, two factor. */
const cell = (row: Locator, index: number) => row.getByRole('cell').nth(index);

test('a manager gives a warehouse person support, and the row shows both hats', async ({
  page,
}) => {
  person = await seedAccount({ hats: ['warehouse'] });
  const row = await openRow(page, person);
  await expect(cell(row, 2)).toHaveText('Warehouse');

  const dialog = await openHats(page, row, person.name);
  await expect(dialog.getByRole('checkbox', { name: 'Warehouse' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Support' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Support' }).check();
  await expect(dialog.getByRole('switch', { name: 'Sees cost' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save hats' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Hats saved.')).toBeVisible();
  await expect(cell(row, 2)).toHaveText('Support, Warehouse');
  await expect(cell(row, 3)).toHaveText('No');
  // Focus goes back to the row's actions button once the list has reloaded.
  await expect(actions(row, person.name)).toBeFocused();
});

test('giving operations turns the cost switch on by default, and the manager can turn it off', async ({
  page,
}) => {
  person = await seedAccount({ hats: ['warehouse'] });
  const row = await openRow(page, person);

  const dialog = await openHats(page, row, person.name);
  const cost = dialog.getByRole('switch', { name: 'Sees cost' });
  await expect(cost).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Operations' }).check();
  await expect(cost).toBeChecked();
  await cost.uncheck();
  await expect(cost).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save hats' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(cell(row, 2)).toHaveText('Operations, Warehouse');
  await expect(cell(row, 3)).toHaveText('No');

  // Left on, the default is saved: the row then says the person sees cost.
  const again = await openHats(page, row, person.name);
  await again.getByRole('checkbox', { name: 'Manager' }).check();
  await expect(again.getByRole('switch', { name: 'Sees cost' })).toBeChecked();
  await again.getByRole('button', { name: 'Save hats' }).click();
  await expect(again).toHaveCount(0);
  await expect(cell(row, 2)).toHaveText('Operations, Warehouse, Manager');
  await expect(cell(row, 3)).toHaveText('Yes');
});

test('taking manager away needs a reason, and the dialog works by keyboard alone', async ({
  page,
}) => {
  person = await seedAccount({ hats: ['manager', 'support'] });
  const row = await openRow(page, person);
  const trigger = actions(row, person.name);

  // Escape closes the dialog and focus goes back to the row's actions button.
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Edit hats' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Edit hats for ${person.name}` });
  await expect(dialog.getByRole('checkbox', { name: 'Support' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const reopened = await openHats(page, row, person.name);
  await reopened.getByRole('checkbox', { name: 'Manager' }).focus();
  await page.keyboard.press('Space');
  await expect(reopened.getByRole('checkbox', { name: 'Manager' })).not.toBeChecked();
  await reopened.getByRole('button', { name: 'Save hats' }).focus();
  await page.keyboard.press('Enter');

  const reason = reopened.getByLabel('Reason (required when you take Manager away)');
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAccessibleDescription(/Say why you are taking Manager away\./);
  await page.keyboard.type('Moved to customer support');
  await reopened.getByRole('button', { name: 'Save hats' }).focus();
  await page.keyboard.press('Enter');

  await expect(reopened).toHaveCount(0);
  await expect(cell(row, 2)).toHaveText('Support');
});

test('changing your own hats is refused: no Edit hats on your row, and the api answers 409', async ({
  page,
  baseURL,
}) => {
  const row = await openRow(page, E2E_ADMIN);
  await actions(row, E2E_ADMIN.name).click();
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit hats' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const me = (await (await page.request.get('/api/me')).json()) as { id: string };
  const detail = (await (await page.request.get(`/api/staff/${me.id}`)).json()) as {
    updatedAt: string;
  };
  const refused = await page.request.put(`/api/staff/${me.id}/access`, {
    headers: { origin: new URL(baseURL ?? '').origin },
    data: { hats: ['manager', 'support'], costView: true, updatedAt: detail.updatedAt },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'SELF_HAT_CHANGE' });
});

for (const dir of ['ltr', 'rtl'] as const) {
  test(`the hats dialog passes axe in ${dir === 'rtl' ? 'Arabic' : 'English'}`, async ({
    page,
  }) => {
    await useBrowserState(page, { dir });
    person = await seedAccount({ hats: ['warehouse'] });
    const row = await openRow(page, person, dir);
    await expect(page.locator('html')).toHaveAttribute('dir', dir);

    const dialog = await openHats(page, row, person.name, dir);
    // Show the error states too: no hat left, then save.
    await dialog
      .getByRole('checkbox', { name: textFor(dir, 'access.hats.warehouse.name') })
      .uncheck();
    await dialog.getByRole('button', { name: textFor(dir, 'staff.hats.save') }).click();
    await expect(
      dialog.getByText(textFor(dir, 'staff.hats.errors.NO_HAT'), { exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });
}

// Spec 0008 milestone 3, item 6: the Partner logins tab on /staff (AC-15, AC-18). Each test seeds
// its own partner accounts and logins and removes them in order (logins first).
const partnerAccounts: SeededPartnerAccount[] = [];
const partnerLogins: SeededAccount[] = [];
const createdEmails: string[] = [];

test.afterEach(async () => {
  for (const email of createdEmails.splice(0)) await removeAccountByEmail(email);
  for (const login of partnerLogins.splice(0)) await login.remove();
  for (const account of partnerAccounts.splice(0)) await account.remove();
});

/** Seeds a partner account and keeps it for the clean up. */
async function seedPartner(): Promise<SeededPartnerAccount> {
  const account = await seedPartnerAccount();
  partnerAccounts.push(account);
  return account;
}

/** Narrows the Partner logins list to `email` and returns the one row left. */
async function partnerRow(
  page: Page,
  account: { name: string; email: string },
  dir: TextDirection = 'ltr',
): Promise<Locator> {
  // The list asks the api once the typing pauses, and swaps its rows for a skeleton while it waits.
  // A menu opened on a row before that swap is closed under the test's feet (a short list already
  // shows one row, so the row count alone settles too early), so wait for the filtered answer and
  // for the table to stop being busy first.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/partner-users?') &&
      response.url().includes(`q=${encodeURIComponent(account.email)}`),
  );
  await page
    .getByRole('searchbox', { name: textFor(dir, 'staff.partners.search') })
    .fill(account.email);
  await answered;
  await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('row')).toHaveCount(2);
  const row = page.getByRole('row', { name: new RegExp(account.name) });
  await expect(row).toBeVisible();
  return row;
}

const partnerActions = (row: Locator, name: string, dir: TextDirection = 'ltr') =>
  row.getByRole('button', {
    name: textFor(dir, 'staff.partners.row.menu').replace('{{name}}', name),
  });

test('a manager adds a partner login bound to a partner account, and it shows on the tab only', async ({
  page,
}) => {
  const partner = await seedPartner();
  const email = `e2e-partner-${partner.code.toLowerCase()}@example.com`;
  const name = `Partner ${partner.code}`;
  createdEmails.push(email);
  await openPartnerLogins(page);

  await page.getByRole('button', { name: 'Add partner login' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add partner login' });
  // No hats and no cost switch: a partner login has neither.
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('switch')).toHaveCount(0);
  await dialog.getByLabel(/^Name/).fill(name);
  await dialog.getByLabel(/^Email/).fill(email);
  await dialog
    .getByLabel(/^Partner account/)
    .selectOption({ label: `${partner.name} (${partner.code})` });
  await dialog.getByRole('button', { name: 'Save' }).click();

  const setup = page.getByRole('dialog', { name: `Temporary password for ${name}` });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Partner login created.')).toBeVisible();

  const row = await partnerRow(page, { name, email });
  await expect(row).toContainText(partner.name);
  await expect(row).toContainText('Invited');

  // The same person is never on the Staff tab: partner logins and staff are separate lists.
  await page.getByRole('tab', { name: 'Staff' }).click();
  await page.getByRole('searchbox', { name: 'Search staff' }).fill(email);
  await expect(page.getByText(/No staff match/)).toBeVisible();
});

test('a manager moves a partner login to another account with a reason, by keyboard, and focus returns', async ({
  page,
}) => {
  const from = await seedPartner();
  const to = await seedPartner();
  const login = await seedPartnerLogin(from.id);
  partnerLogins.push(login);
  await openPartnerLogins(page);
  const row = await partnerRow(page, login);
  await expect(row).toContainText(from.name);

  const trigger = partnerActions(row, login.name);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Move to another account' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: `Move ${login.name} to another partner account`,
  });
  const select = dialog.getByLabel(/^New partner account/);
  await expect(select).toBeFocused();
  // Moving to the same account is not offered: only the other accounts are in the list.
  await expect(select.locator('option', { hasText: from.name })).toHaveCount(0);
  await select.selectOption({ label: `${to.name} (${to.code})` });
  await dialog.getByLabel('Reason (optional)').fill('Moved to the new showroom');
  await dialog.getByRole('button', { name: 'Move login' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('Partner login moved. They were signed out everywhere.'),
  ).toBeVisible();
  await expect(row).toContainText(to.name);
  await expect(trigger).toBeFocused();
});

test('a partner login can be disabled and enabled again from the tab', async ({ page }) => {
  const partner = await seedPartner();
  const login = await seedPartnerLogin(partner.id);
  partnerLogins.push(login);
  await openPartnerLogins(page);
  const row = await partnerRow(page, login);

  await partnerActions(row, login.name).click();
  await page.getByRole('menuitem', { name: 'Disable' }).click();
  await page
    .getByRole('dialog', { name: `Disable ${login.name}?` })
    .getByRole('button', { name: 'Disable account' })
    .click();
  await expect(page.getByText('Account disabled.')).toBeVisible();
  await expect(row).toContainText('Disabled');

  await partnerActions(row, login.name).click();
  await page.getByRole('menuitem', { name: 'Enable' }).click();
  await expect(page.getByText('Account enabled.')).toBeVisible();
  await expect(row).not.toContainText('Disabled');
});

test('the tabs work by keyboard: arrows move between them and the panel follows', async ({
  page,
}) => {
  await page.goto('/staff');
  await waitForPageHydration(page);
  const staff = page.getByRole('tab', { name: 'Staff' });
  const partners = page.getByRole('tab', { name: 'Partner logins' });
  await staff.focus();
  await page.keyboard.press('ArrowRight');
  await expect(partners).toBeFocused();
  await expect(partners).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Partner logins' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(staff).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Staff' })).toBeVisible();
});

for (const dir of ['ltr', 'rtl'] as const) {
  test(`both people tabs and the partner login dialogs pass axe in ${dir === 'rtl' ? 'Arabic' : 'English'}`, async ({
    page,
  }) => {
    await useBrowserState(page, { dir });
    const partner = await seedPartner();
    const login = await seedPartnerLogin(partner.id);
    partnerLogins.push(login);

    await openPartnerLogins(page, dir);
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    const row = await partnerRow(page, login, dir);
    await expectNoAxeViolations(page);

    // The add dialog with its errors showing.
    await page.getByRole('button', { name: textFor(dir, 'staff.partners.add') }).click();
    const add = page.getByRole('dialog', { name: textFor(dir, 'staff.partners.form.createTitle') });
    await add.getByRole('button', { name: textFor(dir, 'staff.form.save') }).click();
    await expect(
      add.getByText(textFor(dir, 'staff.form.nameRequired'), { exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');
    await expect(add).toHaveCount(0);

    // The move dialog.
    await partnerActions(row, login.name, dir).click();
    await page.getByRole('menuitem', { name: textFor(dir, 'staff.partners.row.move') }).click();
    const move = page.getByRole('dialog', {
      name: textFor(dir, 'staff.partners.move.title').replace('{{name}}', login.name),
    });
    await expect(
      move.getByLabel(new RegExp(textFor(dir, 'staff.partners.move.account'))),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');

    // And the Staff tab beside it.
    await page.getByRole('tab', { name: textFor(dir, 'staff.tabs.staff') }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoAxeViolations(page);
  });
}
