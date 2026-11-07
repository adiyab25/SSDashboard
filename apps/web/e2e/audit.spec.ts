import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { seedAccount, signInThroughApi, type SeededAccount } from './accounts';
import { createLocation, createSku, findRow, receive, voidReceipt } from './master-data-api';
import { expectNoAxeViolations, textFor, useBrowserState, type TextDirection } from './support';

// Spec 0010 milestone 1: the /audit page (AC-12, AC-18). A manager voids a stock receipt with a
// reason and finds the entry on the page, in English and Arabic; a person without `audit.read`
// (spec 0008) gets the no access state; the page passes axe (WCAG 2.2 AA).
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
  }

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
