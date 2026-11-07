import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_ADMIN } from './auth';
import { ownAddress, seedAccount, type SeededAccount } from './accounts';
import {
  expectNoAxeViolations,
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
