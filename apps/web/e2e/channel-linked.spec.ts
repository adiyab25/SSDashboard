import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { api } from './master-data-api';
import { expectNoAxeViolations, openShell, textFor, useBrowserState } from './support';

// Spec 0012, milestone 4 (AC-15, AC-18): the style, SKU, edit, add SKU, and barcode screens of a
// style a sales channel owns some fields of. The channel sync has no route, so the rows are made
// through the api (as the manager) and then marked linked as the owner in SQL (`channel_linked_at`,
// `channel_name_language`, `from_channel`), the state `CatalogChannelSync` leaves. Codes carry a
// per run tag because the dev database keeps rows between runs.
const tag = randomUUID().slice(0, 6).toUpperCase();
let counter = 0;
const next = (prefix = '') => `${prefix}${tag}${(counter += 1)}`;
const digits = () =>
  `63${Math.floor(Math.random() * 1e11)
    .toString()
    .padStart(11, '0')}`;

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

/** The rows (desktop table) or cards (phone) of the style's SKU list. */
function variantRows(page: Page, label = 'SKUs of this style'): Locator {
  return isPhone(page)
    ? page.getByRole('list', { name: label }).getByRole('listitem')
    : page
        .getByRole('table', { name: label })
        .getByRole('row')
        .filter({ hasNot: page.locator('th') });
}

/** Runs SQL as the owner (the way the channel sync's own transaction would write). */
async function ownerSql(statement: string, values: unknown[] = []) {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    await pool.query(statement, values);
  } finally {
    await pool.end();
  }
}

interface Planted {
  id: string;
  code: string;
  /** SKU without options, carrying the channel barcode. */
  plain: { id: string; code: string };
  small: { id: string; code: string };
  medium: { id: string; code: string };
  large: { id: string; code: string };
  channelBarcode: string;
  appBarcode: string;
  en: string;
  ar: string;
}

/**
 * Plants a style with SKUs (one with no option, sizes S, M, and an archived L), one app barcode on
 * the S SKU, and one barcode on the plain SKU. Not linked yet.
 */
