import { expect, test, type Page } from '@playwright/test';

/** The value shown next to a label in the status list (dt → dd). */
const valueOf = (page: Page, label: string) =>
  page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

test.describe('home page', () => {
  test('shows the api, database, and version loaded through /api', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'SSDashboard' })).toBeVisible();
    await expect(valueOf(page, 'API')).toHaveText('ok');
    await expect(valueOf(page, 'Database')).toHaveText('up');
    await expect(valueOf(page, 'Version')).not.toBeEmpty();
  });

  test('titles the document and declares English, left to right', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle('SSDashboard');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('still renders and marks the api unreachable when it cannot be reached', async ({
    page,
  }) => {
    await page.route('**/api/health', (route) => route.abort('connectionrefused'));

    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'SSDashboard' })).toBeVisible();
    await expect(valueOf(page, 'API')).toHaveText(/^unreachable \(/);
    await expect(page.locator('dt', { hasText: 'Database' })).toHaveCount(0);
  });

  test('shows the status code when the api answers with an error', async ({ page }) => {
    await page.route('**/api/health', (route) =>
      route.fulfill({ status: 502, body: 'Bad Gateway' }),
    );

    await page.goto('/');

    await expect(valueOf(page, 'API')).toHaveText('unreachable (api answered 502)');
  });

  test('shows degraded when the api reports the database down', async ({ page }) => {
    await page.route('**/api/health', (route) =>
      route.fulfill({ json: { status: 'degraded', version: '0.1.0', database: 'down' } }),
    );

    await page.goto('/');

    await expect(valueOf(page, 'API')).toHaveText('degraded');
    await expect(valueOf(page, 'Database')).toHaveText('down');
  });
});
