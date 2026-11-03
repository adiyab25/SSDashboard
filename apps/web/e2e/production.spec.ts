import { expect, test } from '@playwright/test';

// Spec 0003, AC-11 and AC-13: what a production build must and must not contain.
test.describe('production build', () => {
  test('/design answers a real 404', async ({ page }) => {
    const response = await page.goto('/design');

    expect(response?.status()).toBe(404);
  });

  test('has no direction switch and is always left to right', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ss_dir', 'rtl'));
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByRole('button', { name: /User menu/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Direction' })).toHaveCount(0);
  });

  test('never links the development only gallery', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText([
      'Home',
    ]);
  });

  test('serves its fonts itself, with no request to a font host', async ({ page }) => {
    const hosts = new Set<string>();
    page.on('request', (request) => hosts.add(new URL(request.url()).host));

    // No api runs behind this server, so wait for the fonts, not for network idle.
    await page.goto('/');
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => face.family);
    });

    expect([...hosts].filter((host) => /fonts\.(googleapis|gstatic)\.com/.test(host))).toEqual([]);
    expect(fonts.some((family) => /IBM Plex Sans/.test(family))).toBe(true);
  });
});
