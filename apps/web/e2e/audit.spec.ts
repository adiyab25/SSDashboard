import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AUDIT_EXPORT_COLUMNS, type AuditEntryView } from '@ssdashboard/contracts';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { api, createLocation, createSku, findRow, receive, voidReceipt } from './master-data-api';
import { expectNoAxeViolations, textFor, useBrowserState, type TextDirection } from './support';

// Spec 0010 milestones 1 and 3: the /audit page (AC-12, AC-13, AC-15, AC-18). A manager voids a
// stock receipt with a reason and finds the entry on the page, in English and Arabic; each filter
// works alone and combined and lives in the URL; the detail shows the field diff (a personal field
// as hidden) and the record history; Load more and the detail work by keyboard alone; the export
// downloads a CSV; a person without `audit.read` (spec 0008) gets the no access state; the page
// passes axe (WCAG 2.2 AA).
const LANGUAGES = [
  { dir: 'ltr', name: 'English' },
  { dir: 'rtl', name: 'Arabic' },
] as const satisfies readonly { dir: TextDirection; name: string }[];

/** Waits for the page to leave its loading state. */
async function openAudit(page: Page, dir: TextDirection) {
  await page.goto('/audit');
  await expect(
    page.getByRole('heading', { level: 1, name: textFor(dir, 'audit.title') }),
  ).toBeVisible();
}

/** A stock receipt received and voided with `reason`, voided by `voider` when given. */
async function voidedReceipt(
  request: APIRequestContext,
  tag: string,
  reason: string,
  voider: APIRequestContext = request,
) {
  const location = await createLocation(request, `AU-${tag}`);
  const sku = await createSku(request, `AUD-${tag}`);
  const receipt = await receive(request, location.id, sku.id, 3);
  await voidReceipt(voider, receipt.id, reason);
  const { body } = await api(
    request,
    'GET',
    `/audit/entries?recordType=stock_receipt&recordId=${receipt.id}`,
  );
  const entry = (body.items as AuditEntryView[])[0];
  if (!entry) throw new Error('The void left no audit entry');
  return { receipt, entry };
}

/** The day after an ISO day, as an ISO day. */
function dayAfter(day: string): string {
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
}

/** The data rows of the list (the ones with a Details button). */
const dataRows = (page: Page) =>
  page
    .getByRole('table', { name: 'Audit entries' })
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: /^Details of/ }) });

/** Fills the filter bar's fields (English labels) and applies. */
async function applyFilters(
  page: Page,
  fields: Partial<{
    person: string;
    recordType: string;
    recordId: string;
    action: string;
    dayFrom: string;
    dayTo: string;
    correlationId: string;
  }>,
) {
  const label = (text: string) => page.getByLabel(text, { exact: true });
  if (fields.person) await label('Person').selectOption({ label: fields.person });
  if (fields.recordType) await label('Record type').selectOption({ label: fields.recordType });
  if (fields.recordId) await label('Record ID').fill(fields.recordId);
  if (fields.action) await label('Action').selectOption({ label: fields.action });
  if (fields.dayFrom) await label('From day').fill(fields.dayFrom);
  if (fields.dayTo) await label('To day').fill(fields.dayTo);
  if (fields.correlationId) await label('Same action ID').fill(fields.correlationId);
  await page.getByRole('button', { name: 'Apply filters' }).click();
}

