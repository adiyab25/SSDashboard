import { expect, test } from '@playwright/test';

// Spec 0003 AC-13 and spec 0004 AC-2: what a production build must and must not contain.
test.describe('production build', () => {
  test('/design answers a real 404', async ({ page }) => {
    const response = await page.goto('/design');

    expect(response?.status()).toBe(404);
  });

  // Spec 0003 AC-18: the frame previews of /design are development only too.
  test('the frame previews answer a real 404', async ({ request }) => {
    for (const path of [
      '/en/returns/preview/brand',
      '/ar/returns/preview/rejected',
      '/en/partner/preview',
    ]) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
    }
  });

  // Spec 0004 AC-17: with several root layouts, an unmatched path still answers a real 404.
  test('an unknown path answers a real 404', async ({ page }) => {
    const response = await page.goto('/no-such-page');

    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  // Spec 0004 AC-2: the cookie is honoured in production, and the old switch is gone.
  test('honours the saved language, with no development direction switch', async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([{ name: 'ss_lang', value: 'ar', url: baseURL ?? '' }]);
    await page.addInitScript(() => localStorage.setItem('ss_dir', 'ltr'));
    await page.goto('/');

    // The saved language is kept when config cannot load. This server needs API_INTERNAL_URL
    // pointing at a running api (the session gate calls it), and the saved sign in cookie is
    // for the dev hostname, so run it on the same hostname as the dev server.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('نظرة عامة');
    await page.getByRole('button', { name: /قائمة المستخدم/ }).click();
    await expect(page.getByRole('menuitem', { name: 'المظهر' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Direction|الاتجاه/ })).toHaveCount(0);
  });

  test('opens left to right in English when nothing is saved', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
  });

  test('never links the development only gallery', async ({ page }) => {
    await page.goto('/');

    // No /design entry. This server has no api proxy, so the role stays unknown and the admin
    // only entries (Staff, Locations) are hidden too; the built pages for everyone remain.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText([
      'Home',
      'Stock on hand',
      'Stock receipts',
      'SKUs',
    ]);
  });

  test('serves its fonts itself, with no request to a font host', async ({ page }) => {
    const hosts = new Set<string>();
    page.on('request', (request) => hosts.add(new URL(request.url()).host));

    // Wait for the fonts, not for network idle. This server needs API_INTERNAL_URL pointing at
    // a running api (the session gate), as the first test says.
    await page.goto('/');
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => face.family);
    });

    expect([...hosts].filter((host) => /fonts\.(googleapis|gstatic)\.com/.test(host))).toEqual([]);
    expect(fonts.some((family) => /Inter/.test(family))).toBe(true);
  });
});
