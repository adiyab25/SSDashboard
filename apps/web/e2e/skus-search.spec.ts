import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createDatabase } from '@ssdashboard/db';
import { ownerDatabaseUrl } from './auth';
import { expectNoAxeViolations, openShell, textFor, useBrowserState } from './support';

// Spec 0012, milestone 1 (catalog search): the SKU list searched by name, Arabic text without
// hamza, and barcode, the style, season, and group columns, the season and group filters, and
// the SKU page's style block with its barcodes. Runs in both projects: a table at desktop width
// and cards at phone width. Styles are planted as the owner (the style routes come with
// milestone 2) with a per run tag, because the dev database keeps rows between runs.
const tag = randomUUID().slice(0, 6).toUpperCase();
const low = tag.toLowerCase();
const barcodeA = `62${Math.floor(Math.random() * 1e11)
  .toString()
  .padStart(11, '0')}`;
const barcodeB = `62${Math.floor(Math.random() * 1e11)
  .toString()
  .padStart(11, '0')}`;

const ids = { season: '', group: '', teeStyle: '', qamisStyle: '', blackTee: '', qamis: '' };
const codes = { blackTee: `${tag}-BLK-M`, whiteTee: `${tag}-WHT-L`, qamis: `${tag}-QAMIS` };

const toArabicDigits = (value: string) => value.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d);

test.beforeAll(async () => {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    const one = async (text: string, values: unknown[]) =>
      (await pool.query<{ id: string }>(text, values)).rows[0]?.id ?? '';
    ids.season = await one(`INSERT INTO seasons (code, name) VALUES ($1, $2::jsonb) RETURNING id`, [
      `S${tag}`,
      JSON.stringify({ en: `Spring ${tag}`, ar: `ربيع ${tag}` }),
    ]);
    ids.group = await one(
      `INSERT INTO product_groups (code, name) VALUES ($1, $2::jsonb) RETURNING id`,
      [`G${tag}`, JSON.stringify({ en: `Group ${tag}`, ar: `مجموعة ${tag}` })],
    );
    const main = await one(`SELECT id FROM product_groups WHERE code = 'MAIN'`, []);
    const style = (code: string, name: object, group: string, season: string | null) =>
      one(
        `INSERT INTO products (style_code, product_group_id, name, status, season_id)
         VALUES ($1, $2, $3::jsonb, 'active', $4) RETURNING id`,
        [code, group, JSON.stringify(name), season],
      );
    ids.teeStyle = await style(`TEE${tag}`, { en: `Tee ${tag}` }, main, ids.season);
    ids.qamisStyle = await style(`QS${tag}`, { ar: `قميص أسود ${tag}` }, ids.group, null);
    await pool.query(
      `INSERT INTO product_options (product_id, name, position, values) VALUES
       ($1, $2::jsonb, 0, $3::jsonb), ($1, $4::jsonb, 1, $5::jsonb)`,
      [
        ids.teeStyle,
        JSON.stringify({ en: 'Size', ar: 'المقاس' }),
        JSON.stringify([{ en: 'M' }, { en: 'L' }]),
        JSON.stringify({ en: 'Color', ar: 'اللون' }),
        JSON.stringify([
          { en: 'Black', ar: 'أسود' },
          { en: 'White', ar: 'أبيض' },
        ]),
      ],
    );
    const variant = (styleId: string, sku: string, optionValues: object, price: number) =>
      one(
        `INSERT INTO product_variants (product_id, sku, option_values, base_uom_id, price)
         VALUES ($1, $2, $3::jsonb, (SELECT id FROM uoms WHERE code = 'pc'), $4) RETURNING id`,
        [styleId, sku, JSON.stringify(optionValues), price],
      );
    ids.blackTee = await variant(ids.teeStyle, codes.blackTee, { '0': 0, '1': 0 }, 25);
    const white = await variant(ids.teeStyle, codes.whiteTee, { '0': 1, '1': 1 }, 27.5);
    ids.qamis = await variant(ids.qamisStyle, codes.qamis, {}, 40);
    for (const [variantId, code] of [
      [ids.blackTee, barcodeA],
      [white, barcodeB],
    ] as const) {
      await pool.query(
        `INSERT INTO barcodes (variant_id, uom_id, code)
         VALUES ($1, (SELECT id FROM uoms WHERE code = 'pc'), $2)`,
        [variantId, code],
      );
    }
  } finally {
    await pool.end();
  }
});

/** The rows (desktop table) or cards (phone) of the SKU list. */
function skuRows(page: Page, label = 'SKUs'): Locator {
  const phone = (page.viewportSize()?.width ?? 1280) < 640;
  return phone
    ? page.getByRole('list', { name: label }).getByRole('listitem')
    : page
        .getByRole('table', { name: label })
        .getByRole('row')
        .filter({ hasNot: page.locator('th') });
}