test.describe('as a manager', () => {
  for (const { dir, name } of LANGUAGES) {
    test(`shows a voided receipt with its reason in ${name} (AC-12, AC-18)`, async ({
      page,
      request,
    }) => {
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const reason = `Entered twice ${tag}`;
      const location = await createLocation(request, `AU-${tag}`);
      const sku = await createSku(request, `AUD-${tag}`);
      const receipt = await receive(request, location.id, sku.id, 3);
      await voidReceipt(request, receipt.id, reason);

      await useBrowserState(page, { dir });
      await openAudit(page, dir);

      const row = await findRow(
        page,
        textFor(dir, 'audit.tableLabel'),
        new RegExp(receipt.number),
        textFor(dir, 'audit.loadMore'),
      );
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(reason);
      await expect(row).toContainText(textFor(dir, 'audit.actions.stockReceiptVoided'));
      await expect(row).toContainText(textFor(dir, 'audit.recordTypes.stockReceipt'));
      await expect(row).toContainText('E2E Admin');
      await expect(page.locator('h1')).toHaveCount(1);
    });

    test(`has no axe violations in ${name}`, async ({ page, viewport }) => {
      test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the accessibility sweep');
      await useBrowserState(page, { dir });
      await openAudit(page, dir);
      await expect(
        page.getByRole('table', { name: textFor(dir, 'audit.tableLabel') }),
      ).not.toHaveAttribute('aria-busy', 'true');
      await expectNoAxeViolations(page);
    });

    test(`the filtered list, the detail, and the history are axe clean in ${name}`, async ({
      page,
      request,
      viewport,
    }) => {
      test.skip((viewport?.width ?? 0) < 1000, 'one viewport runs the accessibility sweep');
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const mine = await voidedReceipt(request, tag, `Sweep ${tag}`);
      await useBrowserState(page, { dir });
      await page.goto(`/audit?recordType=stock_receipt&recordId=${mine.receipt.id}`);
      const table = page.getByRole('table', { name: textFor(dir, 'audit.tableLabel') });
      await expect(table.getByRole('row', { name: new RegExp(mine.receipt.number) })).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expectNoAxeViolations(page);

      await page.getByRole('button', { name: new RegExp(mine.receipt.number) }).click();
      const dialog = page.getByRole('dialog', {
        name: textFor(dir, 'audit.actions.stockReceiptVoided'),
      });
      await expect(
        dialog.getByRole('table', { name: textFor(dir, 'audit.detail.tableLabel') }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: textFor(dir, 'audit.detail.showHistory') }).click();
      await expect(
        dialog
          .getByRole('table', { name: textFor(dir, 'audit.history.title') })
          .getByRole('row', { name: new RegExp(`Sweep ${tag}`) }),
      ).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expectNoAxeViolations(page);
    });
  }

  test('each filter alone and combined, with the filter in the URL (AC-12)', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const other: SeededAccount = await seedAccount({ hats: ['manager'] });
    const context = await browser.newContext({ baseURL });
    try {
      await signInThroughApi(context, other, baseURL ?? '');
      const mine = await voidedReceipt(request, `${tag}1`, `Mine ${tag}`);
      const theirs = await voidedReceipt(request, `${tag}2`, `Theirs ${tag}`, context.request);
      const day = mine.entry.operatingDay;
      const row = (receiptNumber: string) => dataRows(page).filter({ hasText: receiptNumber });
      const clear = () => page.getByRole('button', { name: 'Clear filters' }).click();

      await page.goto('/audit');
      await expect(page.getByRole('heading', { level: 1, name: 'Audit trail' })).toBeVisible();
      // The staff list fills the person select once it has answered.
      await expect(
        page.getByLabel('Person', { exact: true }).getByRole('option', { name: other.name }),
      ).toHaveCount(1);

      // Person alone.
      await applyFilters(page, { person: other.name });
      await expect(page).toHaveURL(new RegExp(`actorUserId=${other.id}`));
      await expect(row(theirs.receipt.number)).toHaveCount(1);
      await expect(row(mine.receipt.number)).toHaveCount(0);
      await clear();
      await expect(page).toHaveURL(/\/audit$/);

      // Record type and record ID.
      await applyFilters(page, { recordType: 'Stock receipt', recordId: mine.receipt.id });
      await expect(dataRows(page)).toHaveCount(1);
      await expect(row(mine.receipt.number)).toHaveCount(1);
      await clear();

      // Action alone: both receipts are on the list (newest first, so on page one).
      await applyFilters(page, { action: 'Stock receipt voided' });
      await expect(row(mine.receipt.number)).toHaveCount(1);
      await expect(row(theirs.receipt.number)).toHaveCount(1);
      await clear();

      // Day range: later days drop the entries, their own day keeps them.
      await applyFilters(page, { dayFrom: dayAfter(day), dayTo: dayAfter(dayAfter(day)) });
      await expect(page.getByText('No entries match')).toBeVisible();
      await clear();
      await applyFilters(page, {
        dayFrom: day,
        dayTo: day,
        recordType: 'Stock receipt',
        recordId: mine.receipt.id,
      });
      await expect(row(mine.receipt.number)).toHaveCount(1);
      await clear();

      // The ID of one action alone.
      await applyFilters(page, { correlationId: mine.entry.correlationId });
      await expect(dataRows(page)).toHaveCount(1);
      await expect(row(mine.receipt.number)).toHaveCount(1);
      await clear();

      // Combined: their person with my record shows nothing; with their record shows it.
      await applyFilters(page, {
        person: other.name,
        recordType: 'Stock receipt',
        recordId: mine.receipt.id,
      });
      await expect(page.getByText('No entries match')).toBeVisible();
      await page.getByLabel('Record ID', { exact: true }).fill(theirs.receipt.id);
      await page.getByRole('button', { name: 'Apply filters' }).click();
      await expect(row(theirs.receipt.number)).toHaveCount(1);

      // A link reproduces the view: a fresh load of this URL shows the same filters and rows.
      await page.goto(page.url());
      await expect(page.getByLabel('Record ID', { exact: true })).toHaveValue(theirs.receipt.id);
      await expect(row(theirs.receipt.number)).toHaveCount(1);

      // A record ID without a type is refused beside the form, and nothing is applied.
      await clear();
      await page.getByLabel('Record ID', { exact: true }).fill(theirs.receipt.id);
      await page.getByRole('button', { name: 'Apply filters' }).click();
      await expect(page.getByLabel('Record type', { exact: true })).toHaveAccessibleDescription(
        'Choose a record type to filter by record ID.',
      );
    } finally {
      await context.close();
      await other.remove().catch(() => undefined);
    }
  });

  test('the detail shows the field diff, the same action link, and the record history (AC-12, AC-13)', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const mine = await voidedReceipt(request, tag, `Detail ${tag}`);
    await page.goto(`/audit?recordType=stock_receipt&recordId=${mine.receipt.id}`);

    await page
      .getByRole('button', { name: new RegExp(`^Details of .*${mine.receipt.number}`) })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Stock receipt voided' });
    const diff = dialog.getByRole('table', { name: 'Changed fields' });
    await expect(diff).toBeVisible();
    await expect(diff.getByRole('columnheader', { name: 'Before' })).toBeVisible();
    await expect(diff.getByRole('columnheader', { name: 'After' })).toBeVisible();
    expect(await diff.getByRole('rowheader').count()).toBeGreaterThan(0);
    await expect(dialog).toContainText(`Detail ${tag}`);

    // The history panel inside the detail.
    await dialog.getByRole('button', { name: 'Show the history of this record' }).click();
    const history = dialog.getByRole('table', { name: 'History of this record' });
    await expect(history.getByRole('row', { name: new RegExp(`Detail ${tag}`) })).toBeVisible();

    // The same action link filters by correlation id.
    await dialog.getByRole('link', { name: 'Show entries of the same action' }).click();
    await expect(page).toHaveURL(new RegExp(`correlationId=${mine.entry.correlationId}`));
    await expect(dataRows(page)).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a personal field is shown as hidden, never its marker (AC-12)', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const mine = await voidedReceipt(request, tag, `Personal ${tag}`);
    await page.route(`**/api/audit/entries/${mine.entry.id}`, (route) =>
      route.fulfill({
        json: {
          ...mine.entry,
          changes: [
            { field: 'status', before: 'posted', after: 'voided', personal: false },
            { field: 'phone', before: '[REDACTED]', after: '[REDACTED]', personal: true },
          ],
        },
      }),
    );
    await page.goto(`/audit?recordType=stock_receipt&recordId=${mine.receipt.id}`);
    await page.getByRole('button', { name: /^Details of/ }).click();
    const diff = page.getByRole('dialog').getByRole('table', { name: 'Changed fields' });
    await expect(diff.getByRole('row', { name: /phone/ })).toContainText('Hidden, personal data');
    await expect(diff.getByText('[REDACTED]')).toHaveCount(0);
    await expect(diff.getByRole('row', { name: /status/ })).toContainText('voided');
  });

  test('Load more works by keyboard alone and keeps focus (AC-18)', async ({ page }) => {
    const entryOf = (n: number): AuditEntryView => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      recordedAt: `2026-11-0${n}T10:00:00.000000Z`,
      operatingDay: `2026-11-0${n}`,
      correlationId: `00000000-0000-4000-8000-0000000009${n}0`,
      actor: { kind: 'system_job', userId: null, ref: 'nightly', hat: null, jobId: null },
      actorName: null,
      action: 'stock_receipt.voided',
      record: {
        type: 'stock_receipt',
        id: `00000000-0000-4000-8000-0000000007${n}0`,
        label: `SR-2026-00000${n}`,
      },
      before: null,
      after: null,
      personalFields: [],
      reason: `Stubbed ${n}`,
      undone: false,
      canUndo: false,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/audit/entries?*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (cursor) await gate;
      await route.fulfill({
        json: cursor
          ? { items: [entryOf(2)], nextCursor: null }
          : { items: [entryOf(3)], nextCursor: 'next-page' },
      });
    });
    await page.goto('/audit');
    const more = page.getByRole('button', { name: 'Load more' });
    await expect(more).toBeVisible();
    await expect(page.getByText('Stubbed 3')).toBeVisible();

    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-disabled', 'true');
    await expect(more).toBeFocused();
    release();
    await expect(page.getByText('Stubbed 2')).toBeVisible();
    await expect(page.getByText('End of the audit trail')).toBeFocused();
    await expect(more).toHaveCount(0);
  });

  test('operates by keyboard alone: filter, open the detail, close it, focus returns (AC-18)', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const mine = await voidedReceipt(request, tag, `Keys ${tag}`);
    await page.goto('/audit');
    await expect(page.getByLabel('Record type', { exact: true })).toBeVisible();

    await page.getByLabel('Record type', { exact: true }).focus();
    await page.keyboard.type('Stock');
    await page.keyboard.press('Tab');
    await page.keyboard.type(mine.receipt.id);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`recordId=${mine.receipt.id}`));
    const details = page.getByRole('button', {
      name: new RegExp(`^Details of .*${mine.receipt.number}`),
    });
    await expect(details).toBeVisible();

    await details.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Stock receipt voided' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(details).toBeFocused();
  });

  test('a filter problem shows under its field and focus moves to it, by keyboard (AC-18)', async ({
    page,
  }) => {
    await page.goto('/audit');
    const recordId = page.getByLabel('Record ID', { exact: true });
    await expect(recordId).toBeVisible();
    await recordId.focus();
    await page.keyboard.type('00000000-0000-4000-8000-000000000001');
    await page.keyboard.press('Enter');

    const type = page.getByLabel('Record type', { exact: true });
    await expect(type).toBeFocused();
    await expect(type).toHaveAttribute('aria-invalid', 'true');
    await expect(type).toHaveAccessibleDescription('Choose a record type to filter by record ID.');
    await expect(page).toHaveURL(/\/audit$/);

    // Choosing a type clears the problem and Enter applies the filter.
    await page.keyboard.type('Stock');
    await expect(type).not.toHaveAttribute('aria-invalid', 'true');
    await recordId.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/recordType=stock_receipt&recordId=/);
  });

  test('a reversed day range explains itself beside the disabled export (AC-15)', async ({
    page,
  }) => {
    await page.goto('/audit?dayFrom=2026-02-01&dayTo=2026-01-01');
    await expect(page.getByText('The first day cannot be after the last day.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  test('exports the filter as a CSV with a byte order mark and the header (AC-15)', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const mine = await voidedReceipt(request, tag, `Export ${tag}`);
    const day = mine.entry.operatingDay;
    await page.goto(
      `/audit?dayFrom=${day}&dayTo=${day}&recordType=stock_receipt&recordId=${mine.receipt.id}`,
    );
    await expect(dataRows(page)).toHaveCount(1);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const bytes = readFileSync(await file.path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString('utf8');
    expect(text.split(/\r?\n/)[0]).toBe(AUDIT_EXPORT_COLUMNS.map((name) => `"${name}"`).join(','));
    expect(text).toContain(mine.receipt.number);
    await expect(page.getByText('The file was downloaded.')).toBeVisible();
  });

  test('the export asks for a day range and shows the limit and server errors (AC-15)', async ({
    page,
  }) => {
    let calls = 0;
    await page.route('**/api/audit/entries/export?*', (route) => {
      calls += 1;
      return route.fulfill({ status: 413, json: { code: 'EXPORT_TOO_LARGE' } });
    });
    await page.goto('/audit');
    await expect(page.getByText('Choose both days to export.')).toBeVisible();
    await expect(page.getByText(/at most 366 days/)).toBeVisible();
    await page.getByRole('button', { name: 'Export CSV' }).click({ force: true });
    expect(calls).toBe(0);

    await page.goto('/audit?dayFrom=2020-01-01&dayTo=2022-01-01');
    await expect(page.getByText('The day range is more than 366 days.')).toBeVisible();
    await page.getByRole('button', { name: 'Export CSV' }).click({ force: true });
    expect(calls).toBe(0);

    await page.goto('/audit?dayFrom=2026-01-01&dayTo=2026-02-01');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'too many entries' })).toBeVisible();

    await page.unroute('**/api/audit/entries/export?*');
    await page.route('**/api/audit/entries/export?*', (route) =>
      route.fulfill({ status: 400, json: { code: 'INVALID_FILTER' } }),
    );
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'cannot be exported' })).toBeVisible();
  });

  test('lists Audit trail in the sidebar', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sidebar is a sheet on a phone');
    await page.goto('/');
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit trail' }),
    ).toBeVisible();
  });
});

test.describe('as a person without audit.read', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let person: SeededAccount | undefined;

  test.beforeEach(async ({ context, baseURL }) => {
    person = await seedAccount();
    await signInThroughApi(context, person, baseURL ?? '');
  });
  test.afterEach(async () => {
    const seeded = person;
    person = undefined;
    await seeded?.remove();
  });

  for (const { dir, name } of LANGUAGES) {
    test(`sees the no audit access message in ${name}, and axe is clean`, async ({
      page,
      viewport,
    }) => {
      await useBrowserState(page, { dir });
      await page.goto('/audit');
      await expect(page.getByText(textFor(dir, 'access.noAccess.title'))).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.locator('h1')).toHaveCount(1);
      if ((viewport?.width ?? 0) >= 1000) await expectNoAxeViolations(page);
    });
  }
});
