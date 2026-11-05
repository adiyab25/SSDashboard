import { expect, test } from '@playwright/test';

// Spec 0007 section 2: the public portal and the partner seam are not the staff back office.
// An anonymous visitor must stay on the page and never reach a staff api route, because a 401
// there sends the browser to the staff sign in.
test.use({ storageState: { cookies: [], origins: [] } });

for (const [path, title] of [
  ['/returns', 'Exchanges and returns'],
  ['/partner', 'Partner showroom'],
] as const) {
  test(`anonymous ${path} stays put and calls only /api/config`, async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/')) apiCalls.push(pathname);
    });

    await page.goto(path);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.locator('main#main-content')).toHaveCount(1);
    // Give a stray staff call time to fire and redirect before asserting.
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe(path);
    expect(apiCalls.filter((call) => call !== '/api/config')).toEqual([]);
  });
}