/** Types into the search box and waits for the debounced request carrying that text. */
async function search(page: Page, text: string, label = 'Name, SKU or barcode') {
  const answered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/skus' && url.searchParams.get('q') === text.trim();
  });
  await page.getByLabel(label).fill(text);
  await answered;
}

test.describe('SKU list search and columns (AC-3, AC-4) in English', () => {
  test('a name fragment lists the style variants with code, size and color, style, season, group, price, status', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await search(page, `tee ${low}`);
    await expect(skuRows(page)).toHaveCount(2);

    const black = skuRows(page).filter({ hasText: codes.blackTee });
    await expect(black).toContainText(`Tee ${tag}`);
    await expect(black).toContainText('M, Black');
    await expect(black).toContainText(`TEE${tag}`);
    await expect(black).toContainText(`Spring ${tag}`);
    await expect(black).toContainText('Main');
    await expect(black).toContainText('25.00');
    await expect(black).toContainText('Active');

    // The column headers (table) or labels (cards) the spec names.
    // On a phone the SKU column is the card's title line and carries no label of its own.
    const phone = (page.viewportSize()?.width ?? 1280) < 640;
    const headers = ['Name', 'Style', 'Season', 'Group', 'Selling price', 'Status'];
    for (const header of phone ? headers : ['SKU', ...headers]) {
      await expect(
        phone
          ? black.getByText(header, { exact: true }).first()
          : page.getByRole('columnheader', { name: header, exact: true }),
      ).toBeVisible();
    }
  });

  test('two words match in any order and uppercase, and a hyphenated code fragment works', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await search(page, `black tee ${low}`);
    await expect(skuRows(page)).toHaveCount(1);
    await expect(skuRows(page)).toContainText(codes.blackTee);
    await search(page, `${tag} TEE BLACK`);
    await expect(skuRows(page)).toHaveCount(1);
    await search(page, `${low}-blk`);
    await expect(skuRows(page)).toHaveCount(1);
    await expect(skuRows(page)).toContainText(codes.blackTee);
  });

  test('an Arabic name typed without hamza finds the variant; a style with no season says No season', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await search(page, `اسود ${tag}`);
    await expect(skuRows(page)).toHaveCount(2); // the Arabic style, and the Black tee (color أسود)
    const qamis = skuRows(page).filter({ hasText: codes.qamis });
    await expect(qamis).toContainText('No season');
    await expect(qamis).toContainText(`Group ${tag}`);
    await expect(skuRows(page).filter({ hasText: codes.blackTee })).toContainText(`Spring ${tag}`);
  });

  test('the barcode finds exactly one variant, in Western or Arabic Indic digits, and the SKU page shows it', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await search(page, barcodeA);
    await expect(skuRows(page)).toHaveCount(1);
    await expect(skuRows(page)).toContainText(codes.blackTee);
    await search(page, toArabicDigits(barcodeA));
    await expect(skuRows(page)).toHaveCount(1);
    await expect(skuRows(page)).toContainText(codes.blackTee);

    await skuRows(page).getByRole('link', { name: codes.blackTee }).click();
    await expect(page).toHaveURL(new RegExp(`/skus/${ids.blackTee}$`));
    await expect(page.getByRole('heading', { level: 1, name: codes.blackTee })).toBeVisible();
    const block = page.getByRole('region', { name: 'About this SKU' });
    await expect(block).toContainText(`TEE${tag}`);
    await expect(block).toContainText(`Tee ${tag}`);
    await expect(block).toContainText(`Spring ${tag}`);
    await expect(block).toContainText('Group');
    await expect(block).toContainText('Size: M, Color: Black');
    await expect(block.getByText(barcodeA)).toBeVisible();
    await expect(block.getByText(barcodeB)).toHaveCount(0);
  });

  test('a SKU page with no season and no barcode says so', async ({ page }) => {
    await openShell(page, `/skus/${ids.qamis}`);
    const block = page.getByRole('region', { name: 'About this SKU' });
    await expect(block).toContainText('No season');
    await expect(block).toContainText('No barcodes');
    await expect(block).toContainText('No options');
  });

  test('season, No season, and group filters narrow the rows and combine', async ({ page }) => {
    await openShell(page, '/skus');
    // The options come from loaded rows, so load both styles first.
    await search(page, tag.toLowerCase());
    await expect(skuRows(page)).toHaveCount(3);

    await page.getByLabel('Season', { exact: true }).selectOption({ label: `Spring ${tag}` });
    await expect(skuRows(page)).toHaveCount(2);
    await expect(skuRows(page).filter({ hasText: codes.qamis })).toHaveCount(0);

    await page.getByLabel('Season', { exact: true }).selectOption({ label: 'No season' });
    await expect(skuRows(page)).toHaveCount(1);
    await expect(skuRows(page)).toContainText(codes.qamis);

    await page.getByLabel('Season', { exact: true }).selectOption({ label: 'All seasons' });
    await expect(skuRows(page)).toHaveCount(3);
    await page.getByLabel('Group', { exact: true }).selectOption({ label: `Group ${tag}` });
    await expect(skuRows(page)).toHaveCount(1);
    await expect(skuRows(page)).toContainText(codes.qamis);

    // Group and season together can match nothing: the empty state says so.
    await page.getByLabel('Season', { exact: true }).selectOption({ label: `Spring ${tag}` });
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
  });

  test('edge input: a wildcard, a lone short letter, and padded spaces never break the list', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await search(page, '%');
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
    await search(page, '_');
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
    await search(page, 'zz');
    await expect(page.getByText('No SKU matches this search.')).toBeVisible();
    await search(page, `   ${low}-blk   `);
    await expect(skuRows(page)).toHaveCount(1);
    // A 100 character query is accepted; 101 characters are cut or refused without a crash.
    await page.getByLabel('Name, SKU or barcode').fill('q'.repeat(150));
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('axe finds no violation on the list with the filters, and on the SKU page', async ({
    page,
  }) => {
    await openShell(page, '/skus');
    await search(page, tag.toLowerCase());
    await expect(skuRows(page)).toHaveCount(3);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);
    await openShell(page, `/skus/${ids.blackTee}`);
    await expect(page.getByRole('region', { name: 'About this SKU' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });

  test('the filters and the search are reachable by keyboard alone', async ({ page }) => {
    await openShell(page, '/skus');
    await page.getByLabel('Name, SKU or barcode').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Season', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Group', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Active' })).toBeFocused();
  });
});

test.describe('SKU list search in Arabic (AC-3, AC-4, AC-18)', () => {
  test('right to left with Arabic labels, Arabic names, codes left to right, and Arabic digit barcode', async ({
    page,
  }) => {
    await useBrowserState(page, { language: 'ar' });
    await openShell(page, '/skus');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { level: 1, name: textFor('rtl', 'inventory.skus.title') }),
    ).toBeVisible();
    const label = textFor('rtl', 'inventory.skus.search');
    const rows = skuRows(page, textFor('rtl', 'inventory.skus.tableLabel'));

    await search(page, `${low} قميص`, label);
    await expect(rows).toHaveCount(1);
    const qamis = rows.filter({ hasText: codes.qamis });
    await expect(qamis).toContainText(`قميص أسود ${tag}`);
    await expect(qamis).toContainText(textFor('rtl', 'inventory.skus.noSeason'));
    await expect(qamis).toContainText(`مجموعة ${tag}`);
    // Codes keep their own direction inside right to left text.
    await expect(qamis.locator('bdi[dir="ltr"]').first()).toBeVisible();

    await search(page, `${tag} ابيض`, label);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(codes.whiteTee);
    await expect(rows).toContainText('أبيض');
    await expect(rows).toContainText(`ربيع ${tag}`);

    await search(page, toArabicDigits(barcodeB), label);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(codes.whiteTee);
    await expect(rows).not.toContainText(/[٠-٩]/);
  });

  test('the SKU page style block is Arabic and right to left, and axe passes on both pages', async ({
    page,
  }) => {
    await useBrowserState(page, { language: 'ar' });
    await openShell(page, `/skus/${ids.qamis}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const block = page.getByRole('region', {
      name: textFor('rtl', 'inventory.skuDetail.aboutTitle'),
    });
    await expect(block).toContainText(textFor('rtl', 'inventory.skus.noSeason'));
    await expect(block).toContainText(textFor('rtl', 'inventory.skuDetail.noBarcodes'));
    await expect(block).toContainText(`قميص أسود ${tag}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoAxeViolations(page);

    await openShell(page, '/skus');
    await search(page, tag.toLowerCase(), textFor('rtl', 'inventory.skus.search'));
    await expect(skuRows(page, textFor('rtl', 'inventory.skus.tableLabel'))).toHaveCount(3);
    await expectNoAxeViolations(page);
  });

  test('the filters carry Arabic labels', async ({ page }) => {
    await useBrowserState(page, { language: 'ar' });
    await openShell(page, '/skus');
    await expect(
      page.getByLabel(textFor('rtl', 'inventory.skus.seasonFilter'), { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel(textFor('rtl', 'inventory.skus.groupFilter'), { exact: true }),
    ).toBeVisible();
  });
});