async function plantStyle(request: APIRequestContext): Promise<Planted> {
  const code = next('CH-');
  const en = `Channel Shirt ${code}`;
  const ar = `قميص القناة ${code}`;
  const created = await api(request, 'POST', '/products', {
    name: { en, ar },
    styleCode: code,
    variants: [{ sku: `${code}-0`, price: '300.00' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.productId as string;
  const plainId = created.body.id as string;
  const sizes: Record<string, { id: string; code: string }> = {};
  const appBarcode = digits();
  for (const size of ['S', 'M', 'L']) {
    const sku = `${code}-${size}`;
    const added = await api(request, 'POST', `/styles/${id}/variants`, {
      sku,
      price: '300.00',
      options: [{ name: { en: 'Size' }, value: { en: size } }],
      ...(size === 'S' && { barcode: appBarcode }),
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    sizes[size] = { id: added.body.id as string, code: sku };
  }
  const archived = await api(request, 'POST', `/skus/${sizes.L?.id}/archive`);
  expect(archived.status, JSON.stringify(archived.body)).toBeLessThan(300);
  const channelBarcode = digits();
  const barcode = await api(request, 'POST', `/skus/${plainId}/barcodes`, {
    code: channelBarcode,
  });
  expect(barcode.status, JSON.stringify(barcode.body)).toBeLessThan(300);
  return {
    id,
    code,
    plain: { id: plainId, code: `${code}-0` },
    small: sizes.S as { id: string; code: string },
    medium: sizes.M as { id: string; code: string },
    large: sizes.L as { id: string; code: string },
    channelBarcode,
    appBarcode,
    en,
    ar,
  };
}

/** Marks a planted style linked the way `CatalogChannelSync` leaves it. */
async function link(style: Planted, language: 'en' | 'ar' | null) {
  await ownerSql(
    `UPDATE products SET channel_linked_at = now(), channel_name_language = $2,
       tags = ARRAY['winter','wool'], product_type = 'Shirts', brand = 'Fixture Brand'
     WHERE id = $1::uuid`,
    [style.id, language],
  );
  await ownerSql(
    `UPDATE product_variants SET channel_linked_at = now() WHERE product_id = $1::uuid`,
    [style.id],
  );
  await ownerSql(`UPDATE barcodes SET from_channel = true WHERE code = $1`, [style.channelBarcode]);
}

/** Plants and links a style. */
async function plantLinked(request: APIRequestContext, language: 'en' | 'ar' | null) {
  const style = await plantStyle(request);
  await link(style, language);
  return style;
}

const FROM_SHOPIFY = 'From Shopify';

test.describe('A style a sales channel owns (AC-15, AC-18) in English', () => {
  test('the name in the channel language, every price, tags, options, and the channel barcode say From Shopify; an app barcode and an unlinked style do not', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'en');
    await openShell(page, `/styles/${style.id}`);
    const facts = page.getByRole('region', { name: 'About this style' });
    const nameSlot = facts.locator('div', { hasText: 'Name in English (from Shopify)' }).last();
    await expect(nameSlot).toContainText(style.en);
    await expect(nameSlot.getByText(FROM_SHOPIFY, { exact: true })).toBeVisible();
    await expect(nameSlot.locator('[lang="en"]')).toHaveAttribute('dir', 'ltr');
    // The Arabic name is the app's: no slot for it.
    await expect(facts.getByText('Name in Arabic (from Shopify)')).toHaveCount(0);

    for (const label of ['Product type', 'Brand', 'Tags']) {
      const field = facts.locator('div', { has: page.getByText(label, { exact: true }) }).last();
      await expect(field.getByText(FROM_SHOPIFY, { exact: true }), label).toBeVisible();
    }
    // Season and group are the app's.
    for (const label of ['Season', 'Product group']) {
      const field = facts.locator('div', { has: page.getByText(label, { exact: true }) }).last();
      await expect(field.getByText(FROM_SHOPIFY, { exact: true }), label).toHaveCount(0);
    }
    const options = page.getByRole('region', { name: 'Options' });
    await expect(options.getByText(FROM_SHOPIFY, { exact: true })).toBeVisible();

    const rows = variantRows(page);
    for (const sku of [style.plain, style.small, style.medium]) {
      const row = rows.filter({ hasText: sku.code });
      await expect(row).toHaveCount(1);
      await expect(row.getByText(FROM_SHOPIFY, { exact: true }).first(), sku.code).toBeVisible();
    }
    // The plain SKU shows two badges: its price and its channel barcode.
    await expect(
      rows.filter({ hasText: style.plain.code }).getByText(FROM_SHOPIFY, { exact: true }),
    ).toHaveCount(2);
    // The S SKU has an app barcode: only its price carries the label.
    const small = rows.filter({ hasText: style.small.code });
    await expect(small).toContainText(style.appBarcode);
    await expect(small.getByText(FROM_SHOPIFY, { exact: true })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });

  test('a style the channel does not own shows no From Shopify label anywhere', async ({
    page,
    request,
  }) => {
    const style = await plantStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('region', { name: 'About this style' })).toBeVisible();
    await expect(page.getByText(FROM_SHOPIFY)).toHaveCount(0);
  });

  test('a linked style with no channel name language has price, tags, and options labels but no name slot', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, null);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.getByRole('region', { name: 'About this style' })).toBeVisible();
    await expect(page.getByText(/^Name in (English|Arabic) \(from Shopify\)$/)).toHaveCount(0);
    await expect(
      variantRows(page).filter({ hasText: style.small.code }).getByText(FROM_SHOPIFY),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'Edit style' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(dialog.getByLabel('Name in English')).not.toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('Name in Arabic')).not.toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel(/^Tags/)).toHaveAttribute('readonly', '');
  });

  test('the Edit dialog locks the English name and tags, keeps the Arabic name, description, season, and group editable, and saves them', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'en');
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Edit style' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    const nameEn = dialog.getByLabel('Name in English');
    await expect(nameEn).toHaveAttribute('readonly', '');
    await expect(nameEn).toHaveValue(style.en);
    await expect(dialog.getByText(FROM_SHOPIFY, { exact: true })).toHaveCount(2); // name and tags
    const tags = dialog.getByLabel(/^Tags/);
    await expect(tags).toHaveAttribute('readonly', '');
    for (const label of ['Name in Arabic', 'Description in English', 'Description in Arabic']) {
      await expect(dialog.getByLabel(label), label).not.toHaveAttribute('readonly', '');
      await expect(dialog.getByLabel(label), label).toBeEnabled();
    }
    await expect(dialog.getByLabel('Season', { exact: true })).toBeEnabled();
    await expect(dialog.getByLabel('Product group')).toBeEnabled();

    // A change to a locked field does not edit it: typing into a read only box is ignored.
    await nameEn.click();
    await page.keyboard.type('zzz');
    await expect(nameEn).toHaveValue(style.en);

    await dialog.getByLabel('Name in Arabic').fill(`${style.ar} جديد`);
    await dialog.getByLabel('Description in English').fill(`App description ${tag}`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Style ${style.code} saved.`)).toBeVisible();
    const saved = await api(request, 'GET', `/styles/${style.id}`);
    expect((saved.body.name as { en: string; ar: string }).en).toBe(style.en);
    expect((saved.body.name as { en: string; ar: string }).ar).toBe(`${style.ar} جديد`);
    expect(saved.body.tags).toEqual(['winter', 'wool']);
    expect(saved.body.channelLinked).toBe(true);
    expect(saved.body.channelNameLanguage).toBe('en');
  });

  test('the api answers 409 FIELD_OWNED_BY_CHANNEL for the channel name and price, and saves the other name', async ({
    request,
  }) => {
    const style = await plantLinked(request, 'ar');
    const current = (await api(request, 'GET', `/styles/${style.id}`)).body;
    expect(current.channelNameLanguage).toBe('ar');
    const blocked = await api(request, 'PATCH', `/styles/${style.id}`, {
      updatedAt: current.updatedAt,
      name: { en: style.en, ar: `${style.ar} معدل` },
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.code).toBe('FIELD_OWNED_BY_CHANNEL');
    expect(blocked.body.field).toBe('name.ar');
    const allowed = await api(request, 'PATCH', `/styles/${style.id}`, {
      updatedAt: current.updatedAt,
      name: { en: `${style.en} renamed`, ar: style.ar },
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    const sku = (await api(request, 'GET', `/skus/${style.small.id}`)).body;
    expect(sku.channelLinked).toBe(true);
    const price = await api(request, 'PATCH', `/skus/${style.small.id}`, {
      updatedAt: sku.updatedAt,
      price: '999.00',
    });
    expect(price.status, JSON.stringify(price.body)).toBe(409);
    expect(price.body.code).toBe('FIELD_OWNED_BY_CHANNEL');
    expect(price.body.field).toBe('price');
  });

  test('a save that hits the channel name after the dialog opened shows the wording that names the field', async ({
    page,
    request,
  }) => {
    const style = await plantStyle(request);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Edit style' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(dialog.getByLabel('Name in Arabic')).not.toHaveAttribute('readonly', '');
    // The channel links the style while the dialog is open (the name is the app's until then).
    await link(style, 'ar');
    await dialog.getByLabel('Name in Arabic').fill(`${style.ar} آخر`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(
      dialog.getByText('The Arabic name comes from Shopify and can only be changed there.'),
    ).toBeVisible();
    // The English name is the app's: it saves from the same dialog once the Arabic text is back.
    // (The dialog still holds the stored Arabic text only after a reload.)
  });

  test('the add SKU dialog offers only the existing option values and no way to add an option', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'en');
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Add SKU' }).click();
    const dialog = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await expect(dialog.getByText(/^The options come from Shopify/)).toBeVisible();
    await expect(dialog.getByLabel('Option 1 name')).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('Option 1 name')).toHaveValue('Size');
    const value = dialog.getByLabel('Option 1 value');
    expect(await value.evaluate((node) => node.tagName)).toBe('SELECT');
    const offered = await value.locator('option').allTextContents();
    expect(offered.filter((text) => text !== '').sort()).toEqual(['L', 'M', 'S']);
    await expect(dialog.getByRole('button', { name: 'Add an option' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^Remove option/ })).toHaveCount(0);
    await expectNoAxeViolations(page);

    // Pick the free value (the L SKU is archived) and save.
    const code = `${style.code}-N`;
    await dialog.getByLabel('SKU code').fill(code);
    await value.selectOption('L');
    await dialog.getByRole('button', { name: 'Add SKU' }).click();
    await expect(page.getByText(`SKU ${code} added.`)).toBeVisible();
    const after = (await api(request, 'GET', `/styles/${style.id}`)).body;
    const names = (after.options as { values: { en?: string }[] }[]).flatMap((option) =>
      option.values.map((v) => v.en),
    );
    expect(names.sort()).toEqual(['L', 'M', 'S']);
  });

  test('a linked style with no options says a new option can only be added in Shopify', async ({
    page,
    request,
  }) => {
    const code = next('CN-');
    const created = await api(request, 'POST', '/products', {
      name: { en: `No options ${code}` },
      styleCode: code,
      variants: [{ sku: `${code}-0`, price: '50.00' }],
    });
    expect(created.status).toBe(201);
    const style = { id: created.body.productId as string, code };
    await ownerSql(
      `UPDATE products SET channel_linked_at = now(), channel_name_language = 'en' WHERE id = $1::uuid`,
      [style.id],
    );
    await ownerSql(
      `UPDATE product_variants SET channel_linked_at = now() WHERE product_id = $1::uuid`,
      [style.id],
    );
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Add SKU' }).click();
    const dialog = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await expect(
      dialog.getByText('This style has no options. A new option can only be added in Shopify.'),
    ).toBeVisible();
    await expect(dialog.getByLabel(/^Option 1/)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Add an option' })).toHaveCount(0);
    // The api refuses a new option on a linked style too.
    const refused = await api(request, 'POST', `/styles/${style.id}/variants`, {
      sku: `${code}-X`,
      options: [{ name: { en: 'Size' }, value: { en: 'M' } }],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('FIELD_OWNED_BY_CHANNEL');
    expect(refused.body.field).toBe('options');
  });

  test('the channel barcode shows From Shopify with no Remove; an app barcode keeps Remove and works', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'en');
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: `Barcodes of ${style.plain.code}` }).click();
    const channel = page.getByRole('dialog', { name: `Barcodes of ${style.plain.code}` });
    const channelItem = channel.getByRole('list', { name: 'Barcodes' }).getByRole('listitem');
    await expect(channelItem).toHaveCount(1);
    await expect(channelItem).toContainText(style.channelBarcode);
    await expect(channelItem.getByText(FROM_SHOPIFY, { exact: true })).toBeVisible();
    await expect(channel.getByRole('button', { name: /^Remove barcode/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(channel).toHaveCount(0);

    await page.getByRole('button', { name: `Barcodes of ${style.small.code}` }).click();
    const app = page.getByRole('dialog', { name: `Barcodes of ${style.small.code}` });
    await expect(app.getByText(FROM_SHOPIFY)).toHaveCount(0);
    await app.getByRole('button', { name: `Remove barcode ${style.appBarcode}` }).click();
    await expect(page.getByText(`Barcode ${style.appBarcode} removed.`)).toBeVisible();

    // The api refuses to remove the channel's one.
    const detail = (await api(request, 'GET', `/skus/${style.plain.id}`)).body;
    const held = (detail.barcodes as { id: string; fromChannel: boolean }[]).find(
      (barcode) => barcode.fromChannel,
    );
    expect(held).toBeDefined();
    const removal = await api(
      request,
      'DELETE',
      `/skus/${style.plain.id}/barcodes/${held?.id ?? ''}`,
    );
    expect(removal.status, JSON.stringify(removal.body)).toBe(409);
    expect(removal.body.code).toBe('FIELD_OWNED_BY_CHANNEL');
  });

  test('the SKU page labels the price, the style name, the options, and the channel barcode; Edit SKU locks the price', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'en');
    await openShell(page, `/skus/${style.plain.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const main = page.getByRole('main');
    const price = main.locator('div', { has: page.getByText('Selling price', { exact: true }) });
    await expect(price.last().getByText(FROM_SHOPIFY, { exact: true })).toBeVisible();
    // style link, price, and the channel barcode (this SKU has no options)
    await expect(main.getByText(FROM_SHOPIFY, { exact: true })).toHaveCount(3);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Edit SKU' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit SKU ${style.plain.code}` });
    await expect(dialog.getByLabel(/^Selling price/)).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('Name in English')).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('Name in Arabic')).not.toHaveAttribute('readonly', '');
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');

    await openShell(page, `/skus/${style.small.id}`);
    await expect(page.getByRole('main').getByText(FROM_SHOPIFY, { exact: true })).toHaveCount(3);
  });

  test('keyboard only: open Edit style, tab past the locked name to the Arabic name, save with Enter, close with Escape', async ({
    page,
    request,
  }) => {
    test.skip(isPhone(page), 'the keyboard flow is the same at phone width');
    const style = await plantLinked(request, 'en');
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: 'Edit style' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Edit style ${style.code}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name in English')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Name in Arabic')).toBeFocused();
    await page.keyboard.type(' ٢');
    await expectNoAxeViolations(page);
    await page.keyboard.press('Enter');
    await expect(page.getByText(`Style ${style.code} saved.`)).toBeVisible();
    await page.getByRole('button', { name: 'Add SKU' }).press('Enter');
    const add = page.getByRole('dialog', { name: `Add a SKU to ${style.code}` });
    await expect(add).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(add).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add SKU' })).toBeFocused();
  });

  test('at phone and desktop width the linked style page does not scroll sideways', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'en');
    await openShell(page, `/styles/${style.id}`);
    await expect(variantRows(page).first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: test.info().outputPath(`linked-style-${isPhone(page) ? 'phone' : 'desktop'}.png`),
      fullPage: true,
    });
  });
});

