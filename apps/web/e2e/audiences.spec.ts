import { expect, test } from '@playwright/test';
import {
  ownAddress,
  seedAccount,
  seedPartnerAccount,
  seedPartnerLogin,
  signInThroughApi,
} from './accounts';
import { STORAGE_STATE } from './auth';
import { openPartnerLogins } from './support';

// Spec 0007 section 2: the public portal and the partner seam are not the staff back office.
// An anonymous visitor must stay on the page and never reach a staff api route, because a 401
// there sends the browser to the staff sign in.
test.use({ storageState: { cookies: [], origins: [] } });

for (const [path, title] of [
  ['/en/returns', 'Exchanges and returns'],
  ['/en/partner', 'Partner showroom'],
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
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    // Give a stray staff call time to fire and redirect before asserting.
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe(path);
    expect(apiCalls.filter((call) => call !== '/api/config')).toEqual([]);
  });
}

// Spec 0008 AC-15 and AC-28: staff and partner logins are different audiences. The Partner logins
// tab lists the partner person and not the staff person; the partner person themselves is refused
// at the people routes.
test.describe('the people screen', () => {
  test.use({ storageState: STORAGE_STATE });

  test('lists a partner login on the Partner logins tab only, and refuses the partner at /api/partner-users', async ({
    page,
    browser,
    baseURL,
  }) => {
    const partner = await seedPartnerAccount();
    const login = await seedPartnerLogin(partner.id);
    const staff = await seedAccount();
    try {
      await page.context().setExtraHTTPHeaders(ownAddress());
      await openPartnerLogins(page);
      const search = page.getByRole('searchbox', { name: 'Search partner logins' });
      await search.fill(login.email);
      await expect(page.getByRole('row', { name: new RegExp(login.name) })).toContainText(
        partner.name,
      );
      await search.fill(staff.email);
      await expect(page.getByText(/No partner logins match/)).toBeVisible();

      const own = await browser.newContext({ baseURL, extraHTTPHeaders: ownAddress() });
      try {
        await signInThroughApi(own, login, baseURL ?? '');
        const refused = await own.request.get('/api/partner-users');
        expect(refused.status()).toBe(403);
        expect(await refused.json()).toMatchObject({ code: 'WRONG_AUDIENCE' });
      } finally {
        await own.close();
      }
    } finally {
      await login.remove();
      await staff.remove();
      await partner.remove();
    }
  });
});