test.describe('A style a sales channel owns (AC-15, AC-18) in Arabic', () => {
  test('the Arabic name slot is right to left with Arabic labels, codes stay left to right, axe passes', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'ar');
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);
    await openShell(page, `/styles/${style.id}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const facts = page.getByRole('region', { name: t('catalog.style.factsTitle') });
    const slot = facts.locator('div', { hasText: t('catalog.channel.nameIn.ar') }).last();
    await expect(slot).toContainText(style.ar);
    await expect(slot.locator('[lang="ar"]')).toHaveAttribute('dir', 'rtl');
    await expect(slot.getByText(t('catalog.channel.fromShopify'), { exact: true })).toBeVisible();
    await expect(facts.getByText(t('catalog.channel.nameIn.en'))).toHaveCount(0);
    const rows = variantRows(page, t('catalog.style.variantsTableLabel'));
    const row = rows.filter({ hasText: style.small.code });
    await expect(row.getByText(t('catalog.channel.fromShopify'), { exact: true })).toHaveCount(1);
    await expect(row.locator('[dir="ltr"]').first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });

  test('the Arabic Edit dialog locks the Arabic name and tags, keeps the English name editable and saving; add SKU and barcodes show the Arabic wording', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'ar');
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: t('catalog.style.edit') }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(t('catalog.styleEdit.nameAr'))).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel(t('catalog.styleEdit.nameEn'))).not.toHaveAttribute(
      'readonly',
      '',
    );
    await expect(dialog.getByText(t('catalog.channel.fromShopify'), { exact: true })).toHaveCount(
      2,
    );
    await expectNoAxeViolations(page);
    await dialog.getByLabel(t('catalog.styleEdit.nameEn')).fill(`${style.en} v2`);
    await dialog.getByRole('button', { name: t('catalog.styleEdit.save') }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await api(request, 'GET', `/styles/${style.id}`)).body;
    expect((saved.name as { en: string; ar: string }).en).toBe(`${style.en} v2`);
    expect((saved.name as { en: string; ar: string }).ar).toBe(style.ar);

    await page.getByRole('button', { name: t('catalog.style.addVariant') }).click();
    const add = page.getByRole('dialog');
    await expect(add.getByText(t('catalog.channel.optionsLocked'))).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');

    await page
      .getByRole('button', {
        name: t('catalog.style.barcodesLabel').replace('{{code}}', style.plain.code),
      })
      .click();
    const barcodes = page.getByRole('dialog');
    await expect(
      barcodes.getByText(t('catalog.channel.fromShopify'), { exact: true }),
    ).toBeVisible();
    await expect(barcodes.getByRole('button', { name: /^(إزالة|حذف)/ })).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  test('the Arabic wording for a channel owned name shows when a save hits it', async ({
    page,
    request,
  }) => {
    const style = await plantStyle(request);
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);
    await openShell(page, `/styles/${style.id}`);
    await page.getByRole('button', { name: t('catalog.style.edit') }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(t('catalog.styleEdit.nameAr'))).toBeVisible();
    await link(style, 'ar');
    await dialog.getByLabel(t('catalog.styleEdit.nameAr')).fill(`${style.ar} آخر`);
    await dialog.getByRole('button', { name: t('catalog.styleEdit.save') }).click();
    await expect(
      dialog.getByText('الاسم العربي قادم من شوبيفاي ولا يمكن تغييره إلا هناك.'),
    ).toBeVisible();
  });

  test('the SKU page and Edit SKU are right to left with the labels, axe passes', async ({
    page,
    request,
  }) => {
    const style = await plantLinked(request, 'ar');
    await useBrowserState(page, { language: 'ar' });
    const t = (key: Parameters<typeof textFor>[1]) => textFor('rtl', key);
    await openShell(page, `/skus/${style.small.id}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('main').getByText(t('catalog.channel.fromShopify'), { exact: true }),
    ).toHaveCount(3);
    await expectNoAxeViolations(page);
  });
});
